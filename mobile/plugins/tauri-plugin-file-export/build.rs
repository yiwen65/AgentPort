fn main() {
    // No JS commands: only the app's owned-file manager can invoke this plugin.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
}
