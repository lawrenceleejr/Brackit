fn main() {
    // the UI in ../web is embedded into the binary: rebuild when it changes
    println!("cargo:rerun-if-changed=../web");
    #[cfg(feature = "gui")]
    tauri_build::build();
}
