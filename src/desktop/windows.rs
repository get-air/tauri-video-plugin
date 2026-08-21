use tauri::{AppHandle, Runtime};

use crate::{
    models::{
        NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
        NativeSessionRequest,
    },
    Error, Result,
};

pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    payload: NativeOpenRequest,
) -> Result<NativePlaybackSnapshot> {
    match payload.backend.as_deref() {
        None | Some("gstreamer") => gstreamer::open(app, payload),
        Some("mpv") => Err(Error::RuntimeUnavailable(
            "the mpv backend is not implemented on Windows; use gstreamer".into(),
        )),
        Some(backend) => Err(Error::InvalidRequest(format!(
            "backend '{backend}' is not available on Windows"
        ))),
    }
}

pub fn control(payload: NativeControlRequest) -> Result<NativePlaybackSnapshot> {
    gstreamer::control(payload)
}

pub fn layout(payload: NativeLayoutRequest) -> Result<()> {
    gstreamer::layout(payload)
}

pub fn stats(payload: NativeSessionRequest) -> Result<NativePlaybackSnapshot> {
    gstreamer::stats(payload)
}

pub fn close(payload: NativeSessionRequest) -> Result<()> {
    gstreamer::close(payload)
}

#[cfg(feature = "gstreamer-runtime")]
mod gstreamer {
    use std::{
        cell::RefCell,
        collections::BTreeSet,
        sync::{Arc, OnceLock},
        time::Instant,
    };

