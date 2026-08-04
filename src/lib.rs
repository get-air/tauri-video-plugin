use std::sync::Arc;

use tauri::{
    plugin::{Builder as TauriBuilder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(all(target_os = "android", feature = "gstreamer-runtime"))]
mod android_static_plugins;
mod broker;
mod commands;
#[cfg(desktop)]
mod desktop;
mod discovery;
mod error;
#[cfg(mobile)]
mod mobile;
mod models;
mod pipeline;
mod runtime;
mod session;

pub use error::{Error, Result};
use session::SessionManager;

/// Runtime state shared by the Rust commands on every supported platform.
pub struct Video<R: Runtime> {
    _app: tauri::AppHandle<R>,
    manager: Arc<SessionManager>,
    #[cfg(desktop)]
    desktop: desktop::DesktopVideo<R>,
    #[cfg(mobile)]
    mobile: mobile::MobileVideo<R>,
}

impl<R: Runtime> Video<R> {
    fn new(
        app: tauri::AppHandle<R>,
        config: VideoPluginConfig,
        #[cfg(desktop)] desktop: desktop::DesktopVideo<R>,
        #[cfg(mobile)] mobile: mobile::MobileVideo<R>,
    ) -> Self {
        Self {
            _app: app,
            manager: Arc::new(SessionManager::new(config)),
            #[cfg(desktop)]
            desktop,
            #[cfg(mobile)]
            mobile,
        }
    }

    pub(crate) fn manager(&self) -> &SessionManager {
        &self.manager
    }

    #[cfg(desktop)]
    pub(crate) fn desktop(&self) -> &desktop::DesktopVideo<R> {
        &self.desktop
    }

    #[cfg(mobile)]
    pub(crate) fn mobile(&self) -> &mobile::MobileVideo<R> {
        &self.mobile
    }

    #[cfg(mobile)]
    pub(crate) fn sync_mobile_playback(&self) -> Result<()> {
        self.mobile.set_playing(self.manager.has_playing_sessions())
    }
}

/// Extensions to Tauri managers for accessing the video plugin state from Rust.
pub trait VideoExt<R: Runtime> {
    fn video(&self) -> tauri::State<'_, Video<R>>;
}

impl<R: Runtime, T: Manager<R>> VideoExt<R> for T {
    fn video(&self) -> tauri::State<'_, Video<R>> {
        self.state::<Video<R>>()
    }
}

/// Configurable plugin builder.
pub struct Builder {
    config: VideoPluginConfig,
}

impl Default for Builder {
    fn default() -> Self {
        Self::new()
    }
}

impl Builder {
    pub fn new() -> Self {
        Self {
            config: VideoPluginConfig::default(),
        }
    }

    pub fn desktop_memory_budget_mib(mut self, value: usize) -> Self {
        self.config.desktop_memory_budget_mib = value.max(64);
        self
    }

    pub fn mobile_memory_budget_mib(mut self, value: usize) -> Self {
        self.config.mobile_memory_budget_mib = value.max(64);
        self
    }

    pub fn session_memory_budget_mib(mut self, value: usize) -> Self {
        self.config.session_memory_budget_mib = value.clamp(16, 512);
        self
    }

    pub fn max_desktop_transcoders(mut self, value: usize) -> Self {
        self.config.max_desktop_transcoders = value.max(1);
        self
    }

    pub fn max_mobile_transcoders(mut self, value: usize) -> Self {
        self.config.max_mobile_transcoders = value.max(1);
        self
    }

    pub fn allowed_origins(mut self, origins: impl IntoIterator<Item = String>) -> Self {
        self.config.allowed_origins = origins.into_iter().collect();
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let config = self.config;
        TauriBuilder::new("video")
            .invoke_handler(tauri::generate_handler![
                commands::runtime_capabilities,
                commands::create_session,
                commands::set_playback_state,
                commands::seek,
                commands::select_track,
                commands::update_visibility,
                commands::session_stats,
                commands::destroy_session,
                commands::native_open,
                commands::native_control,
                commands::native_layout,
                commands::native_stats,
                commands::native_close,
            ])
            .setup(move |app, api| {
                #[cfg(mobile)]
                let mobile = mobile::init(app, api)?;
                #[cfg(desktop)]
                let desktop = desktop::init(app, api)?;

                let video = Video::new(
                    app.clone(),
                    config.clone(),
                    #[cfg(desktop)]
                    desktop,
                    #[cfg(mobile)]
                    mobile,
                );
                app.manage(video);
                Ok(())
            })
            .build()
    }
}

/// Initializes the plugin with production defaults.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}
