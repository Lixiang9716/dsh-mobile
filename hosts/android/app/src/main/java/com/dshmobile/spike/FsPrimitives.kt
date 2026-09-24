package com.dshmobile.spike

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * The filesystem primitives (fsRead / fsWrite / fsScope) over a scope
 * registry — Kotlin sibling of hosts/ios Gateway/FSPrimitives.swift. The
 * reserved scope "app" maps to the host's own profile container
 * (data-protocols.md §1): `<filesDir>/profiles/default/`. User-granted
 * scopes are handles "user:<uuid>" bound to SAF tree URIs (from
 * presentPicker or a resolved persisted ref); reads and writes go through
 * DocumentsContract child resolution by display name. fsScope persists the
 * tree URI in `<filesDir>/scope-registry.json` — the Android analogue of
 * security-scoped bookmarks (contract §4), refs "bkm:<uuid>". Paths are
 * POSIX-relative; anything absolute, dotted, or empty is `invalid`; an
 * ungranted/unknown scope `denied`.
 */
class FsPrimitives(private val context: Context) {

    companion object {
        const val MAX_READ_BYTES = 8 * 1024 * 1024
        const val BOOKMARK_PREFIX = "bkm:"

        private fun invalid(primitive: String, message: String) =
            GatewayCore.GatewayError("invalid", primitive, message)

        private fun denied(primitive: String, scope: String) =
            GatewayCore.GatewayError("denied", primitive, "scope not granted: $scope")

        private fun io(primitive: String, message: String) =
            GatewayCore.GatewayError("io", primitive, message)

        /** POSIX-relative, no empty/dot/dot-dot components. */
        fun safeRelative(path: String): String? {
            if (path.isEmpty() || path.startsWith("/")) return null
            val comps = path.split('/').filter { it.isNotEmpty() }
            if (comps.isEmpty() || comps.any { it == ".." || it == "." }) return null
            return comps.joinToString("/")
        }
    }

    private val appRoot: File = File(context.filesDir, "profiles/default").apply { mkdirs() }
    private val registryFile = File(context.filesDir, "scope-registry.json")
    private val userScopes = HashMap<String, Uri>()
    private val lock = Object()
    private val tree = TreeScopeFs(context)

    fun register(on: GatewayCore) {
        on.register("fsRead") { call, done -> read(call, done) }
        on.register("fsWrite") { call, done -> write(call, done) }
        on.register("fsScope.persist") { call, done -> persist(call, done) }
        on.register("fsScope.resolve") { call, done -> resolveRef(call, done) }
        on.register("fsStat") { call, done -> stat(call, done) }
        on.register("fsList") { call, done -> list(call, done) }
        on.register("fsMkdir") { call, done -> mkdir(call, done) }
        on.register("fsRemove") { call, done -> remove(call, done) }
        on.register("fsRename") { call, done -> rename(call, done) }
    }

    /** Binds a fresh user scope handle to a SAF tree URI (picker grants). */
    fun grantUserScope(tree: Uri): String {
        val handle = "user:${UUID.randomUUID()}"
        synchronized(lock) { userScopes[handle] = tree }
        return handle
    }

    // ---- handlers ------------------------------------------------------------

    private fun read(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val (scope, rel) = target(call, "fsRead", done) ?: return
        try {
            if (scope == "app") {
                val file = File(appRoot, rel)
                if (!file.isFile) throw io("fsRead", "cannot read $rel")
                val bytes = file.readBytes()
                if (bytes.size > MAX_READ_BYTES) throw invalid("fsRead", "file too large")
                settleRead(done, bytes, isoMillis(file.lastModified()))
            } else {
                val treeUri = scopeTree(scope) ?: return done.settle(null, denied("fsRead", scope))
                val bytes = tree.readTreeFile(treeUri, rel)
                    ?: throw io("fsRead", "cannot read $rel in tree scope")
                done.settle(
                    JSONObject().put("bytesB64", b64(bytes)).put("mtime", ""),
                    null,
                )
            }
        } catch (e: GatewayCore.GatewayError) {
            done.settle(null, e)
        } catch (e: Exception) {
            done.settle(null, io("fsRead", "${e::class.java.simpleName}: ${e.message}"))
        }
    }

    private fun write(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val (scope, rel) = target(call, "fsWrite", done) ?: return
        val append = call.args.optBoolean("append", false)
        val create = call.args.optBoolean("create", true)
        val bytes = try {
            java.util.Base64.getDecoder().decode(call.args.getString("bytesB64"))
        } catch (_: Exception) {
            return done.settle(null, invalid("fsWrite", "missing/malformed bytesB64"))
        }
        try {
            if (scope == "app") {
                val file = File(appRoot, rel)
                file.parentFile?.mkdirs()
                if (!file.exists() && !create) throw io("fsWrite", "$rel does not exist")
                if (append && file.exists()) {
                    file.appendBytes(bytes)
                } else {
                    file.writeBytes(bytes)
                }
            } else {
                val treeUri = scopeTree(scope) ?: return done.settle(null, denied("fsWrite", scope))
                tree.writeTreeFile(treeUri, rel, bytes, append, create)
            }
            done.settle(JSONObject().put("written", bytes.size), null)
        } catch (e: GatewayCore.GatewayError) {
            done.settle(null, e)
        } catch (e: Exception) {
            done.settle(null, io("fsWrite", "${e::class.java.simpleName}: ${e.message}"))
        }
    }

