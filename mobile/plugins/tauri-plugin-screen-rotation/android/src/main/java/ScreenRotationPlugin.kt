package com.agentport.screenrotation

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.view.ViewTreeObserver
import android.webkit.WebView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
    private var immersive = false
    private val focusListener = ViewTreeObserver.OnWindowFocusChangeListener { focused ->
        // Android can restore bars after onResume, when the window regains focus.
        if (focused && immersive) applyImmersive()
    }

    override fun load(webView: WebView) {
        activity.window.decorView.viewTreeObserver.addOnWindowFocusChangeListener(focusListener)
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onDestroy() {
        activity.window.decorView.viewTreeObserver.removeOnWindowFocusChangeListener(focusListener)
    }

    private fun applyImmersive() {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        // Do not include Type.ime(): terminal keyboard visibility has its own owner.
        if (immersive) controller.hide(WindowInsetsCompat.Type.systemBars())
        else controller.show(WindowInsetsCompat.Type.systemBars())
    }

    @Command
    fun setImmersive(invoke: Invoke) {
        val enabled = invoke.getArgs().getBoolean("immersive", false)
        activity.runOnUiThread {
            immersive = enabled
            applyImmersive()
            invoke.resolve(JSObject())
        }
    }

    override fun onResume() {
        applyImmersive()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        applyImmersive()
    }

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
