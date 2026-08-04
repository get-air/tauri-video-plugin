use serde::de::DeserializeOwned;
use std::{sync::mpsc, time::Duration};
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{
    NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<DesktopVideo<R>> {
    Ok(DesktopVideo { app: app.clone() })
}

pub struct DesktopVideo<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> DesktopVideo<R> {
    #[cfg(target_os = "linux")]
    pub fn open_native(&self, payload: NativeOpenRequest) -> crate::Result<NativePlaybackSnapshot> {
        self.run_on_main(move |app| linux::open(app, payload))
    }

    #[cfg(target_os = "linux")]
    pub fn control_native(
        &self,
        payload: NativeControlRequest,
    ) -> crate::Result<NativePlaybackSnapshot> {
        self.run_on_main(move |_| linux::control(payload))
    }

    #[cfg(target_os = "linux")]
    pub fn layout_native(&self, payload: NativeLayoutRequest) -> crate::Result<()> {
        self.run_on_main(move |_| linux::layout(payload))
    }

    #[cfg(target_os = "linux")]
    pub fn stats_native(&self) -> crate::Result<NativePlaybackSnapshot> {
        self.run_on_main(move |_| linux::stats())
    }

    #[cfg(target_os = "linux")]
    pub fn close_native(&self) -> crate::Result<()> {
        self.run_on_main(move |_| linux::close())
    }

    #[cfg(target_os = "linux")]
    fn run_on_main<T, F>(&self, operation: F) -> crate::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&AppHandle<R>) -> crate::Result<T> + Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(1);
        let context = self.app.clone();
        self.app
            .run_on_main_thread(move || {
                let _ = sender.send(operation(&context));
            })
            .map_err(|error| crate::Error::Pipeline(error.to_string()))?;
        receiver
            .recv_timeout(Duration::from_secs(15))
            .map_err(|error| {
                crate::Error::Pipeline(format!("native UI thread timed out: {error}"))
            })?
    }

    #[cfg(not(target_os = "linux"))]
    fn unsupported<T>(&self) -> crate::Result<T> {
        Err(crate::Error::InvalidRequest(
            "native desktop surfaces are currently implemented on Linux".into(),
        ))
    }

    #[cfg(not(target_os = "linux"))]
    pub fn open_native(&self, _: NativeOpenRequest) -> crate::Result<NativePlaybackSnapshot> {
        self.unsupported()
    }

    #[cfg(not(target_os = "linux"))]
    pub fn control_native(&self, _: NativeControlRequest) -> crate::Result<NativePlaybackSnapshot> {
        self.unsupported()
    }

    #[cfg(not(target_os = "linux"))]
    pub fn layout_native(&self, _: NativeLayoutRequest) -> crate::Result<()> {
        self.unsupported()
    }

    #[cfg(not(target_os = "linux"))]
    pub fn stats_native(&self) -> crate::Result<NativePlaybackSnapshot> {
        self.unsupported()
    }

    #[cfg(not(target_os = "linux"))]
    pub fn close_native(&self) -> crate::Result<()> {
        self.unsupported()
    }
}

#[cfg(all(target_os = "linux", feature = "gstreamer-runtime"))]
mod linux {
    use std::{cell::RefCell, collections::BTreeSet, time::Instant};

    use gst::glib::translate::ToGlibPtr as GstToGlibPtr;
    use gst::prelude::ObjectExt as GstObjectExt;
    use gst::prelude::*;
    use gstreamer as gst;
    use gtk::prelude::*;
    use tauri::{AppHandle, Manager, Runtime};

    use crate::{
        models::{
            NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
            NativeTrackInfo, TrackKind, VideoSource,
        },
        pipeline::configure_source,
        Error, Result,
    };

    thread_local! {
        static HOST: RefCell<Option<SurfaceHost>> = const { RefCell::new(None) };
        static PLAYER: RefCell<Option<NativePlayer>> = const { RefCell::new(None) };
    }

    struct SurfaceHost {
        fixed: gtk::Fixed,
    }

    struct NativePlayer {
        pipeline: gst::Element,
        gtk_sink: gst::Element,
        widget: gtk::Widget,
        buffering_percent: i32,
        error: Option<String>,
        last_rendered: u64,
        last_sample_at: Instant,
        measured_fps: f64,
        tracks: Vec<NativeTrackInfo>,
        selected_streams: BTreeSet<String>,
    }

