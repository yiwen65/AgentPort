// swift-tools-version:5.7
import PackageDescription

let package = Package(
  name: "tauri-plugin-image-picker",
  platforms: [.iOS(.v16)],
  products: [.library(name: "tauri-plugin-image-picker", type: .static, targets: ["tauri-plugin-image-picker"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-image-picker", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
