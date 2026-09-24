package com.dshmobile.spike

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject

/**
 * The SAF-tree half of the filesystem primitives (contract v1.1.0): every
 * leg a user-granted scope serves, resolved through DocumentsContract child
 * display names inside a tree URI. Split from `FsPrimitives` so the Kotlin
 * file stays inside the shape budget — the app-scope legs live there, the
 * tree legs here, one scope registry shared by both. Paths are
 * POSIX-relative; directories are `MIME_TYPE_DIR`; listings are byte-order
 * sorted by name (contract §4).
 */
class TreeScopeFs(private val context: Context) {

    companion object {
        private val DIRECTORY_MIME = DocumentsContract.Document.MIME_TYPE_DIR

        private fun io(primitive: String, message: String) =
            GatewayCore.GatewayError("io", primitive, message)

        private fun mimeFor(name: String): String = when {
            name.endsWith(".txt") -> "text/plain"
            name.endsWith(".html") -> "text/html"
            name.endsWith(".js") -> "text/javascript"
            name.endsWith(".json") -> "application/json"
            else -> "application/octet-stream"
        }
    }

    private fun resolver() = context.contentResolver

    /** Resolves a POSIX-relative path inside a tree by display name. */
    fun resolveInTree(tree: Uri, rel: String): Uri? {
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        var docUri = DocumentsContract.buildDocumentUriUsingTree(tree, rootId)
        for (component in rel.split('/').filter { it.isNotEmpty() }) {
            val child = childByName(docUri, component) ?: return null
            docUri = child
        }
        return docUri
    }

    private fun childByName(parentDocUri: Uri, name: String): Uri? {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
            parentDocUri, DocumentsContract.getDocumentId(parentDocUri),
        )
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        )
        val docId = queryChild(resolver().query(childrenUri, projection, null, null, null), name)
            ?: return null
        return DocumentsContract.buildDocumentUriUsingTree(parentDocUri, docId)
    }

    private fun queryChild(cursor: android.database.Cursor?, name: String): String? {
        cursor?.use {
            while (it.moveToNext()) {
                if (it.getString(1) == name) return it.getString(0)
            }
        }
        return null
    }

    fun readTreeFile(tree: Uri, rel: String): ByteArray? {
        val docUri = resolveInTree(tree, rel) ?: return null
        return try {
            resolver().openInputStream(docUri)?.use { it.readBytes() }
        } catch (_: Exception) {
            null
        }
    }

    fun writeTreeFile(
        tree: Uri,
        rel: String,
        bytes: ByteArray,
        append: Boolean,
        create: Boolean,
    ) {
        val parent = parentDir(tree, rel)
        val name = rel.split('/').filter { it.isNotEmpty() }.last()
        val existing = childByName(parent, name)
        val docUri = when {
            existing != null -> existing
            !create -> throw io("fsWrite", "$rel does not exist")
            else -> DocumentsContract.createDocument(
                resolver(), parent, mimeFor(name), name,
            ) ?: throw io("fsWrite", "cannot create $name")
        }
        val mode = if (append) "wa" else "w"
        resolver().openOutputStream(docUri, mode)?.use { it.write(bytes) }
            ?: throw io("fsWrite", "cannot open $rel for write")
    }

    /** `{kind, size, mtime}` — the contract's stat shape over a tree doc. */
    fun stat(docUri: Uri, rel: String): JSONObject {
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        resolver().query(docUri, projection, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val mime = cursor.getString(0) ?: ""
                val kind = when {
                    mime == DIRECTORY_MIME -> "dir"
                    mime.isEmpty() -> "other"
                    else -> "file"
                }
                val mtime = cursor.getLong(2)
                return JSONObject()
                    .put("kind", kind)
                    .put("size", cursor.getLong(1))
                    .put("mtime", if (mtime > 0) java.time.Instant.ofEpochMilli(mtime).toString() else "")
            }
        }
        throw io("fsStat", "cannot stat $rel")
    }

    /** One-level children: name + kind, byte-order sorted (deterministic). */
    fun list(dirUri: Uri): JSONObject {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
            dirUri, DocumentsContract.getDocumentId(dirUri),
        )
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        val rows = ArrayList<Pair<String, String>>()
        resolver().query(childrenUri, projection, null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) rows.add(cursor.getString(0) to (cursor.getString(1) ?: ""))
        }
        val entries = JSONArray()
        rows.sortedWith { (a, _), (b, _) ->
            java.util.Arrays.compare(
                a.toByteArray(Charsets.UTF_8),
                b.toByteArray(Charsets.UTF_8),
            )
        }.forEach { (name, mime) ->
            val kind = when {
                mime == DIRECTORY_MIME -> "dir"
                mime.isEmpty() -> "other"
                else -> "file"
            }
            entries.put(JSONObject().put("name", name).put("kind", kind))
        }
        return JSONObject().put("entries", entries)
    }

    /** Recursive mkdir through the tree: walks/creates each component. */
    fun mkdir(tree: Uri, rel: String, existing: String) {
        var parent = rootDoc(tree)
        for (dir in rel.split('/').filter { it.isNotEmpty() }) {
            parent = childByName(parent, dir)
                ?: DocumentsContract.createDocument(
                    resolver(), parent, DIRECTORY_MIME, dir,
                ) ?: throw io("fsMkdir", "cannot create $dir")
        }
        if (existing == "error") throw io("fsMkdir", "$rel exists")
    }

    /** Removes the resolved document; a dir doc deletes its subtree. Absence
     * is a value unless `missing:"error"`. */
    fun remove(tree: Uri, rel: String, missing: String) {
        val docUri = resolveInTree(tree, rel)
        if (docUri == null) {
            if (missing == "error") throw io("fsRemove", "$rel is absent")
            return
        }
        if (!DocumentsContract.deleteDocument(resolver(), docUri)) {
            throw io("fsRemove", "cannot remove $rel")
        }
    }

    /** POSIX rename semantics over the tree: an existing destination is
     * replaced (the atomic-write dependency). */
    fun rename(tree: Uri, relFrom: String, relTo: String) {
        val source = resolveInTree(tree, relFrom) ?: throw io("fsRename", "$relFrom is absent")
        val parent = parentDir(tree, relTo)
        val name = relTo.split('/').filter { it.isNotEmpty() }.last()
        childByName(parent, name)?.let { existing ->
            if (!DocumentsContract.deleteDocument(resolver(), existing)) {
                throw io("fsRename", "cannot replace $name")
            }
        }
        DocumentsContract.renameDocument(resolver(), source, name)
            ?: throw io("fsRename", "cannot rename $relFrom")
    }

    // ---- plumbing -------------------------------------------------------------

    /** Walks (creating as needed) the directory components of `rel` and
     * returns its parent document URI. */
    private fun parentDir(tree: Uri, rel: String): Uri {
        var parent = rootDoc(tree)
        for (dir in rel.split('/').filter { it.isNotEmpty() }.dropLast(1)) {
            parent = childByName(parent, dir)
                ?: DocumentsContract.createDocument(
                    resolver(), parent, DIRECTORY_MIME, dir,
                ) ?: throw io("fsWrite", "cannot create directory $dir")
        }
        return parent
    }

    private fun rootDoc(tree: Uri): Uri = DocumentsContract.buildDocumentUriUsingTree(
        tree, DocumentsContract.getTreeDocumentId(tree),
    )
}
