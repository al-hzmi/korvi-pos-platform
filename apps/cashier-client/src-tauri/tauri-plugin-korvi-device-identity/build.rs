const COMMANDS: &[&str] = &["identity", "sign", "protect", "unprotect"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
