package io.crates.keyring

import android.content.Context

/**
 * Initializes the ndk-context used by android-native-keyring-store.
 *
 * Tauri 2.11 no longer initializes the legacy ndk-context crate, so the
 * keyring backend's JNI initializer must receive the application context
 * before any credential command runs.
 */
class Keyring {
  companion object {
    external fun initializeNdkContext(context: Context)
  }
}