    use ::windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
            Graphics::Gdi::{
                ClientToScreen, CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject,
                SetWindowRgn, HGDIOBJ, HRGN, RGN_DIFF, RGN_ERROR,
            },
            System::SystemServices::SS_BLACKRECT,
            UI::{
                HiDpi::GetDpiForWindow,
                Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
                WindowsAndMessaging::{
                    CreateWindowExW, DestroyWindow, FindWindowExW, IsIconic, IsWindowVisible,
                    SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
                    WINDOW_STYLE, WM_ACTIVATE, WM_DPICHANGED, WM_NCDESTROY, WM_SHOWWINDOW, WM_SIZE,
                    WM_WINDOWPOSCHANGED, WS_CLIPCHILDREN, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
                    WS_POPUP,
                },
            },
        },
    };
    use gst::prelude::*;
    use gstreamer as gst;
    use gstreamer_video::{
        prelude::{VideoOverlayExt, VideoOverlayExtManual},
        VideoOverlay,
    };
    use parking_lot::RwLock;
    use tauri::{AppHandle, Manager, Runtime};

    use crate::{
        models::{
            NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
            NativeRect, NativeSessionRequest, NativeTrackInfo, TrackKind,
        },
        Error, Result,
    };

    static GST_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    const PARENT_WINDOW_SUBCLASS_ID: usize = 0x4156_5041;

    thread_local! {
        static PLAYER: RefCell<Option<NativePlayer>> = const { RefCell::new(None) };
        static SURFACE: RefCell<Option<NativeSurface>> = const { RefCell::new(None) };
        static SURFACE_PLACEMENT: RefCell<Option<SurfacePlacement>> = const { RefCell::new(None) };
    }

    #[derive(Clone, Copy)]
    struct NativeSurface {
        parent: HWND,
        child: HWND,
    }

    #[derive(Clone, Copy)]
    struct SurfacePlacement {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    struct NativePlayer {
        session_key: String,
        pipeline: gst::Element,
        video_sink: gst::Element,
        overlay: VideoOverlay,
        source: Arc<RwLock<NativeOpenRequest>>,
        buffering_percent: i32,
        buffer_duration_seconds: Option<f64>,
        target_buffer_bytes: Option<u64>,
        desired_playing: bool,
        error: Option<String>,
        last_rendered: u64,
        region_frame_baseline: u64,
        region_applied_after_first_frame: bool,
        last_sample_at: Instant,
        measured_fps: f64,
        tracks: Vec<NativeTrackInfo>,
        selected_streams: BTreeSet<String>,
    }

    pub fn open<R: Runtime>(
        app: &AppHandle<R>,
        payload: NativeOpenRequest,
    ) -> Result<NativePlaybackSnapshot> {
        initialize_gstreamer()?;
        ensure_surface(app)?;
        place_surface(
            payload.x,
            payload.y,
            payload.width,
            payload.height,
            payload.surface_aperture.as_ref(),
            &payload.surface_overlays,
        )?;

        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            if let Some(player) = slot.as_mut() {
                load_source(player, &payload)?;
                return snapshot(player);
            }

            let mut player = create_player(&payload)?;
            let result = snapshot(&mut player)?;
            *slot = Some(player);
            Ok(result)
        })
    }

    fn initialize_gstreamer() -> Result<()> {
        GST_INIT
            .get_or_init(|| gst::init().map_err(|error| error.to_string()))
            .clone()
            .map_err(Error::RuntimeUnavailable)
    }

    fn ensure_surface<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
        SURFACE.with(|slot| {
            if slot.borrow().is_some() {
                return Ok(());
            }
            let window =
                app.webview_windows().into_values().next().ok_or_else(|| {
                    Error::Pipeline("no Tauri webview window is available".into())
                })?;
            let parent = window
                .hwnd()
                .map_err(|error| Error::Pipeline(error.to_string()))?;
            window
                .as_ref()
                .set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)))
                .map_err(|error| Error::Pipeline(error.to_string()))?;
            let child = unsafe {
                CreateWindowExW(
                    WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                    w!("STATIC"),
                    w!(""),
                    WS_POPUP | WS_CLIPCHILDREN | WINDOW_STYLE(SS_BLACKRECT.0),
                    0,
                    0,
                    1,
                    1,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .map_err(|error| Error::Pipeline(format!("failed to create video HWND: {error}")))?;
            if !unsafe {
                SetWindowSubclass(
                    parent,
                    Some(parent_window_subclass_proc),
                    PARENT_WINDOW_SUBCLASS_ID,
                    0,
                )
            }
            .as_bool()
            {
                unsafe {
                    let _ = DestroyWindow(child);
                }
                return Err(Error::Pipeline(format!(
                    "failed to synchronize the video window with Tauri: {}",
                    ::windows::core::Error::from_win32()
                )));
            }
            *slot.borrow_mut() = Some(NativeSurface { parent, child });
            Ok(())
        })
    }

    unsafe extern "system" fn parent_window_subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _: usize,
        _: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            SURFACE.with(|slot| {
                if let Some(surface) = slot.borrow_mut().take() {
                    unsafe {
                        let _ = DestroyWindow(surface.child);
                    }
                }
            });
            SURFACE_PLACEMENT.with(|slot| *slot.borrow_mut() = None);
            unsafe {
                let _ = RemoveWindowSubclass(
                    hwnd,
                    Some(parent_window_subclass_proc),
                    PARENT_WINDOW_SUBCLASS_ID,
                );
                return DefSubclassProc(hwnd, message, wparam, lparam);
            }
        }

        let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
        if matches!(
            message,
            WM_WINDOWPOSCHANGED | WM_DPICHANGED | WM_SHOWWINDOW | WM_SIZE | WM_ACTIVATE
        ) {
            let _ = sync_surface_window();
        }
        result
    }

    fn surface() -> Result<NativeSurface> {
        SURFACE.with(|slot| {
            slot.borrow()
                .as_ref()
                .copied()
                .ok_or_else(|| Error::Pipeline("native Windows surface is unavailable".into()))
        })
    }

    fn place_surface(
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        aperture: Option<&NativeRect>,
        overlays: &[NativeRect],
    ) -> Result<()> {
        SURFACE_PLACEMENT.with(|slot| {
            *slot.borrow_mut() = Some(SurfacePlacement {
                x,
                y,
                width,
                height,
            });
        });
        let _ = (aperture, overlays);
        sync_surface_window()
    }

    fn sync_surface_window() -> Result<()> {
        let surface = surface()?;
        let Some(placement) = SURFACE_PLACEMENT.with(|slot| *slot.borrow()) else {
            return Ok(());
        };
        if unsafe { IsIconic(surface.parent) }.as_bool()
            || !unsafe { IsWindowVisible(surface.parent) }.as_bool()
        {
            unsafe {
                let _ = ShowWindow(surface.child, SW_HIDE);
            }
            return Ok(());
        }
        let scale = f64::from(unsafe { GetDpiForWindow(surface.parent) }) / 96.0;
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let x = (placement.x * scale).round() as i32;
        let y = (placement.y * scale).round() as i32;
        let width = (placement.width.max(1.0) * scale).round() as i32;
        let height = (placement.height.max(1.0) * scale).round() as i32;
        let mut origin = POINT { x, y };
        unsafe { ClientToScreen(surface.parent, &mut origin) }
            .ok()
            .map_err(|error| {
                Error::Pipeline(format!(
                    "failed to map video coordinates to the desktop: {error}"
                ))
            })?;
        unsafe {
            SetWindowPos(
                surface.child,
                Some(surface.parent),
                origin.x,
                origin.y,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        }
        .map_err(|error| Error::Pipeline(format!("failed to place video HWND: {error}")))?;
        Ok(())
    }

    fn refresh_surface_region(
        x: f64,
        y: f64,
        aperture: Option<&NativeRect>,
        overlays: &[NativeRect],
    ) -> Result<()> {
        let surface = surface()?;
        let scale = f64::from(unsafe { GetDpiForWindow(surface.parent) }) / 96.0;
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        apply_surface_regions(
            surface,
            scale,
            (x * scale).round() as i32,
            (y * scale).round() as i32,
            aperture,
            overlays,
        )
    }

    fn apply_surface_regions(
        surface: NativeSurface,
        scale: f64,
        surface_x: i32,
        surface_y: i32,
        aperture: Option<&NativeRect>,
        _: &[NativeRect],
    ) -> Result<()> {
        apply_window_region(surface.child, scale, surface_x, surface_y, aperture, &[])?;
        if let Some(renderer) = renderer_surface(surface) {
            apply_window_region(renderer, scale, surface_x, surface_y, aperture, &[])?;
        }
        Ok(())
    }

    fn renderer_surface(surface: NativeSurface) -> Option<HWND> {
        unsafe { FindWindowExW(Some(surface.child), None, w!("GSTD3D11"), PCWSTR::null()) }.ok()
    }

    fn apply_window_region(
        window: HWND,
        scale: f64,
        surface_x: i32,
        surface_y: i32,
        aperture: Option<&NativeRect>,
        overlays: &[NativeRect],
    ) -> Result<()> {
        let Some(aperture) = aperture else {
            unsafe {
                SetWindowRgn(window, None, true);
            }
            return Ok(());
        };
        let surface_region = rect_region(aperture, scale, surface_x, surface_y);
        if surface_region.0.is_null() {
            return Err(Error::Pipeline(
                "failed to allocate the native video window region".into(),
            ));
        }
        for overlay in overlays {
            let overlay_region = rect_region(overlay, scale, surface_x, surface_y);
            let combined = unsafe {
                CombineRgn(
                    Some(surface_region),
                    Some(surface_region),
                    Some(overlay_region),
                    RGN_DIFF,
                )
            };
            unsafe {
                let _ = DeleteObject(HGDIOBJ(overlay_region.0));
            }
            if combined == RGN_ERROR {
                unsafe {
                    let _ = DeleteObject(HGDIOBJ(surface_region.0));
                }
                return Err(Error::Pipeline(
                    "failed to cut an HTML overlay from the native video surface".into(),
                ));
            }
        }
        if unsafe { SetWindowRgn(window, Some(surface_region), true) } == 0 {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(surface_region.0));
            }
            return Err(Error::Pipeline(
                "failed to apply the native video window region".into(),
            ));
        }
        Ok(())
    }

    fn rect_region(rect: &NativeRect, scale: f64, surface_x: i32, surface_y: i32) -> HRGN {
        let left = (rect.left * scale).round() as i32 - surface_x;
        let top = (rect.top * scale).round() as i32 - surface_y;
        let right = ((rect.left + rect.width) * scale).round() as i32 - surface_x;
        let bottom = ((rect.top + rect.height) * scale).round() as i32 - surface_y;
        let radius_x = (rect.radius_x.max(0.0) * scale * 2.0).round() as i32;
        let radius_y = (rect.radius_y.max(0.0) * scale * 2.0).round() as i32;
        if radius_x > 0 && radius_y > 0 {
            unsafe { CreateRoundRectRgn(left, top, right + 1, bottom + 1, radius_x, radius_y) }
        } else {
            unsafe { CreateRectRgn(left, top, right, bottom) }
        }
    }

    fn hide_surface() {
        if let Ok(surface) = surface() {
            unsafe {
                let _ = ShowWindow(surface.child, SW_HIDE);
                SetWindowRgn(surface.child, None, true);
                if let Some(renderer) = renderer_surface(surface) {
                    SetWindowRgn(renderer, None, true);
                }
            }
        }
    }

    fn configure_source(element: &gst::Element, source: &NativeOpenRequest) {
        if let Some(user_agent) = source.user_agent.as_deref() {
            if element.find_property("user-agent").is_some() {
                element.set_property("user-agent", user_agent);
            }
        }
        if element.find_property("timeout").is_some() {
            element.set_property("timeout", 60u32);
        }
        if let Some(cookies) = &source.cookies {
            if element.find_property("cookies").is_some() {
                let cookies = gst::glib::StrV::from([cookies.as_str()]);
                element.set_property("cookies", cookies);
            }
        }
        if let Some(ca_file) = source.tls_ca_file.as_deref() {
            if element.find_property("tls-database").is_some() {
                match gio::TlsFileDatabase::new(ca_file) {
                    Ok(database) => element.set_property("tls-database", database),
                    Err(error) => tracing::error!(%error, %ca_file, "failed to load TLS CA file"),
                }
            } else if element.find_property("ssl-ca-file").is_some() {
                element.set_property("ssl-ca-file", ca_file);
            }
        }
        if element.find_property("extra-headers").is_some()
            && (!source.headers.is_empty() || source.referrer.is_some())
        {
            let mut headers = gst::Structure::new_empty("request-headers");
            for (name, value) in &source.headers {
                headers.set(name, value);
            }
            if let Some(referrer) = &source.referrer {
                if !source
                    .headers
                    .keys()
                    .any(|name| name.eq_ignore_ascii_case("referer"))
                {
                    headers.set("Referer", referrer);
                }
            }
            element.set_property("extra-headers", headers);
        }
    }

    fn create_player(payload: &NativeOpenRequest) -> Result<NativePlayer> {
        let source = Arc::new(RwLock::new(payload.clone()));
        let video_sink = gst::ElementFactory::make("d3d11videosink")
            .property("force-aspect-ratio", true)
            .property("sync", true)
            .property("enable-last-sample", false)
            .build()
            .map_err(|error| Error::Pipeline(format!("d3d11videosink is unavailable: {error}")))?;
        let overlay = video_sink
            .clone()
            .dynamic_cast::<VideoOverlay>()
            .map_err(|_| Error::Pipeline("d3d11videosink has no VideoOverlay interface".into()))?;
        let native_surface = surface()?;
        unsafe {
            overlay.set_window_handle(native_surface.child.0 as usize);
        }

        let buffer_duration_seconds = payload
            .max_buffer_ms
            .map(|value| f64::from(value.clamp(3_000, 120_000)) / 1_000.0);
        let target_buffer_bytes = payload
            .target_buffer_bytes
            .map(|value| value.clamp(4 * 1024 * 1024, i32::MAX as u64));
        let mut pipeline_builder = gst::ElementFactory::make("playbin3")
            .property("uri", &payload.uri)
            .property("video-sink", &video_sink);
        if let Some(seconds) = buffer_duration_seconds {
            pipeline_builder =
                pipeline_builder.property("buffer-duration", (seconds * 1_000_000_000.0) as i64);
        }
        if let Some(bytes) = target_buffer_bytes {
            pipeline_builder = pipeline_builder.property("buffer-size", bytes as i32);
        }
        let pipeline = pipeline_builder
            .build()
            .map_err(|error| Error::Pipeline(format!("playbin3 is unavailable: {error}")))?;
        let source_for_setup = Arc::clone(&source);
        pipeline.connect("source-setup", false, move |values| {
            if let Ok(element) = values[1].get::<gst::Element>() {
                configure_source(&element, &source_for_setup.read());
            }
            None
        });

        let mut player = NativePlayer {
            session_key: String::new(),
            pipeline,
            video_sink,
            overlay,
            source,
            buffering_percent: 0,
            buffer_duration_seconds,
            target_buffer_bytes,
            desired_playing: payload.autoplay,
            error: None,
            last_rendered: 0,
            region_frame_baseline: 0,
            region_applied_after_first_frame: false,
            last_sample_at: Instant::now(),
            measured_fps: 0.0,
            tracks: vec![],
            selected_streams: BTreeSet::new(),
        };
        load_source(&mut player, payload)?;
        Ok(player)
    }

    fn load_source(player: &mut NativePlayer, payload: &NativeOpenRequest) -> Result<()> {
        player
            .pipeline
            .set_state(gst::State::Ready)
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        let (transition, current, pending) =
            player.pipeline.state(Some(gst::ClockTime::from_seconds(5)));
        transition.map_err(|error| {
            Error::Pipeline(format!(
                "failed to park native pipeline before source change: {error}"
            ))
        })?;
        if current != gst::State::Ready {
            return Err(Error::Pipeline(format!(
                "native pipeline did not reach READY before source change (current: {current:?}, pending: {pending:?})"
            )));
        }
        if let Some(bus) = player.pipeline.bus() {
            while bus.pop().is_some() {}
        }

        *player.source.write() = payload.clone();
        let buffer_duration_seconds = payload
            .max_buffer_ms
            .map(|value| f64::from(value.clamp(3_000, 120_000)) / 1_000.0);
        let target_buffer_bytes = payload
            .target_buffer_bytes
            .map(|value| value.clamp(4 * 1024 * 1024, i32::MAX as u64));
        player.pipeline.set_property("uri", &payload.uri);
        player.pipeline.set_property(
            "buffer-duration",
            buffer_duration_seconds
                .map(|seconds| (seconds * 1_000_000_000.0) as i64)
                .unwrap_or(-1),
        );
        player.pipeline.set_property(
            "buffer-size",
            target_buffer_bytes.map(|bytes| bytes as i32).unwrap_or(-1),
        );
        player.pipeline.set_property(
            "volume",
            if payload.muted {
                0.0
            } else {
                payload.volume.clamp(0.0, 1.0)
            },
        );
        player.video_sink.set_property("force-aspect-ratio", true);
        place_surface(
            payload.x,
            payload.y,
            payload.width,
            payload.height,
            payload.surface_aperture.as_ref(),
            &payload.surface_overlays,
        )?;
        unsafe {
            player
                .overlay
                .set_window_handle(surface()?.child.0 as usize);
        }

        player.buffering_percent = 0;
        player.buffer_duration_seconds = buffer_duration_seconds;
        player.target_buffer_bytes = target_buffer_bytes;
        player.desired_playing = payload.autoplay;
        player.error = None;
        player.last_rendered = rendered_frames(&player.video_sink);
        player.region_frame_baseline = player.last_rendered;
        player.region_applied_after_first_frame = false;
        player.last_sample_at = Instant::now();
        player.measured_fps = 0.0;
        player.tracks.clear();
        player.selected_streams.clear();

        let state = if payload.autoplay {
            gst::State::Playing
        } else {
            gst::State::Paused
        };
        player
            .pipeline
            .set_state(state)
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        player.overlay.expose();
        refresh_surface_region(
            payload.x,
            payload.y,
            payload.surface_aperture.as_ref(),
            &payload.surface_overlays,
        )?;
        player.session_key.clone_from(&payload.session_key);
        Ok(())
    }

    fn rendered_frames(video_sink: &gst::Element) -> u64 {
        video_sink
            .property::<gst::Structure>("stats")
            .get::<u64>("rendered")
            .unwrap_or(0)
    }

    pub fn control(payload: NativeControlRequest) -> Result<NativePlaybackSnapshot> {
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let player = slot
                .as_mut()
                .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
            ensure_session(&player.session_key, &payload.session_key)?;
            match payload.action.as_str() {
                "play" => {
                    player.desired_playing = true;
                    player.region_frame_baseline = rendered_frames(&player.video_sink);
                    player.region_applied_after_first_frame = false;
                    player
                        .pipeline
                        .set_state(gst::State::Playing)
                        .map_err(|error| Error::Pipeline(error.to_string()))?;
                }
                "pause" => {
                    player.desired_playing = false;
                    player
                        .pipeline
                        .set_state(gst::State::Paused)
                        .map_err(|error| Error::Pipeline(error.to_string()))?;
                }
                "seek" => {
                    player
                        .pipeline
                        .seek_simple(
                            gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
                            gst::ClockTime::from_nseconds((payload.value.max(0.0) * 1e9) as u64),
                        )
                        .map_err(|error| Error::Pipeline(error.to_string()))?;
                }
                "volume" => player
                    .pipeline
                    .set_property("volume", payload.value.clamp(0.0, 1.0)),
                "fit" => player.video_sink.set_property("force-aspect-ratio", true),
                "crop" => player.video_sink.set_property("force-aspect-ratio", false),
                "stretch" => player.video_sink.set_property("force-aspect-ratio", false),
                "track" => select_stream(player, payload.index, true)?,
                "deselectTrack" => select_stream(player, payload.index, false)?,
                action => {
                    return Err(Error::InvalidRequest(format!(
                        "unsupported native action: {action}"
                    )))
                }
            }
            snapshot(player)
        })
    }

    pub fn layout(payload: NativeLayoutRequest) -> Result<()> {
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let player = slot
                .as_mut()
                .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
            ensure_session(&player.session_key, &payload.session_key)?;
            place_surface(
                payload.x,
                payload.y,
                payload.width,
                payload.height,
                payload.surface_aperture.as_ref(),
                &payload.surface_overlays,
            )?;
            player.overlay.expose();
            refresh_surface_region(
                payload.x,
                payload.y,
                payload.surface_aperture.as_ref(),
                &payload.surface_overlays,
            )?;
            let mut source = player.source.write();
            source.x = payload.x;
            source.y = payload.y;
            source.width = payload.width;
            source.height = payload.height;
            source.surface_aperture = payload.surface_aperture;
            source.surface_overlays = payload.surface_overlays;
            Ok(())
        })
    }

    pub fn stats(payload: NativeSessionRequest) -> Result<NativePlaybackSnapshot> {
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let player = slot
                .as_mut()
                .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
            ensure_session(&player.session_key, &payload.session_key)?;
            snapshot(player)
        })
    }

    pub fn close(payload: NativeSessionRequest) -> Result<()> {
        let owns_player = PLAYER.with(|slot| {
            slot.borrow()
                .as_ref()
                .is_some_and(|player| player.session_key == payload.session_key)
        });
        if owns_player {
            park_player()?;
        }
        Ok(())
    }

    fn park_player() -> Result<()> {
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let Some(player) = slot.as_mut() else {
                return Ok(());
            };
            player
                .pipeline
                .set_state(gst::State::Ready)
                .map_err(|error| Error::Pipeline(error.to_string()))?;
            hide_surface();
            player.session_key.clear();
            player.tracks.clear();
            player.selected_streams.clear();
            player.error = None;
            Ok(())
        })
    }

    fn ensure_session(active: &str, requested: &str) -> Result<()> {
        if active == requested {
            Ok(())
        } else {
            Err(Error::InvalidRequest(
                "native player session is stale".into(),
            ))
        }
    }

    fn snapshot(player: &mut NativePlayer) -> Result<NativePlaybackSnapshot> {
        drain_bus(player)?;
        let position = player
            .pipeline
            .query_position::<gst::ClockTime>()
            .map(|time| time.seconds_f64())
            .unwrap_or(0.0);
        let duration = player
            .pipeline
            .query_duration::<gst::ClockTime>()
            .map(|time| time.seconds_f64())
            .unwrap_or(0.0);
        let structure = player.video_sink.property::<gst::Structure>("stats");
        let rendered = structure.get::<u64>("rendered").unwrap_or(0);
        let dropped = structure.get::<u64>("dropped").unwrap_or(0);
        if !player.region_applied_after_first_frame && rendered > player.region_frame_baseline {
            let source = player.source.read().clone();
            refresh_surface_region(
                source.x,
                source.y,
                source.surface_aperture.as_ref(),
                &source.surface_overlays,
            )?;
            player.region_applied_after_first_frame = true;
        }
        let now = Instant::now();
        let elapsed = now.duration_since(player.last_sample_at).as_secs_f64();
        if elapsed >= 0.5 {
            player.measured_fps = rendered.saturating_sub(player.last_rendered) as f64 / elapsed;
            player.last_rendered = rendered;
            player.last_sample_at = now;
        }
        let (video_width, video_height) = player
            .video_sink
            .static_pad("sink")
            .and_then(|pad| pad.current_caps())
            .and_then(|caps| {
                caps.structure(0).map(|structure| {
                    (
                        structure.get::<i32>("width").unwrap_or(0).max(0) as u32,
                        structure.get::<i32>("height").unwrap_or(0).max(0) as u32,
                    )
                })
            })
            .unwrap_or((0, 0));
        Ok(NativePlaybackSnapshot {
            duration_seconds: duration,
            current_time_seconds: position,
            buffered_seconds: (position
                + player.buffer_duration_seconds.unwrap_or(0.0) * player.buffering_percent as f64
                    / 100.0)
                .min(duration.max(position)),
            playing: player.desired_playing,
            video_width,
            video_height,
            tracks: player.tracks.clone(),
            presented_frames: rendered,
            dropped_frames: dropped,
            measured_fps: player.measured_fps,
            hardware_backend: "gstreamer-d3d11-win32".into(),
            encoded_bytes_buffered: player.target_buffer_bytes.map_or(0, |target| {
                target.saturating_mul(player.buffering_percent.max(0) as u64) / 100
            }),
            average_frame_processing_us: 0.0,
        })
    }

    fn drain_bus(player: &mut NativePlayer) -> Result<()> {
        let Some(bus) = player.pipeline.bus() else {
            return Ok(());
        };
        while let Some(message) = bus.pop() {
            match message.view() {
                gst::MessageView::Buffering(buffering) => {
                    player.buffering_percent = buffering.percent();
                    let target = if player.desired_playing && player.buffering_percent >= 100 {
                        gst::State::Playing
                    } else {
                        gst::State::Paused
                    };
                    player
                        .pipeline
                        .set_state(target)
                        .map_err(|error| Error::Pipeline(error.to_string()))?;
                }
                gst::MessageView::StreamCollection(message) => {
                    let collection = message.stream_collection();
                    player.tracks.clear();
                    for index in 0..collection.size() {
                        let Some(stream) = collection.stream(index) else {
                            continue;
                        };
                        let stream_type = stream.stream_type();
                        let kind = if stream_type.contains(gst::StreamType::VIDEO) {
                            TrackKind::Video
                        } else if stream_type.contains(gst::StreamType::AUDIO) {
                            TrackKind::Audio
                        } else if stream_type.contains(gst::StreamType::TEXT) {
                            TrackKind::Subtitle
                        } else {
                            continue;
                        };
                        let id = stream
                            .stream_id()
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| format!("native-{index}"));
                        let tags = stream.tags();
                        let language = tags
                            .as_ref()
                            .and_then(|tags| tags.get::<gst::tags::LanguageCode>())
                            .map(|tag| tag.get().to_string())
                            .unwrap_or_default();
                        let label = tags
                            .as_ref()
                            .and_then(|tags| tags.get::<gst::tags::Title>())
                            .map(|tag| tag.get().to_string())
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| {
                                if language.is_empty() {
                                    format!("Track {}", index + 1)
                                } else {
                                    language.to_uppercase()
                                }
                            });
                        let codec = stream
                            .caps()
                            .and_then(|caps| {
                                caps.structure(0).map(|value| value.name().to_string())
                            })
                            .unwrap_or_default();
                        player.tracks.push(NativeTrackInfo {
                            id: id.clone(),
                            index: index as i32,
                            kind,
                            language,
                            label,
                            codec,
                            selected: player.selected_streams.contains(&id),
                        });
                    }
                }
                gst::MessageView::StreamsSelected(message) => {
                    player.selected_streams = message
                        .streams()
                        .filter_map(|stream| stream.stream_id().map(|id| id.to_string()))
                        .collect();
                    for track in &mut player.tracks {
                        track.selected = player.selected_streams.contains(&track.id);
                    }
                }
                gst::MessageView::Error(error) => {
                    let message =
                        format!("{}: {}", error.error(), error.debug().unwrap_or_default());
                    player.error = Some(message.clone());
                    return Err(Error::Pipeline(message));
                }
                _ => {}
            }
        }
        if let Some(error) = player.error.clone() {
            return Err(Error::Pipeline(error));
        }
        Ok(())
    }

    fn select_stream(player: &mut NativePlayer, index: i32, enabled: bool) -> Result<()> {
        let track = player
            .tracks
            .iter()
            .find(|track| track.index == index)
            .cloned()
            .ok_or_else(|| Error::InvalidRequest(format!("unknown native track index {index}")))?;
        player.selected_streams.retain(|id| {
            player
                .tracks
                .iter()
                .find(|item| &item.id == id)
                .is_some_and(|item| item.kind != track.kind)
        });
        if enabled {
            player.selected_streams.insert(track.id);
        }
        let ids: Vec<&str> = player.selected_streams.iter().map(String::as_str).collect();
        if !player
            .pipeline
            .send_event(gst::event::SelectStreams::new(ids))
        {
            return Err(Error::Pipeline("decoder rejected track selection".into()));
        }
        for item in &mut player.tracks {
            item.selected = player.selected_streams.contains(&item.id);
        }
        Ok(())
    }
}

#[cfg(not(feature = "gstreamer-runtime"))]
mod gstreamer {
    use tauri::{AppHandle, Runtime};

    use crate::{
        models::{
            NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
            NativeSessionRequest,
        },
        Error, Result,
    };

    fn unavailable<T>() -> Result<T> {
        Err(Error::RuntimeUnavailable(
            "Windows playback requires the gstreamer-runtime feature".into(),
        ))
    }

    pub fn open<R: Runtime>(
        _: &AppHandle<R>,
        _: NativeOpenRequest,
    ) -> Result<NativePlaybackSnapshot> {
        unavailable()
    }

    pub fn control(_: NativeControlRequest) -> Result<NativePlaybackSnapshot> {
        unavailable()
    }

    pub fn layout(_: NativeLayoutRequest) -> Result<()> {
        unavailable()
    }

    pub fn stats(_: NativeSessionRequest) -> Result<NativePlaybackSnapshot> {
        unavailable()
    }

    pub fn close(_: NativeSessionRequest) -> Result<()> {
        Ok(())
    }
}
