package com.dshmobile.host

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File

/**
 * Serves the presentShare files payload to share targets over content:// —
 * a bare framework ContentProvider (the dependency posture forbids
 * androidx FileProvider). The share primitive stages exactly the files it
 * already resolved through the fs scope discipline (ShareFilesProvider.stage
 * returns the index for the URI); openFile serves ONLY a staged index, so a
 * probed or stale URI outside the current payload finds nothing. Read-only,
 * per-call: the staging clears the moment the sheet completes.
 */
class ShareFilesProvider : ContentProvider() {

    companion object {
        const val AUTHORITY = "com.dshmobile.host.share"
        private val lock = Object()
        private var staged: List<File> = emptyList()

        /** Stages one file and returns its index (the content URI path). */
        fun stage(file: File): Int = synchronized(lock) {
            val next = staged.size
            staged = staged + file
            next
        }

        /** Drops the per-call staging (sheet completed or was dismissed). */
        fun clear() = synchronized(lock) { staged = emptyList() }
    }

    override fun onCreate(): Boolean = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        require(mode == "r") { "share files are read-only" }
        val file = stagedFile(uri)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val file = stagedFile(uri)
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val cursor = MatrixCursor(cols)
        cursor.addRow(cols.map { column ->
            when (column) {
                OpenableColumns.DISPLAY_NAME -> file.name
                OpenableColumns.SIZE -> file.length()
                else -> null
            }
        })
        return cursor
    }

    private fun stagedFile(uri: Uri): File {
        val index = uri.lastPathSegment?.toIntOrNull()
            ?: throw java.io.FileNotFoundException("bad share index: $uri")
        val file = synchronized(lock) { staged.getOrNull(index) }
            ?: throw java.io.FileNotFoundException("share staging empty or expired: $uri")
        if (!file.isFile) throw java.io.FileNotFoundException("not a staged file: $file")
        return file
    }

    override fun getType(uri: Uri): String {
        val name = synchronized(lock) { staged.getOrNull(uri.lastPathSegment?.toIntOrNull() ?: -1)?.name }
            ?: return "application/octet-stream"
        val ext = name.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "txt" -> "text/plain"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "pdf" -> "application/pdf"
            "html" -> "text/html"
            "json" -> "application/json"
            else -> "application/octet-stream"
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(
        uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?,
    ): Int = 0
}
