use crate::models::{
    NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
    NativeSessionRequest,
};
use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
compile_error!("tauri-plugin-video v0.1 supports Android, Android TV, and Linux only");

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<MobileVideo<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("io.github.taurivideo.plugin", "VideoPlugin")?;
    Ok(MobileVideo(handle))
}

pub struct MobileVideo<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> MobileVideo<R> {
    pub fn open_native(&self, payload: NativeOpenRequest) -> crate::Result<NativePlaybackSnapshot> {
        Ok(self.0.run_mobile_plugin("openNative", payload)?)
    }

    pub fn control_native(
        &self,
        payload: NativeControlRequest,
    ) -> crate::Result<NativePlaybackSnapshot> {
        Ok(self.0.run_mobile_plugin("controlNative", payload)?)
    }

    pub fn layout_native(&self, payload: NativeLayoutRequest) -> crate::Result<()> {
        self.0.run_mobile_plugin::<()>("layoutNative", payload)?;
        Ok(())
    }

    pub fn stats_native(
        &self,
        payload: NativeSessionRequest,
    ) -> crate::Result<NativePlaybackSnapshot> {
        Ok(self.0.run_mobile_plugin("statsNative", payload)?)
    }

    pub fn close_native(&self, payload: NativeSessionRequest) -> crate::Result<()> {
        self.0.run_mobile_plugin::<()>("closeNative", payload)?;
        Ok(())
    }
}
