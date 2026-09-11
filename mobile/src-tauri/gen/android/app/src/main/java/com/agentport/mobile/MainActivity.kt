package com.agentport.mobile

import android.content.pm.ActivityInfo
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    Keyring.initializeNdkContext(applicationContext)
  }
}
