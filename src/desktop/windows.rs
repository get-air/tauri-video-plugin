use tauri::{AppHandle, Runtime};

use crate::{
    models::{
        NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
        NativeSessionRequest,
    },
    Error, Result,
};

#[cfg(feature = "gstreamer-runtime")]
mod dcomp;

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
    use super::dcomp;
    use std::{
        cell::RefCell,
        collections::BTreeSet,
        ffi::{c_char, c_void},
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, LazyLock, OnceLock,
        },
        time::Instant,
    };

    use gst::prelude::*;
    use gstreamer as gst;
    use parking_lot::{Mutex, RwLock};
    use tauri::{AppHandle, Manager, Runtime};

    use crate::{
        models::{
            NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
            NativeSessionRequest, NativeTrackInfo, TrackKind,
        },
        Error, Result,
    };

    static GST_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    static PRESENTER: LazyLock<RwLock<Option<Arc<Mutex<dcomp::DCompPresenter>>>>> =
        LazyLock::new(|| RwLock::new(None));

    thread_local! {
        static PLAYER: RefCell<Option<NativePlayer>> = const { RefCell::new(None) };
    }

    unsafe extern "C" {
        fn g_signal_emit_by_name(instance: *mut c_void, detailed_signal: *const c_char, ...);
    }

    struct NativePlayer {
        session_key: String,
        pipeline: gst::Element,
        video_sink: gst::Element,
        aspect_crop: gst::Element,
        source: Arc<RwLock<NativeOpenRequest>>,
        presented_frames: Arc<AtomicU64>,
        fit_mode: FitMode,
        buffering_percent: i32,
        buffer_duration_seconds: Option<f64>,
        target_buffer_bytes: Option<u64>,
        desired_playing: bool,
        error: Option<String>,
        last_rendered: u64,
        last_sample_at: Instant,
        measured_fps: f64,
        tracks: Vec<NativeTrackInfo>,
        selected_streams: BTreeSet<String>,
    }

    #[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
    enum FitMode {
        #[default]
        Fit,
        Cover,
        Stretch,
    }

    pub fn open<R: Runtime>(
        app: &AppHandle<R>,
        payload: NativeOpenRequest,
    ) -> Result<NativePlaybackSnapshot> {
        initialize_gstreamer()?;
        ensure_presenter(app, &payload)?;

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

    fn ensure_presenter<R: Runtime>(app: &AppHandle<R>, payload: &NativeOpenRequest) -> Result<()> {
        let window = app
            .webview_windows()
            .into_values()
            .next()
            .ok_or_else(|| Error::Pipeline("no Tauri webview window is available".into()))?;
        window
            .as_ref()
            .set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)))
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        let parent = window
            .hwnd()
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        if PRESENTER.read().is_none() {
            *PRESENTER.write() = Some(Arc::new(Mutex::new(dcomp::DCompPresenter::new(
                parent,
                payload.x.round() as i32,
                payload.y.round() as i32,
                payload.width.max(1.0).round() as u32,
                payload.height.max(1.0).round() as u32,
            )?)));
        }
        Ok(())
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
        let presented_frames = Arc::new(AtomicU64::new(0));
        let frame_counter = Arc::clone(&presented_frames);
        let presenter =
            PRESENTER.read().as_ref().cloned().ok_or_else(|| {
                Error::Pipeline("DirectComposition presenter is unavailable".into())
            })?;
        let video_sink = gst::ElementFactory::make("d3d11videosink")
            .property("draw-on-shared-texture", true)
            .property("force-aspect-ratio", true)
            .property("sync", true)
            .property("enable-last-sample", false)
            .build()
            .map_err(|error| Error::Pipeline(format!("d3d11videosink is unavailable: {error}")))?;
        video_sink.connect("begin-draw", false, move |values| {
            let Ok(sink) = values[0].get::<gst::Element>() else {
                return None;
            };
            let presenter = presenter.lock();
            let (handle, misc_flags) = presenter.shared_draw_info();
            let mut drawn = 0_i32;
            unsafe {
                g_signal_emit_by_name(
                    sink.as_ptr().cast(),
                    c"draw".as_ptr(),
                    handle,
                    misc_flags,
                    0_u64,
                    0_u64,
                    &mut drawn,
                );
            }
            if drawn != 0 {
                match presenter.present_shared() {
                    Ok(()) => {
                        frame_counter.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(error) => tracing::warn!(%error, "failed to present a D3D11 video frame"),
                }
            }
            None
        });
        let aspect_crop = gst::ElementFactory::make("aspectratiocrop")
            .property("aspect-ratio", gst::Fraction::new(0, 1))
            .build()
            .map_err(|error| Error::Pipeline(format!("aspectratiocrop is unavailable: {error}")))?;
        let sink_bin = gst::Bin::new();
        sink_bin
            .add_many([&aspect_crop, &video_sink])
            .and_then(|_| aspect_crop.link(&video_sink))
            .map_err(|error| {
                Error::Pipeline(format!("could not build the Windows video sink: {error}"))
            })?;
        let crop_sink_pad = aspect_crop
            .static_pad("sink")
            .ok_or_else(|| Error::Pipeline("aspectratiocrop has no sink pad".into()))?;
        let ghost = gst::GhostPad::builder_with_target(&crop_sink_pad)
            .map_err(|error| Error::Pipeline(error.to_string()))?
            .name("sink")
            .build();
        ghost
            .set_active(true)
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        sink_bin
            .add_pad(&ghost)
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        let pipeline_video_sink = sink_bin.upcast::<gst::Element>();

        let buffer_duration_seconds = payload
            .max_buffer_ms
            .map(|value| f64::from(value.clamp(3_000, 120_000)) / 1_000.0);
        let target_buffer_bytes = payload
            .target_buffer_bytes
            .map(|value| value.clamp(4 * 1024 * 1024, i32::MAX as u64));
        let mut pipeline_builder = gst::ElementFactory::make("playbin3")
            .property("uri", &payload.uri)
            .property("video-sink", &pipeline_video_sink);
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
            aspect_crop,
            source,
            presented_frames,
            fit_mode: FitMode::Fit,
            buffering_percent: 0,
            buffer_duration_seconds,
            target_buffer_bytes,
            desired_playing: payload.autoplay,
            error: None,
            last_rendered: 0,
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
        player.buffering_percent = 0;
        player.buffer_duration_seconds = buffer_duration_seconds;
        player.target_buffer_bytes = target_buffer_bytes;
        player.desired_playing = payload.autoplay;
        player.error = None;
        player.presented_frames.store(0, Ordering::Relaxed);
        player.last_rendered = 0;
        player.last_sample_at = Instant::now();
        player.measured_fps = 0.0;
        player.tracks.clear();
        player.selected_streams.clear();
        set_fit_mode(player, FitMode::Fit)?;
        if let Some(presenter) = PRESENTER.read().as_ref().cloned() {
            presenter.lock().reset()?;
        }

        let state = if payload.autoplay {
            gst::State::Playing
        } else {
            gst::State::Paused
        };
        player
            .pipeline
            .set_state(state)
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        player.session_key.clone_from(&payload.session_key);
        Ok(())
    }

    fn active_video_decoder(pipeline: &gst::Element) -> String {
        let Some(bin) = pipeline.dynamic_cast_ref::<gst::Bin>() else {
            return "unknown-decoder".into();
        };
        bin.iterate_recurse()
            .into_iter()
            .filter_map(std::result::Result::ok)
            .find(|element| {
                element.factory().is_some_and(|factory| {
                    factory
                        .metadata("klass")
                        .is_some_and(|klass| klass.contains("Decoder/Video"))
                })
            })
            .map(|element| element.name().to_string())
            .unwrap_or_else(|| "unknown-decoder".into())
    }

    fn set_fit_mode(player: &mut NativePlayer, mode: FitMode) -> Result<()> {
        player.fit_mode = mode;
        player
            .video_sink
            .set_property("force-aspect-ratio", mode != FitMode::Stretch);
        if mode == FitMode::Cover {
            let source = player.source.read();
            update_crop_aspect(player, source.width, source.height);
        } else {
            player
                .aspect_crop
                .set_property("aspect-ratio", gst::Fraction::new(0, 1));
        }
        Ok(())
    }

    fn update_crop_aspect(player: &NativePlayer, width: f64, height: f64) {
        let width = width.round().clamp(1.0, i32::MAX as f64) as i32;
        let height = height.round().clamp(1.0, i32::MAX as f64) as i32;
        player
            .aspect_crop
            .set_property("aspect-ratio", gst::Fraction::new(width, height));
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
                "fit" => set_fit_mode(player, FitMode::Fit)?,
                "crop" => set_fit_mode(player, FitMode::Cover)?,
                "stretch" => set_fit_mode(player, FitMode::Stretch)?,
                "zoom" => {
                    if let Some(presenter) = PRESENTER.read().as_ref().cloned() {
                        presenter
                            .lock()
                            .set_zoom(payload.value.clamp(1.0, 2.0) as f32)?;
                    }
                }
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
            if let Some(presenter) = PRESENTER.read().as_ref().cloned() {
                presenter.lock().place(
                    payload.x.round() as i32,
                    payload.y.round() as i32,
                    payload.width.max(1.0).round() as u32,
                    payload.height.max(1.0).round() as u32,
                )?;
            }
            if player.fit_mode == FitMode::Cover {
                update_crop_aspect(player, payload.width, payload.height);
            }
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
        let rendered = player.presented_frames.load(Ordering::Relaxed);
        let dropped = structure.get::<u64>("dropped").unwrap_or(0);
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
            hardware_backend: format!(
                "gstreamer:{}:d3d11-dcomp-win32",
                active_video_decoder(&player.pipeline)
            ),
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

    pub fn frame_stream(
        _: String,
        _: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    ) -> Result<()> {
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
