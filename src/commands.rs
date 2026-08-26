use tauri::{command, AppHandle, Runtime};

use crate::{models::*, Error, Result, VideoExt};

#[command]
pub(crate) fn native_diagnostics() -> NativePluginDiagnostics {
    NativePluginDiagnostics::current()
}

#[command]
pub(crate) async fn native_open<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeOpenRequest,
) -> Result<NativePlaybackSnapshot> {
    require_native_protocol(payload.protocol_version, payload.package_version.as_deref())?;
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
#[allow(non_snake_case)]
pub(crate) async fn native_prepare_texture_stream<R: Runtime>(
    app: AppHandle<R>,
    sessionKey: String,
) -> Result<String> {
    #[cfg(windows)]
    {
        let stream_id = format!("air-video-{sessionKey}");
        app.video()
            .desktop()
            .prepare_texture_stream(stream_id.clone())?;
        Ok(stream_id)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, sessionKey);
        Err(Error::InvalidRequest(
            "WebView2 texture streams are available only on Windows".into(),
        ))
    }
}

fn require_native_protocol(actual: Option<u32>, package_version: Option<&str>) -> Result<()> {
    let package_version = package_version.filter(|version| !version.trim().is_empty());
    if actual == Some(VIDEO_PLUGIN_PROTOCOL_VERSION) && package_version.is_some() {
        return Ok(());
    }
    Err(Error::ProtocolMismatch {
        expected: VIDEO_PLUGIN_PROTOCOL_VERSION,
        actual,
        package_version: package_version.map(str::to_owned),
    })
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

#[cfg(test)]
mod tests {
    use crate::{Error, VIDEO_PLUGIN_PROTOCOL_VERSION};

    #[test]
    fn native_diagnostics_command_reports_the_current_contract() {
        let diagnostics = super::native_diagnostics();

        assert_eq!(diagnostics.protocol_version, VIDEO_PLUGIN_PROTOCOL_VERSION);
        assert_eq!(diagnostics.crate_name, env!("CARGO_PKG_NAME"));
        assert_eq!(diagnostics.crate_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(diagnostics.platform, std::env::consts::OS);
    }

    #[test]
    fn native_open_requires_the_current_protocol() {
        assert!(
            super::require_native_protocol(Some(VIDEO_PLUGIN_PROTOCOL_VERSION), Some("0.2.0"),)
                .is_ok()
        );

        for (actual, package_version) in [
            (None, Some("legacy-test-version")),
            (
                Some(VIDEO_PLUGIN_PROTOCOL_VERSION + 1),
                Some("future-test-version"),
            ),
            (Some(VIDEO_PLUGIN_PROTOCOL_VERSION), None),
            (Some(VIDEO_PLUGIN_PROTOCOL_VERSION), Some("")),
        ] {
            let error = super::require_native_protocol(actual, package_version)
                .expect_err("missing metadata or an unequal protocol must fail");
            assert_eq!(error.code(), "PROTOCOL_MISMATCH");
            match error {
                Error::ProtocolMismatch {
                    expected,
                    actual: received,
                    package_version: received_package,
                } => {
                    assert_eq!(expected, VIDEO_PLUGIN_PROTOCOL_VERSION);
                    assert_eq!(received, actual);
                    assert_eq!(
                        received_package.as_deref(),
                        package_version.filter(|version| !version.trim().is_empty()),
                    );
                }
                other => panic!("expected a protocol mismatch, received {other}"),
            }
        }
    }
}
