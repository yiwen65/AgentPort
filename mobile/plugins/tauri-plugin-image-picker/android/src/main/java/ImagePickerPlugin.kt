package com.agentport.imagepicker

import android.app.Activity
import androidx.activity.result.ActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID

@TauriPlugin
class ImagePickerPlugin(private val activity: Activity) : Plugin(activity) {
    private var pending = false

    @Command
    fun pickImage(invoke: Invoke) {
        activity.runOnUiThread {
            if (pending) {
                invoke.reject("An image picker is already open.")
                return@runOnUiThread
            }
            pending = true
            try {
                // AndroidX uses the system Photo Picker, with the platform
                // document-picker fallback on devices without its backport.
                val intent = PickVisualMedia().createIntent(
                    activity, PickVisualMediaRequest(PickVisualMedia.ImageOnly)
                )
                startActivityForResult(invoke, intent, "imagePicked")
            } catch (error: Exception) {
                pending = false
                invoke.reject("Unable to open the image picker.")
            }
        }
    }

    @ActivityCallback
    private fun imagePicked(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            pending = false
            invoke.resolve(JSObject())
            return
        }
        Thread {
            var temporary: File? = null
            try {
                val directory = File(activity.cacheDir, "agentport-image-picker")
                if (!directory.isDirectory && !directory.mkdirs()) {
                    throw IllegalStateException("Cache directory unavailable")
                }
                val file = File(directory, UUID.randomUUID().toString())
                temporary = file
                // Never try to turn content:// into a filesystem path.
                activity.contentResolver.openInputStream(uri).use { input ->
                    requireNotNull(input) { "Image stream unavailable" }
                    file.outputStream().use { output -> input.copyTo(output) }
                }
                activity.runOnUiThread {
                    pending = false
                    invoke.resolve(JSObject().put("path", file.absolutePath))
                }
            } catch (error: Exception) {
                temporary?.delete()
                activity.runOnUiThread {
                    pending = false
                    invoke.reject("Unable to read the selected image.")
                }
            }
        }.start()
    }
}
