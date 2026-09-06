use std::path::PathBuf;

fn main() {
    tauri_build::build();

    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("apple-ios") {
        let (directory, script) = match target.as_str() {
            "aarch64-apple-ios" => ("ios-device-arm64", "build-ios-device.sh"),
            "aarch64-apple-ios-sim" => ("ios-simulator-arm64", "build-ios-simulator.sh"),
            _ => panic!("Mosh source artifacts are not configured for iOS target {target}"),
        };
        let native = PathBuf::from("../native/mosh/build").join(directory);
        let mosh = native.join("libmosh.a");
        let protobuf = native.join("libprotobuf.a");
        if !mosh.is_file() || !protobuf.is_file() {
            panic!("Mosh iOS source artifacts are missing; run mobile/native/mosh/{script}");
        }
        println!("cargo:rustc-link-search=native={}", native.display());
        println!("cargo:rustc-link-lib=static=mosh");
        println!("cargo:rustc-link-lib=static=protobuf");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=z");
        println!("cargo:rustc-link-lib=c++");
        println!("cargo:rerun-if-changed={}", mosh.display());
        println!("cargo:rerun-if-changed={}", protobuf.display());
    } else if target.contains("linux-android") {
        let native = PathBuf::from("../native/mosh/build/android/arm64-v8a");
        let mosh = native.join("libagentport_mosh.so");
        if !mosh.is_file() {
            panic!(
                "Mosh Android source artifact is missing; run mobile/native/mosh/build-android-arm64.sh"
            );
        }
        println!("cargo:rustc-link-search=native={}", native.display());
        println!("cargo:rustc-link-lib=dylib=agentport_mosh");
        println!("cargo:rerun-if-changed={}", mosh.display());
    }
}
