use tauri::{
    plugin::{Builder as TauriBuilder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

mod commands;
#[cfg(desktop)]
mod desktop;
mod error;
#[cfg(mobile)]
mod mobile;
mod models;

pub use error::{Error, Result};

/// Runtime state shared by the Rust commands on every supported platform.
pub struct Video<R: Runtime> {
    _app: tauri::AppHandle<R>,
    #[cfg(desktop)]
    desktop: desktop::DesktopVideo<R>,
    #[cfg(mobile)]
    mobile: mobile::MobileVideo<R>,
}

impl<R: Runtime> Video<R> {
    fn new(
        app: tauri::AppHandle<R>,
        #[cfg(desktop)] desktop: desktop::DesktopVideo<R>,
        #[cfg(mobile)] mobile: mobile::MobileVideo<R>,
    ) -> Self {
        Self {
            _app: app,
            #[cfg(desktop)]
            desktop,
            #[cfg(mobile)]
            mobile,
        }
    }

    #[cfg(desktop)]
    pub(crate) fn desktop(&self) -> &desktop::DesktopVideo<R> {
        &self.desktop
    }

    #[cfg(mobile)]
    pub(crate) fn mobile(&self) -> &mobile::MobileVideo<R> {
        &self.mobile
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

/// Plugin builder.
pub struct Builder;

impl Default for Builder {
    fn default() -> Self {
        Self::new()
    }
}

impl Builder {
    pub fn new() -> Self {
        Self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        TauriBuilder::new("video")
            .invoke_handler(tauri::generate_handler![
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