    /** fsScope.persist — the tree URI survives in the scope registry file. */
    private fun persist(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val scope = call.string("scope")
        if (scope == null || scope == "app") {
            return done.settle(null, invalid("fsScope.persist", "missing or reserved scope"))
        }
        val tree = scopeTree(scope)
            ?: return done.settle(null, denied("fsScope.persist", scope))
        val uuid = UUID.randomUUID().toString()
        synchronized(lock) {
            val reg = readRegistry()
            reg.put(BOOKMARK_PREFIX + uuid, tree.toString())
            writeRegistry(reg)
        }
        done.settle(JSONObject().put("ref", BOOKMARK_PREFIX + uuid), null)
    }

    /** fsScope.resolve — restores a persisted ref into a fresh user handle. */
    private fun resolveRef(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        // Reserved-scope URIs (`scope://app/`) resolve to the scope's root
        // the same way the iOS and CLI hosts answer them — the profile
        // container IS the scope root, and the upstream suite driver (plus
        // the session scenarios' launch-env branch) pins the profile cwd
        // there. A user-granted scope still resolves through its bookmark
        // below.
        val ref = call.string("ref")
        if (ref != null && ref.startsWith("scope://") && ref.endsWith("/")) {
            val name = ref.removePrefix("scope://").removeSuffix("/")
            if (name == "app") {
                return done.settle(
                    JSONObject().put("scope", name).put("path", appRoot.absolutePath),
                    null,
                )
            }
        }
        if (ref == null || !ref.startsWith(BOOKMARK_PREFIX)) {
            return done.settle(null, invalid("fsScope.resolve", "malformed ref"))
        }
        val treeText = synchronized(lock) { readRegistry().optString(ref, "") }
        val tree = if (treeText.isEmpty()) null else Uri.parse(treeText)
        if (tree == null) {
            return done.settle(null, io("fsScope.resolve", "ref no longer resolves"))
        }
        done.settle(JSONObject().put("scope", grantUserScope(tree)), null)
    }

    // ---- scope plumbing -------------------------------------------------------

    // Contract v1.1.0: stat / list / mkdir / remove / rename — Kotlin port of
    // the iOS FSPrimitives additions, same wire shapes and same defaults (a
    // missing path is `io`; mkdir is recursive and only errors on an existing
    // dir when `existing:"error"`; remove needs `recursive:true` for dirs and
    // treats absence as a value unless `missing:"error"`; rename REPLACES the
    // destination — the upstream atomic-write path depends on it).

    private fun stat(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val (scope, rel) = target(call, "fsStat", done) ?: return
        try {
            if (scope == "app") {
                val file = File(appRoot, rel)
                if (!file.exists()) throw io("fsStat", "cannot stat $rel")
                done.settle(statPayload(file), null)
            } else {
                val treeUri = scopeTree(scope) ?: return done.settle(null, denied("fsStat", scope))
                val docUri = tree.resolveInTree(treeUri, rel)
                    ?: throw io("fsStat", "cannot stat $rel")
                done.settle(tree.stat(docUri, rel), null)
            }
        } catch (e: GatewayCore.GatewayError) {
            done.settle(null, e)
        } catch (e: Exception) {
            done.settle(null, io("fsStat", "${e::class.java.simpleName}: ${e.message}"))
        }
    }

    private fun list(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val (scope, rel) = target(call, "fsList", done) ?: return
        try {
            if (scope == "app") {
                val dir = File(appRoot, rel)
                val names = dir.list()
                    ?: throw io("fsList", "cannot list $rel")
                done.settle(
                    JSONObject().put("entries", listPayload(dir, names)),
                    null,
                )
            } else {
                val treeUri = scopeTree(scope) ?: return done.settle(null, denied("fsList", scope))
                val docUri = tree.resolveInTree(treeUri, rel)
                    ?: throw io("fsList", "cannot list $rel")
                done.settle(tree.list(docUri), null)
            }
        } catch (e: GatewayCore.GatewayError) {
            done.settle(null, e)
        } catch (e: Exception) {
            done.settle(null, io("fsList", "${e::class.java.simpleName}: ${e.message}"))
        }
    }

    private fun mkdir(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val (scope, rel) = target(call, "fsMkdir", done) ?: return
        val existing = call.string("existing") ?: "ok"
        try {
            if (scope == "app") {
                val dir = File(appRoot, rel)
                if (dir.isDirectory) {
                    if (existing == "error") throw io("fsMkdir", "$rel exists")
                } else if (!dir.mkdirs()) {
                    throw io("fsMkdir", "cannot create $rel")
                }
            } else {
                val treeUri = scopeTree(scope) ?: return done.settle(null, denied("fsMkdir", scope))
                tree.mkdir(treeUri, rel, existing)
            }
            done.settle(JSONObject(), null)
        } catch (e: GatewayCore.GatewayError) {
            done.settle(null, e)
        } catch (e: Exception) {
            done.settle(null, io("fsMkdir", "${e::class.java.simpleName}: ${e.message}"))
        }
    }

