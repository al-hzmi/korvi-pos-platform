const COMMANDS: &[&str] = &["identity", "sign"];
fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
