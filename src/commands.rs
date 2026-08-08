use tauri::{command, AppHandle, Runtime};

use crate::{models::*, Result, VideoExt};

#[command]
pub(crate) async fn native_open<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeOpenRequest,
) -> Result<NativePlaybackSnapshot> {
    #[cfg(mobile)]
    {
        return app.video().mobile().open_native(payload);
    }
    #[cfg(desktop)]
    {
        app.video().desktop().open_native(payload)
    }
}

#[command]
pub(crate) async fn native_control<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeControlRequest,
) -> Result<NativePlaybackSnapshot> {
    #[cfg(mobile)]
    {
        return app.video().mobile().control_native(payload);
    }
    #[cfg(desktop)]
    {
        app.video().desktop().control_native(payload)
    }
}

#[command]
pub(crate) async fn native_layout<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeLayoutRequest,
) -> Result<()> {
    #[cfg(mobile)]
    {
        return app.video().mobile().layout_native(payload);
    }
    #[cfg(desktop)]
    {
        app.video().desktop().layout_native(payload)
    }
}

#[command]
pub(crate) async fn native_stats<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeSessionRequest,
) -> Result<NativePlaybackSnapshot> {
    #[cfg(mobile)]
    {
        return app.video().mobile().stats_native(payload);
    }
    #[cfg(desktop)]
    {
        app.video().desktop().stats_native(payload)
    }
}

#[command]
pub(crate) async fn native_close<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeSessionRequest,
) -> Result<()> {
    #[cfg(mobile)]
    {
        return app.video().mobile().close_native(payload);
    }
    #[cfg(desktop)]
    {
        app.video().desktop().close_native(payload)
    }
}