    pub fn open<R: Runtime>(
        app: &AppHandle<R>,
        payload: NativeOpenRequest,
    ) -> Result<NativePlaybackSnapshot> {
        close()?;
        crate::runtime::initialize()?;
        ensure_host(app)?;

        let gtk_sink = gst::ElementFactory::make("gtkglsink")
            .property("force-aspect-ratio", true)
            .property("sync", true)
            .build()
            .map_err(|error| Error::Pipeline(format!("gtkglsink is unavailable: {error}")))?;
        let gl_sink = gst::ElementFactory::make("glsinkbin")
            .property("sink", &gtk_sink)
            .build()
            .map_err(|error| Error::Pipeline(format!("glsinkbin is unavailable: {error}")))?;
        let buffer_duration_ns = i64::from(payload.max_buffer_ms.unwrap_or(20_000)) * 1_000_000;
        let ring_buffer_bytes = payload.target_buffer_bytes.unwrap_or(128 * 1024 * 1024);
        let pipeline = gst::ElementFactory::make("playbin3")
            .property("uri", &payload.uri)
            .property("video-sink", &gl_sink)
            .property("buffer-duration", buffer_duration_ns)
            .property("ring-buffer-max-size", ring_buffer_bytes)
            .build()
            .map_err(|error| Error::Pipeline(format!("playbin3 is unavailable: {error}")))?;

        let source = VideoSource {
            uri: payload.uri.clone(),
            headers: payload.headers,
            cookies: payload.cookies,
            user_agent: payload.user_agent,
            referrer: payload.referrer,
            tls_ca_file: payload.tls_ca_file,
            start_position_seconds: None,
        };
        pipeline.connect("source-setup", false, move |values| {
            if let Ok(element) = values[1].get::<gst::Element>() {
                configure_source(&element, &source);
            }
            None
        });

        let widget_object = gtk_sink.property::<gst::glib::Object>("widget");
        let widget_pointer: *mut gst::glib::gobject_ffi::GObject = widget_object.to_glib_none().0;
        let widget: gtk::Widget = unsafe {
            gtk::glib::translate::from_glib_none(widget_pointer as *mut gtk::ffi::GtkWidget)
        };
        widget.set_hexpand(false);
        widget.set_vexpand(false);
        place_widget(&widget, payload.x, payload.y, payload.width, payload.height)?;

        let state = if payload.autoplay {
            gst::State::Playing
        } else {
            gst::State::Paused
        };
        pipeline
            .set_state(state)
            .map_err(|error| Error::Pipeline(error.to_string()))?;

        let player = NativePlayer {
            pipeline,
            gtk_sink,
            widget,
            buffering_percent: 0,
            error: None,
            last_rendered: 0,
            last_sample_at: Instant::now(),
            measured_fps: 0.0,
            tracks: vec![],
            selected_streams: BTreeSet::new(),
        };
        PLAYER.with(|slot| *slot.borrow_mut() = Some(player));
        stats()
    }

    pub fn control(payload: NativeControlRequest) -> Result<NativePlaybackSnapshot> {
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let player = slot
                .as_mut()
                .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
            match payload.action.as_str() {
                "play" => {
                    player
                        .pipeline
                        .set_state(gst::State::Playing)
                        .map_err(|error| Error::Pipeline(error.to_string()))?;
                }
                "pause" => {
                    player
                        .pipeline
                        .set_state(gst::State::Paused)
                        .map_err(|error| Error::Pipeline(error.to_string()))?;
                }
                "seek" => {
                    player
                        .pipeline
                        .seek_simple(
                            gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                            gst::ClockTime::from_nseconds((payload.value.max(0.0) * 1e9) as u64),
                        )
                        .map_err(|error| Error::Pipeline(error.to_string()))?;
                }
                "volume" => {
                    player
                        .pipeline
                        .set_property("volume", payload.value.clamp(0.0, 1.0));
                }
                "fit" => {
                    player.gtk_sink.set_property("force-aspect-ratio", true);
                }
                "crop" => {
                    player.gtk_sink.set_property("force-aspect-ratio", false);
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
            let slot = slot.borrow();
            let player = slot
                .as_ref()
                .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
            place_widget(
                &player.widget,
                payload.x,
                payload.y,
                payload.width,
                payload.height,
            )
        })
    }

