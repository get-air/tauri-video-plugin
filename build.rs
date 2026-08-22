const COMMANDS: &[&str] = &[
    "native_diagnostics",
    "native_open",
    "native_prepare_texture_stream",
    "native_control",
    "native_layout",
    "native_stats",
    "native_close",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
