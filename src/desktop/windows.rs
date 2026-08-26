use tauri::{AppHandle, Runtime};

use crate::{
    models::{
        NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
        NativeSessionRequest,
    },
    Error, Result,
};

#[cfg(feature = "gstreamer-runtime")]
mod texture_stream;

pub fn prepare_texture_stream<R: Runtime>(app: &AppHandle<R>, stream_id: String) -> Result<()> {
    gstreamer::prepare_texture_stream(app, stream_id)
}

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
    use super::texture_stream;
    use std::{
        cell::RefCell,
        collections::BTreeSet,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, LazyLock, OnceLock,
        },
        time::{Duration, Instant},
    };

    use gst::prelude::*;
    use gstreamer as gst;
    use gstreamer_app::{AppSink, AppSinkCallbacks};
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
    static PRESENTER: LazyLock<RwLock<Option<Arc<Mutex<texture_stream::TextureStreamPresenter>>>>> =
        LazyLock::new(|| RwLock::new(None));
    static PRESENTER_GENERATION: AtomicU64 = AtomicU64::new(0);

    thread_local! {
        static PLAYER: RefCell<Option<NativePlayer>> = const { RefCell::new(None) };
    }

    struct NativePlayer {
        session_key: String,
        pipeline: gst::Element,
        video_sink: gst::Element,
        source: Arc<RwLock<NativeOpenRequest>>,
        presented_frames: Arc<AtomicU64>,
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
        presenter_generation: u64,
    }

    pub fn open<R: Runtime>(
        app: &AppHandle<R>,
        payload: NativeOpenRequest,
    ) -> Result<NativePlaybackSnapshot> {
        initialize_gstreamer()?;
        let _ = app;
        if PRESENTER.read().is_none() {
            return Err(Error::Pipeline(
                "WebView2 texture stream was not prepared before native_open".into(),
            ));
        }

        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let generation = PRESENTER_GENERATION.load(Ordering::Acquire);
            if let Some(player) = slot
                .as_mut()
                .filter(|player| player.presenter_generation == generation)
            {
                load_source(player, &payload)?;
                return snapshot(player);
            }

            if let Some(player) = slot.as_mut() {
                player
                    .pipeline
                    .set_state(gst::State::Ready)
                    .map_err(|error| Error::Pipeline(error.to_string()))?;
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

    pub fn prepare_texture_stream<R: Runtime>(app: &AppHandle<R>, stream_id: String) -> Result<()> {
        initialize_gstreamer()?;
        gst::Plugin::load_by_name("d3d11")
            .map_err(|error| Error::RuntimeUnavailable(error.to_string()))?;
        let window = app
            .webview_windows()
            .into_values()
            .next()
            .ok_or_else(|| Error::Pipeline("no Tauri webview window is available".into()))?;
        let app_context = app.clone();
        let dispatch: texture_stream::UiDispatch = Arc::new(move |job| {
            app_context
                .run_on_main_thread(job)
                .map_err(|error| Error::Pipeline(error.to_string()))
        });
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        window
            .with_webview(move |webview| {
                let result = texture_stream::TextureStreamPresenter::new(
                    &webview.environment(),
                    &stream_id,
                    dispatch,
                );
                let _ = sender.send(result);
            })
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        let presenter = receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| {
                Error::Pipeline(format!("WebView2 texture stream timed out: {error}"))
            })??;
        *PRESENTER.write() = Some(Arc::new(Mutex::new(presenter)));
        PRESENTER_GENERATION.fetch_add(1, Ordering::Release);
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

    fn present_texture_sample(
        sample: &gst::Sample,
        presenter: &Arc<Mutex<texture_stream::TextureStreamPresenter>>,
        frame_counter: &AtomicU64,
    ) -> std::result::Result<gst::FlowSuccess, gst::FlowError> {
        let caps = sample.caps().ok_or(gst::FlowError::NotNegotiated)?;
        let structure = caps.structure(0).ok_or(gst::FlowError::NotNegotiated)?;
        let width = structure.get::<i32>("width").unwrap_or(0).max(0) as u32;
        let height = structure.get::<i32>("height").unwrap_or(0).max(0) as u32;
        if width == 0 || height == 0 {
            return Err(gst::FlowError::NotNegotiated);
        }
        static PRESENTATION_CLOCK: LazyLock<Instant> = LazyLock::new(Instant::now);
        let timestamp = PRESENTATION_CLOCK
            .elapsed()
            .as_micros()
            .min(u128::from(u64::MAX)) as u64;
        let mut presenter = presenter.lock();
        let Some(target) = presenter
            .acquire(width, height)
            .map_err(|_| gst::FlowError::Error)?
        else {
            return Ok(gst::FlowSuccess::Ok);
        };
        presenter
            .copy_sample(sample, &target)
            .and_then(|_| presenter.present(target, timestamp))
            .map_err(|_| gst::FlowError::Error)?;
        frame_counter.fetch_add(1, Ordering::Relaxed);
        Ok(gst::FlowSuccess::Ok)
    }

    fn create_player(payload: &NativeOpenRequest) -> Result<NativePlayer> {
        let source = Arc::new(RwLock::new(payload.clone()));
        let presented_frames = Arc::new(AtomicU64::new(0));
        let presenter = PRESENTER
            .read()
            .as_ref()
            .cloned()
            .ok_or_else(|| Error::Pipeline("WebView2 texture stream is unavailable".into()))?;
        let gst_context = presenter.lock().gst_context();
        let gpu_color_conversion = presenter.lock().supports_gpu_color_conversion();
        let caps = gst::Caps::builder("video/x-raw")
            .field("format", "NV12")
            .features(["memory:D3D11Memory"])
            .build();
        let sample_presenter = Arc::clone(&presenter);
        let sample_counter = Arc::clone(&presented_frames);
        let preroll_presenter = Arc::clone(&presenter);
        let preroll_counter = Arc::clone(&presented_frames);
        let app_sink = AppSink::builder()
            .caps(&caps)
            .sync(true)
            .max_buffers(4)
            .drop(true)
            .enable_last_sample(false)
            .callbacks(
                AppSinkCallbacks::builder()
                    .new_sample(move |sink| {
                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        present_texture_sample(&sample, &sample_presenter, &sample_counter)
                    })
                    .new_preroll(move |sink| {
                        let sample = sink.pull_preroll().map_err(|_| gst::FlowError::Eos)?;
                        present_texture_sample(&sample, &preroll_presenter, &preroll_counter)
                    })
                    .build(),
            )
            .build();
        let video_sink = app_sink.clone().upcast::<gst::Element>();
        let upload = gst::ElementFactory::make("d3d11upload")
            .build()
            .map_err(|error| Error::Pipeline(format!("d3d11upload is unavailable: {error}")))?;
        let sink_bin = gst::Bin::new();
        let first = if gpu_color_conversion {
            let convert = gst::ElementFactory::make("d3d11convert")
                .build()
                .map_err(|error| {
                    Error::Pipeline(format!("d3d11convert is unavailable: {error}"))
                })?;
            sink_bin
                .add_many([&upload, &convert, &video_sink])
                .and_then(|_| gst::Element::link_many([&upload, &convert, &video_sink]))
                .map_err(|error| {
                    Error::Pipeline(format!(
                        "could not build the GPU Windows video sink: {error}"
                    ))
                })?;
            upload.clone()
        } else {
            let convert = gst::ElementFactory::make("videoconvert")
                .build()
                .map_err(|error| {
                    Error::Pipeline(format!("videoconvert is unavailable: {error}"))
                })?;
            let system_caps = gst::Caps::builder("video/x-raw")
                .field("format", "NV12")
                .build();
            let caps_filter = gst::ElementFactory::make("capsfilter")
                .property("caps", &system_caps)
                .build()
                .map_err(|error| Error::Pipeline(format!("capsfilter is unavailable: {error}")))?;
            sink_bin
                .add_many([&convert, &caps_filter, &upload, &video_sink])
                .and_then(|_| {
                    gst::Element::link_many([&convert, &caps_filter, &upload, &video_sink])
                })
                .map_err(|error| {
                    Error::Pipeline(format!(
                        "could not build the software Windows video sink: {error}"
                    ))
                })?;
            convert
        };
        let first_sink_pad = first
            .static_pad("sink")
            .ok_or_else(|| Error::Pipeline("Windows video conversion has no sink pad".into()))?;
        let ghost = gst::GhostPad::builder_with_target(&first_sink_pad)
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
        pipeline.set_context(&gst_context);
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
            source,
            presented_frames,
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
            presenter_generation: PRESENTER_GENERATION.load(Ordering::Acquire),
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

    fn playback_timeline(pipeline: &gst::Element, duration: f64) -> (bool, bool, f64, f64) {
        let mut latency = gst::query::Latency::new();
        let live = duration <= 0.0 || (pipeline.query(latency.query_mut()) && latency.result().0);
        let mut seeking = gst::query::Seeking::new(gst::Format::Time);
        if !pipeline.query(seeking.query_mut()) {
            return (live, !live, 0.0, duration);
        }
        let (seekable, start, end) = seeking.result();
        let seconds = |value: gst::GenericFormattedValue| match value {
            gst::GenericFormattedValue::Time(Some(time)) => time.seconds_f64(),
            _ => 0.0,
        };
        (live, seekable, seconds(start), seconds(end))
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
                "fit" | "crop" | "stretch" | "zoom" => {}
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
            let mut source = player.source.write();
            source.x = payload.x;
            source.y = payload.y;
            source.width = payload.width;
            source.height = payload.height;
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
        let (live, seekable, seekable_start, seekable_end) =
            playback_timeline(&player.pipeline, duration);
        let buffered = position
            + player.buffer_duration_seconds.unwrap_or(0.0) * player.buffering_percent as f64
                / 100.0;
        let buffered = if live {
            buffered.max(position)
        } else {
            buffered.min(duration.max(position))
        };
        let seekable_end = if seekable_end > seekable_start {
            seekable_end
        } else {
            duration.max(buffered)
        };
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
            buffered_seconds: buffered,
            live,
            seekable,
            seekable_start_seconds: seekable_start,
            seekable_end_seconds: seekable_end,
            playing: player.desired_playing,
            video_width,
            video_height,
            tracks: player.tracks.clone(),
            presented_frames: rendered,
            dropped_frames: dropped,
            measured_fps: player.measured_fps,
            hardware_backend: format!(
                "gstreamer:{}:d3d11-webview2-texture-stream",
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

    pub fn prepare_texture_stream<R: Runtime>(_: &AppHandle<R>, _: String) -> Result<()> {
        unavailable()
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
