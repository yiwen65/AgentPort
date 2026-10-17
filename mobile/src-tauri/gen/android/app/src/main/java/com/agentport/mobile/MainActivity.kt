package com.agentport.mobile

import android.content.pm.ActivityInfo
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    Keyring.initializeNdkContext(applicationContext)
    // Edge-to-edge keeps the WebView full-height even while the IME covers it.
    // Resize the content via its parent, so visualViewport and terminal fitting
    // see the usable height and keep the shortcut row above the keyboard.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, imeBottom)
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }
}
