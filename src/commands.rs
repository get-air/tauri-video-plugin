use tauri::{command, AppHandle, Runtime};

use crate::{models::*, Result, VideoExt};

#[command]
pub(crate) async fn runtime_capabilities<R: Runtime>(
    app: AppHandle<R>,
) -> Result<RuntimeCapabilities> {
    Ok(app.video().manager().runtime_capabilities())
}

#[command]
pub(crate) async fn create_session<R: Runtime>(
    app: AppHandle<R>,
    payload: CreateSessionRequest,
) -> Result<SessionDescriptor> {
    app.video().manager().create_session(payload).await
}

#[command]
pub(crate) async fn set_playback_state<R: Runtime>(
    app: AppHandle<R>,
    payload: SetPlaybackStateRequest,
) -> Result<()> {
    let video = app.video();
    video.manager().set_playback_state(payload)?;
    #[cfg(mobile)]
    video.sync_mobile_playback()?;
    Ok(())
}

#[command]
pub(crate) async fn seek<R: Runtime>(
    app: AppHandle<R>,
    payload: SeekRequest,
) -> Result<SeekResponse> {
    app.video().manager().seek(payload).await
}

#[command]
pub(crate) async fn select_track<R: Runtime>(
    app: AppHandle<R>,
    payload: SelectTrackRequest,
) -> Result<SeekResponse> {
    app.video().manager().select_track(payload).await
}

#[command]
pub(crate) async fn update_visibility<R: Runtime>(
    app: AppHandle<R>,
    payload: VisibilityRequest,
) -> Result<()> {
    app.video().manager().update_visibility(payload)
}

#[command]
pub(crate) async fn session_stats<R: Runtime>(
    app: AppHandle<R>,
    payload: SessionIdRequest,
) -> Result<SessionStats> {
    app.video().manager().stats(payload.session_id)
}

#[command]
pub(crate) async fn destroy_session<R: Runtime>(
    app: AppHandle<R>,
    payload: SessionIdRequest,
) -> Result<()> {
    let video = app.video();
    video.manager().destroy(payload.session_id)?;
    #[cfg(mobile)]
    video.sync_mobile_playback()?;
    Ok(())
}

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
pub(crate) async fn native_stats<R: Runtime>(app: AppHandle<R>) -> Result<NativePlaybackSnapshot> {
    #[cfg(mobile)]
    {
        return app.video().mobile().stats_native();
    }
    #[cfg(desktop)]
    {
        app.video().desktop().stats_native()
    }
}

#[command]
pub(crate) async fn native_close<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    #[cfg(mobile)]
    {
        return app.video().mobile().close_native();
    }
    #[cfg(desktop)]
    {
        app.video().desktop().close_native()
    }
}
