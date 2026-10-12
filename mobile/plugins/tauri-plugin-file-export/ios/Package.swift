// swift-tools-version:5.7
import PackageDescription

let package = Package(
  name: "tauri-plugin-file-export",
  platforms: [.iOS(.v16)],
  products: [.library(name: "tauri-plugin-file-export", type: .static, targets: ["tauri-plugin-file-export"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-file-export", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
