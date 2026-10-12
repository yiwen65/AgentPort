package com.agentport.fileexport

import android.app.Activity
import android.content.Intent
import android.provider.DocumentsContract
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ExportArgs {
    lateinit var path: String
    lateinit var name: String
    lateinit var jobId: String
}

@TauriPlugin
class FileExportPlugin(private val activity: Activity) : Plugin(activity) {
    private var source: File? = null

    @Command
    fun exportFile(invoke: Invoke) {
        activity.runOnUiThread {
            if (source != null) {
                invoke.resolve(JSObject().put("status", "save_busy"))
                return@runOnUiThread
            }
            try {
                val args = invoke.parseArgs(ExportArgs::class.java)
                val file = File(args.path).canonicalFile
                require(file.isFile && file.name == args.name && file.parentFile?.name == args.jobId)
                require(file.parentFile?.parentFile == File(activity.cacheDir, "agentport-file-downloads").canonicalFile)
                source = file
                val extension = args.name.substringAfterLast('.', "").lowercase()
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mime
                    putExtra(Intent.EXTRA_TITLE, args.name)
                }
                startActivityForResult(invoke, intent, "fileCreated")
            } catch (error: Exception) {
                source = null
                invoke.resolve(JSObject().put("status", "save_failed"))
            }
        }
    }

    @ActivityCallback
    private fun fileCreated(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        val file = source
        if (result.resultCode != Activity.RESULT_OK || uri == null || file == null) {
            source = null
            invoke.resolve(JSObject().put("status", "cancelled"))
            return
        }
        // ACTION_CREATE_DOCUMENT returns a newly created document, never an
        // existing one. No filesystem conversion and no UI-thread bulk IO.
        Thread {
            var status = "saved"
            try {
                file.inputStream().buffered(262144).use { input ->
                    requireNotNull(activity.contentResolver.openOutputStream(uri, "w")).buffered(262144).use { output ->
                        input.copyTo(output, 262144)
                        output.flush()
                    } // A close failure is also a failed save.
                }
            } catch (error: Exception) {
                val removed = try { DocumentsContract.deleteDocument(activity.contentResolver, uri) } catch (_: Exception) { false }
                status = if (removed) "save_failed" else "save_failed_leftover"
            }
            activity.runOnUiThread {
                source = null
                invoke.resolve(JSObject().put("status", status))
            }
        }.start()
    }
}
