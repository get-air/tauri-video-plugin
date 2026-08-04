#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let allowed_origins = vec![
            "tauri://localhost".into(),
            "http://tauri.localhost".into(),
            "https://tauri.localhost".into(),
            "http://localhost:1420".into(),
        ];
    tauri::Builder::default()
        .plugin(
            tauri_plugin_video::Builder::new()
                .allowed_origins(allowed_origins)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