    pub fn stats() -> Result<NativePlaybackSnapshot> {
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let player = slot
                .as_mut()
                .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
            snapshot(player)
        })
    }

    pub fn close() -> Result<()> {
        let player = PLAYER.with(|slot| slot.borrow_mut().take());
        if let Some(player) = player {
            let _ = player.pipeline.set_state(gst::State::Null);
            HOST.with(|host| {
                if let Some(host) = host.borrow().as_ref() {
                    host.fixed.remove(&player.widget);
                }
            });
        }
        Ok(())
    }

    fn ensure_host<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
        HOST.with(|slot| {
            if slot.borrow().is_some() {
                return Ok(());
            }
            let window =
                app.webview_windows().into_values().next().ok_or_else(|| {
                    Error::Pipeline("no Tauri webview window is available".into())
                })?;
            let gtk_window = window
                .gtk_window()
                .map_err(|error| Error::Pipeline(error.to_string()))?;
            let child = gtk_window
                .child()
                .ok_or_else(|| Error::Pipeline("Tauri GTK window has no webview child".into()))?;
            gtk_window.remove(&child);

            let overlay = gtk::Overlay::new();
            overlay.set_hexpand(true);
            overlay.set_vexpand(true);
            let fixed = gtk::Fixed::new();
            fixed.set_hexpand(true);
            fixed.set_vexpand(true);
            child.set_hexpand(true);
            child.set_vexpand(true);
            overlay.add(&fixed);
            overlay.add_overlay(&child);
            gtk_window.add(&overlay);
            gtk_window.show_all();
            *slot.borrow_mut() = Some(SurfaceHost { fixed });
            Ok(())
        })
    }

    fn place_widget(widget: &gtk::Widget, x: f64, y: f64, width: f64, height: f64) -> Result<()> {
        let x = x.max(0.0).round() as i32;
        let y = y.max(0.0).round() as i32;
        let width = width.max(1.0).round() as i32;
        let height = height.max(1.0).round() as i32;
        HOST.with(|host| {
            let host = host.borrow();
            let host = host
                .as_ref()
                .ok_or_else(|| Error::Pipeline("native surface host is unavailable".into()))?;
            if widget.parent().is_none() {
                host.fixed.put(widget, x, y);
            } else {
                host.fixed.move_(widget, x, y);
            }
            widget.set_size_request(width, height);
            widget.show();
            Ok(())
        })
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
        let structure = player.gtk_sink.property::<gst::Structure>("stats");
        let rendered = structure.get::<u64>("rendered").unwrap_or(0);
        let dropped = structure.get::<u64>("dropped").unwrap_or(0);
        let now = Instant::now();
        let elapsed = now.duration_since(player.last_sample_at).as_secs_f64();
        if elapsed >= 0.5 {
            player.measured_fps = rendered.saturating_sub(player.last_rendered) as f64 / elapsed;
            player.last_rendered = rendered;
            player.last_sample_at = now;
            if std::env::var_os("TAURI_VIDEO_TELEMETRY").is_some() {
                eprintln!(
                    "video telemetry: presented={rendered} dropped={dropped} fps={:.2} position={position:.2}s",
                    player.measured_fps,
                );
            }
        }
        let (video_width, video_height) = player
            .gtk_sink
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
        let playing = player.pipeline.current_state() == gst::State::Playing;
        Ok(NativePlaybackSnapshot {
            duration_seconds: duration,
            current_time_seconds: position,
            buffered_seconds: (position + 20.0 * player.buffering_percent as f64 / 100.0)
                .min(duration.max(position)),
            playing,
            video_width,
            video_height,
            tracks: player.tracks.clone(),
            presented_frames: rendered,
            dropped_frames: dropped,
            measured_fps: player.measured_fps,
            hardware_backend: "gstreamer-va-gl-gtk".into(),
            encoded_bytes_buffered: 0,
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
                    if std::env::var_os("TAURI_VIDEO_TELEMETRY").is_some() {
                        eprintln!("video streams discovered: {}", player.tracks.len());
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
                    if std::env::var_os("TAURI_VIDEO_TELEMETRY").is_some() {
                        eprintln!("video streams selected: {}", player.selected_streams.len());
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

#[cfg(all(target_os = "linux", not(feature = "gstreamer-runtime")))]
mod linux {
    use tauri::{AppHandle, Runtime};

    use crate::{
        models::{
            NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
        },
        Error, Result,
    };

    fn unavailable<T>() -> Result<T> {
        Err(Error::RuntimeUnavailable(
            "Linux native playback requires the gstreamer-runtime feature".into(),
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
    pub fn stats() -> Result<NativePlaybackSnapshot> {
        unavailable()
    }
    pub fn close() -> Result<()> {
        Ok(())
    }
}
