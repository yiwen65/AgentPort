package com.agentport.screenrotation

import android.app.Activity
import android.content.pm.ActivityInfo
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The activity locks itself to portrait at launch. While the terminal route is
 * visible the app releases the lock so the terminal follows the device
 * orientation (PRD SES-07/TERM-02); every other screen stays portrait.
 */
@TauriPlugin
class ScreenRotationPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun setRotationAllowed(invoke: Invoke) {
        val allowed = invoke.getArgs().getBoolean("rotationAllowed", false)
        activity.runOnUiThread {
            activity.requestedOrientation = if (allowed) {
                // Follow the system rotation setting, as before the portrait lock.
                ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            } else {
                ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            }
            invoke.resolve(JSObject())
        }
    }
}