    private fun remove(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val (scope, rel) = target(call, "fsRemove", done) ?: return
        val recursive = call.args.optBoolean("recursive", false)
        val missing = call.string("missing") ?: "ok"
        try {
            if (scope == "app") {
                val file = File(appRoot, rel)
                val absent = !file.exists()
                val dirWithoutRecursive = file.isDirectory && !recursive
                if (absent && missing == "error") throw io("fsRemove", "$rel is absent")
                if (!absent && dirWithoutRecursive) {
                    throw invalid("fsRemove", "$rel is a directory (pass recursive: true)")
                }
                if (!absent && !file.deleteRecursively()) throw io("fsRemove", "cannot remove $rel")
            } else {
                val treeUri = scopeTree(scope) ?: return done.settle(null, denied("fsRemove", scope))
                tree.remove(treeUri, rel, missing)
            }
            done.settle(JSONObject(), null)
        } catch (e: GatewayCore.GatewayError) {
            done.settle(null, e)
        } catch (e: Exception) {
            done.settle(null, io("fsRemove", "${e::class.java.simpleName}: ${e.message}"))
        }
    }

    private fun rename(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val scope = call.string("scope")
        val relFrom = call.string("from")?.let { safeRelative(it) }
        val relTo = call.string("to")?.let { safeRelative(it) }
        if (scope == null || relFrom == null || relTo == null) {
            return done.settle(null, invalid("fsRename", "malformed scope/from/to"))
        }
        try {
            if (scope == "app") {
                val source = File(appRoot, relFrom)
                val dest = File(appRoot, relTo)
                if (!source.exists()) throw io("fsRename", "$relFrom is absent")
                dest.parentFile?.mkdirs()
                if (dest.exists() && !dest.delete()) throw io("fsRename", "cannot replace $relTo")
                if (!source.renameTo(dest)) throw io("fsRename", "cannot rename $relFrom")
            } else {
                val treeUri = scopeTree(scope) ?: return done.settle(null, denied("fsRename", scope))
                tree.rename(treeUri, relFrom, relTo)
            }
            done.settle(JSONObject(), null)
        } catch (e: GatewayCore.GatewayError) {
            done.settle(null, e)
        } catch (e: Exception) {
            done.settle(null, io("fsRename", "${e::class.java.simpleName}: ${e.message}"))
        }
    }

    /** `{kind, size, mtime}` — the contract's stat shape, app scope. */
    private fun statPayload(file: File): JSONObject = JSONObject()
        .put("kind", if (file.isDirectory) "dir" else if (file.isFile) "file" else "other")
        .put("size", if (file.isFile) file.length() else 0L)
        .put("mtime", isoMillis(file.lastModified()))

    /** One-level entries, hidden included, byte-order sorted by name
     * (contract §4: a listing is deterministic across hosts). */
    private fun listPayload(dir: File, names: Array<String>): org.json.JSONArray {
        val entries = org.json.JSONArray()
        val sorted = names.sortedWith { a, b ->
            java.util.Arrays.compare(
                a.toByteArray(Charsets.UTF_8),
                b.toByteArray(Charsets.UTF_8),
            )
        }
        for (name in sorted) {
            val child = File(dir, name)
            entries.put(
                JSONObject()
                    .put("name", name)
                    .put("kind", if (child.isDirectory) "dir" else if (child.isFile) "file" else "other"),
            )
        }
        return entries
    }

    /** Validates (scope, path) args; settles `invalid` and returns null. */
    private fun target(
        call: GatewayCore.GatewayCall,
        primitive: String,
        done: GatewayCore.Done,
    ): Pair<String, String>? {
        val scope = call.string("scope")
        val rel = call.string("path")?.let { safeRelative(it) }
        if (scope == null || rel == null) {
            done.settle(null, invalid(primitive, "malformed scope/path"))
            return null
        }
        return scope to rel
    }

    private fun scopeTree(scope: String): Uri? = synchronized(lock) { userScopes[scope] }

    private fun readRegistry(): JSONObject = try {
        JSONObject(registryFile.readText())
    } catch (_: Exception) {
        JSONObject()
    }

    private fun writeRegistry(reg: JSONObject) {
        registryFile.writeText(reg.toString())
    }

    private fun b64(bytes: ByteArray): String =
        java.util.Base64.getEncoder().encodeToString(bytes)

    private fun settleRead(done: GatewayCore.Done, bytes: ByteArray, mtime: String) {
        done.settle(JSONObject().put("bytesB64", b64(bytes)).put("mtime", mtime), null)
    }

    private fun isoMillis(millis: Long): String =
        java.time.Instant.ofEpochMilli(millis).toString()

}
