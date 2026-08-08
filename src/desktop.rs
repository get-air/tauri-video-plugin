use serde::de::DeserializeOwned;
use std::{sync::mpsc, time::Duration};
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{
    NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
    NativeSessionRequest,
};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<DesktopVideo<R>> {
    #[cfg(target_os = "linux")]
    {
        #[allow(deprecated)]
        let (main_sender, main_receiver) =
            gtk::glib::MainContext::sync_channel::<MainJob<R>>(gtk::glib::Priority::DEFAULT, 32);
        let context = app.clone();
        main_receiver.attach(None, move |job| {
            job(&context);
            gtk::glib::ControlFlow::Continue
        });
        Ok(DesktopVideo {
            _app: app.clone(),
            main_sender,
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(DesktopVideo { _app: app.clone() })
    }
}

#[cfg(target_os = "linux")]
type MainJob<R> = Box<dyn FnOnce(&AppHandle<R>) + Send + 'static>;

pub struct DesktopVideo<R: Runtime> {
    _app: AppHandle<R>,
    #[cfg(target_os = "linux")]
    main_sender: gtk::glib::SyncSender<MainJob<R>>,
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
        // The WebView publishes its matching transparent aperture after this
        // command resolves, so completion must mean GTK received the move.
        // The guest serializes layout calls, keeping this dispatcher bounded.
        self.run_on_main(move |_| linux::layout(payload))
    }

    #[cfg(target_os = "linux")]
    pub fn stats_native(
        &self,
        payload: NativeSessionRequest,
    ) -> crate::Result<NativePlaybackSnapshot> {
        self.run_on_main(move |_| linux::stats(payload))
    }

    #[cfg(target_os = "linux")]
    pub fn close_native(&self, payload: NativeSessionRequest) -> crate::Result<()> {
        self.run_on_main(move |_| linux::close(payload))
    }

    #[cfg(target_os = "linux")]
    fn run_on_main<T, F>(&self, operation: F) -> crate::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&AppHandle<R>) -> crate::Result<T> + Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.main_sender
            .send(Box::new(move |context| {
                let _ = sender.send(operation(context));
            }))
            .map_err(|error| {
                crate::Error::Pipeline(format!("native UI dispatcher is unavailable: {error}"))
            })?;
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
    pub fn stats_native(&self, _: NativeSessionRequest) -> crate::Result<NativePlaybackSnapshot> {
        self.unsupported()
    }

    #[cfg(not(target_os = "linux"))]
    pub fn close_native(&self, _: NativeSessionRequest) -> crate::Result<()> {
        self.unsupported()
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::cell::RefCell;

    use tauri::{AppHandle, Runtime};

    use crate::{
        models::{
            NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
            NativeSessionRequest,
        },
        Error, Result,
    };

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Backend {
        Gstreamer,
        Mpv,
    }

    thread_local! {
        static ACTIVE_BACKEND: RefCell<Option<Backend>> = const { RefCell::new(None) };
    }

    pub fn open<R: Runtime>(
        app: &AppHandle<R>,
        payload: NativeOpenRequest,
    ) -> Result<NativePlaybackSnapshot> {
        let requested = select_backend(payload.backend.as_deref())?;
        let previous = ACTIVE_BACKEND.with(|active| *active.borrow());
        if previous != Some(requested) {
            match previous {
                Some(Backend::Gstreamer) => super::linux_gstreamer::force_close()?,
                Some(Backend::Mpv) => super::linux_mpv::force_close()?,
                None => {}
            }
            // The old player is gone. If the replacement fails to open,
            // controls must not continue routing to a stale backend.
            ACTIVE_BACKEND.with(|active| *active.borrow_mut() = None);
        }
        let result = match requested {
            Backend::Gstreamer => super::linux_gstreamer::open(app, payload),
            Backend::Mpv => super::linux_mpv::open(app, payload),
        };
        if result.is_ok() {
            ACTIVE_BACKEND.with(|active| *active.borrow_mut() = Some(requested));
        }
        result
    }

    pub fn control(payload: NativeControlRequest) -> Result<NativePlaybackSnapshot> {
        match active_backend()? {
            Backend::Gstreamer => super::linux_gstreamer::control(payload),
            Backend::Mpv => super::linux_mpv::control(payload),
        }
    }

    pub fn layout(payload: NativeLayoutRequest) -> Result<()> {
        match active_backend()? {
            Backend::Gstreamer => super::linux_gstreamer::layout(payload),
            Backend::Mpv => super::linux_mpv::layout(payload),
        }
    }

    pub fn stats(payload: NativeSessionRequest) -> Result<NativePlaybackSnapshot> {
        match active_backend()? {
            Backend::Gstreamer => super::linux_gstreamer::stats(payload),
            Backend::Mpv => super::linux_mpv::stats(payload),
        }
    }

    pub fn close(payload: NativeSessionRequest) -> Result<()> {
        let backend = active_backend()?;
        let owns_session = match backend {
            Backend::Gstreamer => super::linux_gstreamer::owns_session(&payload.session_key),
            Backend::Mpv => super::linux_mpv::owns_session(&payload.session_key),
        };
        if !owns_session {
            return Ok(());
        }
        let result = match backend {
            Backend::Gstreamer => super::linux_gstreamer::close(payload),
            Backend::Mpv => super::linux_mpv::close(payload),
        };
        if result.is_ok() {
            ACTIVE_BACKEND.with(|active| *active.borrow_mut() = None);
        }
        result
    }

    fn active_backend() -> Result<Backend> {
        ACTIVE_BACKEND
            .with(|active| *active.borrow())
            .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))
    }

    fn select_backend(requested: Option<&str>) -> Result<Backend> {
        match requested.unwrap_or("auto") {
            "auto" if cfg!(feature = "gstreamer-runtime") => Ok(Backend::Gstreamer),
            "gstreamer" if cfg!(feature = "gstreamer-runtime") => Ok(Backend::Gstreamer),
            "mpv" if cfg!(feature = "mpv-runtime") => Ok(Backend::Mpv),
            "gstreamer" => Err(Error::RuntimeUnavailable(
                "the gstreamer backend was not compiled; enable gstreamer-runtime".into(),
            )),
            "mpv" => Err(Error::RuntimeUnavailable(
                "the mpv backend was not compiled; enable mpv-runtime".into(),
            )),
            "auto" => Err(Error::RuntimeUnavailable(
                "the default gstreamer backend was not compiled; request 'mpv' explicitly or enable gstreamer-runtime".into(),
            )),
            backend => Err(Error::InvalidRequest(format!(
                "backend '{backend}' is not available on Linux"
            ))),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn explicit_mobile_backend_is_rejected_on_linux() {
            assert!(select_backend(Some("libvlc")).is_err());
        }

        #[cfg(feature = "gstreamer-runtime")]
        #[test]
        fn auto_selects_gstreamer() {
            assert_eq!(select_backend(Some("auto")).unwrap(), Backend::Gstreamer);
        }

        #[cfg(feature = "mpv-runtime")]
        #[test]
        fn mpv_requires_an_explicit_request() {
            assert_eq!(select_backend(Some("mpv")).unwrap(), Backend::Mpv);
            #[cfg(not(feature = "gstreamer-runtime"))]
            assert!(select_backend(Some("auto")).is_err());
        }
    }
}

#[cfg(target_os = "linux")]
mod linux_surface {
    use std::cell::RefCell;

    use gtk::prelude::*;
    use tauri::{AppHandle, Manager, Runtime};

    use crate::{Error, Result};

    thread_local! {
        static HOST: RefCell<Option<SurfaceHost>> = const { RefCell::new(None) };
    }

    struct SurfaceHost {
        fixed: gtk::Fixed,
    }

    pub fn ensure_host<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
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
            let background_style = gtk::CssProvider::new();
            background_style
                .load_from_data(b".tauri-video-window { background-color: #000; }")
                .map_err(|error| Error::Pipeline(error.to_string()))?;
            let context = gtk_window.style_context();
            context.add_class("tauri-video-window");
            context.add_provider(&background_style, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
            let child = gtk_window
                .child()
                .ok_or_else(|| Error::Pipeline("Tauri GTK window has no webview child".into()))?;
            gtk_window.remove(&child);

            let overlay = gtk::Overlay::new();
            overlay.set_hexpand(true);
            overlay.set_vexpand(true);
            let opaque_base = gtk::DrawingArea::new();
            opaque_base.set_hexpand(true);
            opaque_base.set_vexpand(true);
            opaque_base.connect_draw(|_, context| {
                context.set_source_rgb(0.0, 0.0, 0.0);
                let _ = context.paint();
                // This widget is the compositor-safe opaque floor beneath the
                // native video and transparent WebView. Letting GTK continue
                // into its default DrawingArea handler can clear our paint back
                // to transparent on Wayland compositors such as COSMIC.
                gtk::glib::Propagation::Stop
            });
            let fixed = gtk::Fixed::new();
            fixed.set_hexpand(true);
            fixed.set_vexpand(true);
            child.set_hexpand(true);
            child.set_vexpand(true);
            overlay.add(&opaque_base);
            overlay.add_overlay(&fixed);
            overlay.add_overlay(&child);
            gtk_window.add(&overlay);
            gtk_window.show_all();
            *slot.borrow_mut() = Some(SurfaceHost { fixed });
            Ok(())
        })
    }

    pub fn place_widget(
        widget: &gtk::Widget,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<()> {
        // Preserve negative positions. GtkFixed clips children against the
        // window, which is exactly what we need when an HTML anchor scrolls
        // partially above or left of the viewport. Clamping here pins the
        // native video to the edge while the DOM continues moving.
        let x = x.round() as i32;
        let y = y.round() as i32;
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
            widget.queue_resize();
            host.fixed.queue_resize();
            host.fixed.queue_draw();
            if !widget.is_visible() {
                widget.show();
            }
            Ok(())
        })
    }
}

#[cfg(all(target_os = "linux", feature = "gstreamer-runtime"))]
mod linux_gstreamer {
    use std::{
        cell::RefCell,
        collections::BTreeSet,
        str::FromStr,
        sync::{Arc, OnceLock},
        time::Instant,
    };

    use gst::glib::prelude::Cast as GstCast;
    use gst::glib::translate::ToGlibPtr as GstToGlibPtr;
    use gst::prelude::ObjectExt as GstObjectExt;
    use gst::prelude::*;
    use gstreamer as gst;
    use gtk::prelude::*;
    use parking_lot::RwLock;
    use tauri::{AppHandle, Runtime};

    use crate::{
        models::{
            NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
            NativeSessionRequest, NativeTrackInfo, TrackKind,
        },
        Error, Result,
    };

    static GST_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();

    thread_local! {
        static PLAYER: RefCell<Option<NativePlayer>> = const { RefCell::new(None) };
    }

    struct NativePlayer {
        session_key: String,
        pipeline: gst::Element,
        gtk_sink: gst::Element,
        widget: gtk::Widget,
        source: Arc<RwLock<NativeOpenRequest>>,
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

    pub fn open<R: Runtime>(
        app: &AppHandle<R>,
        payload: NativeOpenRequest,
    ) -> Result<NativePlaybackSnapshot> {
        initialize_gstreamer()?;
        super::linux_surface::ensure_host(app)?;

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

        let gtk_sink = gst::ElementFactory::make("gtkglsink")
            .property("force-aspect-ratio", true)
            .property("sync", true)
            .property("enable-last-sample", false)
            .build()
            .map_err(|error| Error::Pipeline(format!("gtkglsink is unavailable: {error}")))?;
        let terminal_sink = subtitle_safe_gtk_sink(&gtk_sink)?;
        let gl_sink = gst::ElementFactory::make("glsinkbin")
            .property("sink", &terminal_sink)
            .build()
            .map_err(|error| Error::Pipeline(format!("glsinkbin is unavailable: {error}")))?;
        let buffer_duration_seconds = payload
            .max_buffer_ms
            .map(|value| f64::from(value.clamp(3_000, 120_000)) / 1_000.0);
        let target_buffer_bytes = payload
            .target_buffer_bytes
            .map(|value| value.clamp(4 * 1024 * 1024, i32::MAX as u64));
        let mut pipeline_builder = gst::ElementFactory::make("playbin3")
            .property("uri", &payload.uri)
            .property("video-sink", &gl_sink);
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

        let widget_object = gtk_sink.property::<gst::glib::Object>("widget");
        let widget_pointer: *mut gst::glib::gobject_ffi::GObject = widget_object.to_glib_none().0;
        let widget: gtk::Widget = unsafe {
            gtk::glib::translate::from_glib_none(widget_pointer as *mut gtk::ffi::GtkWidget)
        };
        widget.set_hexpand(false);
        widget.set_vexpand(false);
        super::linux_surface::place_widget(
            &widget,
            payload.x,
            payload.y,
            payload.width,
            payload.height,
        )?;

        let mut player = NativePlayer {
            session_key: String::new(),
            pipeline,
            gtk_sink,
            widget,
            source,
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

    fn subtitle_safe_gtk_sink(gtk_sink: &gst::Element) -> Result<gst::Element> {
        let (major, minor, _, _) = gst::version();
        if (major, minor) < (1, 26) {
            return Ok(gtk_sink.clone());
        }
        let compositor = match gst::ElementFactory::make("gloverlaycompositor").build() {
            Ok(compositor) => compositor,
            Err(error) => {
                tracing::warn!(
                    %error,
                    "gloverlaycompositor is unavailable; GStreamer subtitles may flicker"
                );
                return Ok(gtk_sink.clone());
            }
        };
        let flattened_caps =
            gst::Caps::from_str("video/x-raw(memory:GLMemory),format=(string)RGBA")
                .map_err(|error| Error::Pipeline(error.to_string()))?;
        let caps_filter = gst::ElementFactory::make("capsfilter")
            // Excluding GstVideoOverlayCompositionMeta here prevents
            // gloverlaycompositor passthrough. Captions are flattened into the
            // GL texture before gtkglsink's redraw path can lose the metadata.
            .property("caps", flattened_caps)
            .build()
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        let sink_bin = gst::Bin::new();
        sink_bin
            .add_many([&compositor, &caps_filter, gtk_sink])
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        gst::Element::link_many([&compositor, &caps_filter, gtk_sink])
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        let compositor_sink = compositor
            .static_pad("sink")
            .ok_or_else(|| Error::Pipeline("gloverlaycompositor has no sink pad".into()))?;
        let ghost = gst::GhostPad::builder_with_target(&compositor_sink)
            .map_err(|error| Error::Pipeline(error.to_string()))?
            .name("sink")
            .build();
        ghost
            .set_active(true)
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        sink_bin
            .add_pad(&ghost)
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        Ok(GstCast::upcast(sink_bin))
    }

    fn load_source(player: &mut NativePlayer, payload: &NativeOpenRequest) -> Result<()> {
        // Keep the GTK GL sink and widget alive across media changes. Destroying
        // and immediately recreating gtkglsink can invalidate GDK's active EGL
        // draw context on Wayland compositors.
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
        player.gtk_sink.set_property("force-aspect-ratio", true);
        super::linux_surface::place_widget(
            &player.widget,
            payload.x,
            payload.y,
            payload.width,
            payload.height,
        )?;

        player.buffering_percent = 0;
        player.buffer_duration_seconds = buffer_duration_seconds;
        player.target_buffer_bytes = target_buffer_bytes;
        player.desired_playing = payload.autoplay;
        player.error = None;
        player.last_rendered = rendered_frames(&player.gtk_sink);
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

    fn rendered_frames(gtk_sink: &gst::Element) -> u64 {
        gtk_sink
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
            ensure_session(&player.session_key, &payload.session_key)?;
            super::linux_surface::place_widget(
                &player.widget,
                payload.x,
                payload.y,
                payload.width,
                payload.height,
            )
        })
    }

    pub fn stats(payload: NativeSessionRequest) -> Result<NativePlaybackSnapshot> {
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let player = slot
                .as_mut()
                .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
            ensure_session(&player.session_key, &payload.session_key)?;
            snapshot(player).map_err(|error| {
                tracing::debug!(%error, "GStreamer stats snapshot failed");
                error
            })
        })
    }

    pub fn close(payload: NativeSessionRequest) -> Result<()> {
        let owns_player = PLAYER.with(|slot| {
            slot.borrow()
                .as_ref()
                .is_some_and(|player| player.session_key == payload.session_key)
        });
        if !owns_player {
            return Ok(());
        }
        park_player()
    }

    pub fn owns_session(session_key: &str) -> bool {
        PLAYER.with(|slot| {
            slot.borrow()
                .as_ref()
                .is_some_and(|player| player.session_key == session_key)
        })
    }

    pub fn force_close() -> Result<()> {
        park_player()
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
            player.widget.hide();
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
        let playing = player.desired_playing;
        Ok(NativePlaybackSnapshot {
            duration_seconds: duration,
            current_time_seconds: position,
            buffered_seconds: (position
                + player.buffer_duration_seconds.unwrap_or(0.0) * player.buffering_percent as f64
                    / 100.0)
                .min(duration.max(position)),
            playing,
            video_width,
            video_height,
            tracks: player.tracks.clone(),
            presented_frames: rendered,
            dropped_frames: dropped,
            measured_fps: player.measured_fps,
            hardware_backend: "gstreamer-va-gl-gtk".into(),
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

#[cfg(all(target_os = "linux", feature = "mpv-runtime"))]
mod linux_mpv {
    use std::{
        cell::{Cell, RefCell},
        ffi::{c_void, CString},
        rc::Rc,
        time::Instant,
    };

    use gtk::prelude::*;
    use libmpv2::{
        events::{mpv_event_id, Event},
        render::{
            mpv_render_update, OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType,
        },
        Mpv,
    };
    use tauri::{AppHandle, Runtime};

    use crate::{
        models::{
            NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
            NativeSessionRequest, NativeTrackInfo, TrackKind,
        },
        Error, Result,
    };

    #[link(name = "GL")]
    unsafe extern "C" {
        fn glXGetProcAddressARB(name: *const u8) -> *mut c_void;
        fn glGetIntegerv(parameter: u32, value: *mut i32);
    }

    thread_local! {
        static PLAYER: RefCell<Option<MpvPlayer>> = const { RefCell::new(None) };
    }

    #[derive(Clone)]
    struct TrackTarget {
        public_index: i32,
        mpv_id: i64,
        kind: TrackKind,
    }

    #[derive(Clone, Copy)]
    struct MpvBufferDefaults {
        cache_seconds: f64,
        readahead_seconds: f64,
        forward_bytes: i64,
        backward_bytes: i64,
        donate_buffer: bool,
        hysteresis_seconds: f64,
    }

    impl MpvBufferDefaults {
        fn read(mpv: &Mpv) -> Self {
            Self {
                cache_seconds: property(mpv, "cache-secs").unwrap_or(3_600_000.0),
                readahead_seconds: property(mpv, "demuxer-readahead-secs").unwrap_or(1.0),
                forward_bytes: property(mpv, "demuxer-max-bytes").unwrap_or(150 * 1024 * 1024),
                backward_bytes: property(mpv, "demuxer-max-back-bytes").unwrap_or(50 * 1024 * 1024),
                donate_buffer: property(mpv, "demuxer-donate-buffer").unwrap_or(true),
                hysteresis_seconds: property(mpv, "demuxer-hysteresis-secs").unwrap_or(0.0),
            }
        }
    }

    struct MpvPlayer {
        session_key: String,
        mpv: Mpv,
        render_context: Rc<RefCell<Option<RenderContext>>>,
        gl_area: gtk::GLArea,
        widget: gtk::Widget,
        render_signal: Option<gtk::glib::SignalHandlerId>,
        update_source: Option<gtk::glib::SourceId>,
        layout_redraw_pending: Rc<Cell<bool>>,
        presented_frames: Rc<Cell<u64>>,
        last_presented_frames: u64,
        last_sample_at: Instant,
        measured_fps: f64,
        layout_commits: Cell<u64>,
        layout_sample_at: Cell<Instant>,
        tracks: Vec<NativeTrackInfo>,
        track_targets: Vec<TrackTarget>,
        tracks_dirty: bool,
        default_buffer: MpvBufferDefaults,
        error: Rc<RefCell<Option<String>>>,
    }

    impl Drop for MpvPlayer {
        fn drop(&mut self) {
            let _ = self.mpv.command("stop", &[]);
            if let Some(source) = self.update_source.take() {
                source.remove();
            }
            if let Some(signal) = self.render_signal.take() {
                self.gl_area.disconnect(signal);
            }
            // libmpv requires its render context to be destroyed before the
            // owning mpv handle.
            *self.render_context.borrow_mut() = None;
            self.widget.hide();
        }
    }

    pub fn open<R: Runtime>(
        app: &AppHandle<R>,
        payload: NativeOpenRequest,
    ) -> Result<NativePlaybackSnapshot> {
        super::linux_surface::ensure_host(app)?;
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            if let Some(player) = slot.as_mut() {
                load_source(player, &payload)?;
                return snapshot(player);
            }
            let mut player = create_player(&payload)?;
            if std::env::var_os("TAURI_VIDEO_TELEMETRY").is_some() {
                eprintln!("mpv init: collecting initial snapshot");
            }
            let result = snapshot(&mut player)?;
            if std::env::var_os("TAURI_VIDEO_TELEMETRY").is_some() {
                eprintln!("mpv init: initial snapshot complete");
            }
            *slot = Some(player);
            Ok(result)
        })
    }

    fn create_player(payload: &NativeOpenRequest) -> Result<MpvPlayer> {
        let trace = std::env::var_os("TAURI_VIDEO_TELEMETRY").is_some();
        if trace {
            eprintln!("mpv init: begin");
        }
        // libmpv parses floating-point options through the C locale and rejects
        // process locales whose decimal separator is not `.`. This is its
        // documented embedding precondition and is set before the handle exists.
        let locale = unsafe { libc::setlocale(libc::LC_NUMERIC, c"C".as_ptr()) };
        if locale.is_null() {
            return Err(Error::Pipeline(
                "mpv backend could not select the required C numeric locale".into(),
            ));
        }
        let gl_area = gtk::GLArea::new();
        gl_area.set_auto_render(false);
        gl_area.set_has_alpha(false);
        gl_area.set_has_depth_buffer(false);
        gl_area.set_has_stencil_buffer(false);
        gl_area.set_use_es(false);
        gl_area.set_required_version(3, 2);
        gl_area.connect_resize(|area, _, _| {
            // GtkGLArea::resize runs with the new framebuffer and a current GL
            // context. Invalidate libmpv's previous-sized frame immediately;
            // otherwise a paused or ended video stays at the old dimensions
            // until playback happens to produce another render notification.
            area.queue_render();
        });
        gl_area.set_hexpand(false);
        gl_area.set_vexpand(false);
        let widget = gl_area.clone().upcast::<gtk::Widget>();
        super::linux_surface::place_widget(
            &widget,
            payload.x,
            payload.y,
            payload.width,
            payload.height,
        )?;
        gl_area.realize();
        gl_area.make_current();
        if let Some(error) = gl_area.error() {
            return Err(Error::Pipeline(format!(
                "could not create the mpv OpenGL surface: {error}"
            )));
        }
        if trace {
            eprintln!("mpv init: GL area ready");
        }

        let mut mpv = Mpv::with_initializer(|init| {
            init.set_option("vo", "libmpv")?;
            init.set_option("hwdec", "auto-safe")?;
            init.set_option("gpu-api", "opengl")?;
            // GtkGLArea renders on GTK's main thread. libmpv otherwise waits
            // here for each frame's target time (50 ms by default), delaying
            // widget allocation and scroll-driven surface moves.
            init.set_option("video-timing-offset", 0.0_f64)?;
            init.set_option("keep-open", "yes")?;
            init.set_option("osc", "no")?;
            init.set_option("osd-level", "0")?;
            init.set_option("input-default-bindings", "no")?;
            init.set_option("cache", "yes")?;
            Ok(())
        })
        .map_err(mpv_error)?;
        if trace {
            eprintln!("mpv init: handle ready");
        }
        mpv.disable_deprecated_events().map_err(mpv_error)?;
        mpv.disable_event(mpv_event_id::Tick).map_err(mpv_error)?;
        let default_buffer = MpvBufferDefaults::read(&mpv);

        let mut context = RenderContext::new(
            unsafe { mpv.ctx.as_mut() },
            [
                RenderParam::ApiType(RenderParamApiType::OpenGl),
                RenderParam::InitParams(OpenGLInitParams {
                    get_proc_address: open_gl_proc_address,
                    ctx: (),
                }),
            ],
        )
        .map_err(mpv_error)?;
        if trace {
            eprintln!("mpv init: render context ready");
        }

        #[allow(deprecated)]
        let (redraw_sender, redraw_receiver) =
            gtk::glib::MainContext::sync_channel::<()>(gtk::glib::Priority::HIGH_IDLE, 1);
        context.set_update_callback(move || {
            // A one-item channel coalesces bursts without blocking libmpv or
            // building a main-loop backlog. HIGH_IDLE runs after normal event
            // and Tauri command dispatch but just before GTK's redraw phase.
            let _ = redraw_sender.try_send(());
        });
        let render_context = Rc::new(RefCell::new(Some(context)));
        let update_area = gl_area.clone();
        let context_for_update = Rc::clone(&render_context);
        let update_source = redraw_receiver.attach(None, move |_| {
            let update = context_for_update
                .borrow()
                .as_ref()
                .ok_or_else(|| "mpv render context is closed".to_owned())
                .and_then(|context| context.update().map_err(|error| error.to_string()));
            match update {
                Ok(flags) if flags & mpv_render_update::Frame != 0 => {
                    update_area.queue_render();
                }
                Ok(_) => {}
                Err(error) => eprintln!("mpv render update error: {error}"),
            }
            gtk::glib::ControlFlow::Continue
        });

        let presented_frames = Rc::new(Cell::new(0_u64));
        let render_error = Rc::new(RefCell::new(None));
        let context_for_render = Rc::clone(&render_context);
        let frames_for_render = Rc::clone(&presented_frames);
        let error_for_render = Rc::clone(&render_error);
        let render_signal = gl_area.connect_render(move |area, _| {
            const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
            let scale = area.scale_factor().max(1);
            let width = area.allocated_width().max(1).saturating_mul(scale);
            let height = area.allocated_height().max(1).saturating_mul(scale);
            let mut framebuffer = 0_i32;
            // GtkGLArea renders into its own framebuffer rather than necessarily
            // binding OpenGL's default framebuffer 0.
            unsafe { glGetIntegerv(GL_FRAMEBUFFER_BINDING, &mut framebuffer) };
            let rendered = context_for_render
                .borrow()
                .as_ref()
                .ok_or_else(|| "mpv render context is closed".to_owned())
                .and_then(|context| {
                    context
                        .render::<()>(framebuffer, width, height, true)
                        .map_err(|error| error.to_string())?;
                    context.report_swap();
                    Ok(())
                });
            match rendered {
                Ok(()) => frames_for_render.set(frames_for_render.get().saturating_add(1)),
                Err(error) => {
                    eprintln!("mpv render error: {error}");
                    *error_for_render.borrow_mut() = Some(error);
                }
            }
            gtk::glib::Propagation::Stop
        });
        if trace {
            eprintln!("mpv init: GTK render callbacks ready");
        }
        // The render update callback is installed before GTK's render signal;
        // request the bootstrap frame explicitly so mpv cannot wait forever
        // for a consumer after its immediate callback races this connection.
        gl_area.queue_render();

        let mut player = MpvPlayer {
            session_key: String::new(),
            mpv,
            render_context,
            gl_area,
            widget,
            render_signal: Some(render_signal),
            update_source: Some(update_source),
            layout_redraw_pending: Rc::new(Cell::new(false)),
            presented_frames,
            last_presented_frames: 0,
            last_sample_at: Instant::now(),
            measured_fps: 0.0,
            layout_commits: Cell::new(0),
            layout_sample_at: Cell::new(Instant::now()),
            tracks: Vec::new(),
            track_targets: Vec::new(),
            tracks_dirty: true,
            default_buffer,
            error: render_error,
        };
        if trace {
            eprintln!("mpv init: loading source");
        }
        load_source(&mut player, payload)?;
        if trace {
            eprintln!("mpv init: source command complete");
        }
        Ok(player)
    }

    fn load_source(player: &mut MpvPlayer, payload: &NativeOpenRequest) -> Result<()> {
        player.mpv.command("stop", &[]).map_err(mpv_error)?;
        configure_network(player, payload)?;
        configure_buffer(player, payload)?;
        player
            .mpv
            .set_property(
                "volume",
                if payload.muted {
                    0.0
                } else {
                    payload.volume.clamp(0.0, 1.0) * 100.0
                },
            )
            .map_err(mpv_error)?;
        player
            .mpv
            .set_property("pause", !payload.autoplay)
            .map_err(mpv_error)?;
        player
            .mpv
            .command("loadfile", &[&payload.uri, "replace"])
            .map_err(mpv_error)?;
        super::linux_surface::place_widget(
            &player.widget,
            payload.x,
            payload.y,
            payload.width,
            payload.height,
        )?;
        schedule_layout_render(player);
        player.session_key.clone_from(&payload.session_key);
        player.tracks.clear();
        player.track_targets.clear();
        player.tracks_dirty = true;
        *player.error.borrow_mut() = None;
        player.last_presented_frames = player.presented_frames.get();
        player.last_sample_at = Instant::now();
        player.measured_fps = 0.0;
        player.layout_commits.set(0);
        player.layout_sample_at.set(Instant::now());
        Ok(())
    }

    fn configure_network(player: &MpvPlayer, payload: &NativeOpenRequest) -> Result<()> {
        let mut headers = payload.headers.clone();
        if let Some(value) = payload.cookies.as_ref().filter(|value| !value.is_empty()) {
            headers.insert("Cookie".into(), value.clone());
        }
        if let Some(value) = payload.referrer.as_ref().filter(|value| !value.is_empty()) {
            headers.insert("Referer".into(), value.clone());
        }
        if !headers.is_empty() {
            let values = headers
                .iter()
                .map(|(name, value)| format!("{name}: {value}"))
                .collect::<Vec<_>>();
            player
                .mpv
                .set_property("http-header-fields", encode_mpv_list(&values))
                .map_err(mpv_error)?;
        } else {
            player
                .mpv
                .set_property("http-header-fields", String::new())
                .map_err(mpv_error)?;
        }
        player
            .mpv
            .set_property(
                "user-agent",
                payload
                    .user_agent
                    .clone()
                    .unwrap_or_else(|| "tauri-plugin-video".into()),
            )
            .map_err(mpv_error)?;
        player
            .mpv
            .set_property(
                "tls-ca-file",
                payload.tls_ca_file.clone().unwrap_or_default(),
            )
            .map_err(mpv_error)?;
        Ok(())
    }

    fn configure_buffer(player: &MpvPlayer, payload: &NativeOpenRequest) -> Result<()> {
        let (cache_seconds, readahead_seconds) = payload.max_buffer_ms.map_or(
            (
                player.default_buffer.cache_seconds,
                player.default_buffer.readahead_seconds,
            ),
            |milliseconds| {
                let seconds = (f64::from(milliseconds) / 1_000.0).clamp(3.0, 120.0);
                (seconds, seconds)
            },
        );
        let (forward_bytes, backward_bytes, donate_buffer) = payload.target_buffer_bytes.map_or(
            (
                player.default_buffer.forward_bytes,
                player.default_buffer.backward_bytes,
                player.default_buffer.donate_buffer,
            ),
            |requested| {
                let total = requested.clamp(8 * 1024 * 1024, i64::MAX as u64);
                let backward = (total / 4)
                    .clamp(4 * 1024 * 1024, 16 * 1024 * 1024)
                    .min(total / 2);
                ((total - backward) as i64, backward as i64, false)
            },
        );
        player
            .mpv
            .set_property("cache-secs", cache_seconds)
            .map_err(mpv_error)?;
        player
            .mpv
            .set_property("demuxer-readahead-secs", readahead_seconds)
            .map_err(mpv_error)?;
        player
            .mpv
            .set_property("demuxer-max-bytes", forward_bytes)
            .map_err(mpv_error)?;
        player
            .mpv
            .set_property("demuxer-max-back-bytes", backward_bytes)
            .map_err(mpv_error)?;
        player
            .mpv
            .set_property("demuxer-donate-buffer", donate_buffer)
            .map_err(mpv_error)?;
        player
            .mpv
            .set_property(
                "demuxer-hysteresis-secs",
                player.default_buffer.hysteresis_seconds,
            )
            .map_err(mpv_error)?;
        Ok(())
    }

    pub fn control(payload: NativeControlRequest) -> Result<NativePlaybackSnapshot> {
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let player = slot
                .as_mut()
                .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
            ensure_session(&player.session_key, &payload.session_key)?;
            match payload.action.as_str() {
                "play" => player.mpv.set_property("pause", false).map_err(mpv_error)?,
                "pause" => player.mpv.set_property("pause", true).map_err(mpv_error)?,
                "seek" => player
                    .mpv
                    .command(
                        "seek",
                        &[&payload.value.max(0.0).to_string(), "absolute+exact"],
                    )
                    .map_err(mpv_error)?,
                "volume" => player
                    .mpv
                    .set_property("volume", payload.value.clamp(0.0, 1.0) * 100.0)
                    .map_err(mpv_error)?,
                "fit" => player
                    .mpv
                    .set_property("panscan", 0.0_f64)
                    .map_err(mpv_error)?,
                "crop" => player
                    .mpv
                    .set_property("panscan", 1.0_f64)
                    .map_err(mpv_error)?,
                "stretch" => player
                    .mpv
                    .set_property("video-unscaled", "downscale-big".to_owned())
                    .map_err(mpv_error)?,
                "zoom" => player
                    .mpv
                    .set_property("video-zoom", (payload.value.max(1.0)).log2())
                    .map_err(mpv_error)?,
                "track" => select_track(player, payload.index, true)?,
                "deselectTrack" => select_track(player, payload.index, false)?,
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
            ensure_session(&player.session_key, &payload.session_key)?;
            super::linux_surface::place_widget(
                &player.widget,
                payload.x,
                payload.y,
                payload.width,
                payload.height,
            )?;
            let commits = player.layout_commits.get().saturating_add(1);
            player.layout_commits.set(commits);
            let now = Instant::now();
            let elapsed = now
                .duration_since(player.layout_sample_at.get())
                .as_secs_f64();
            if elapsed >= 0.5 && std::env::var_os("TAURI_VIDEO_TELEMETRY").is_some() {
                eprintln!(
                    "mpv layout telemetry: commits={commits} rate={:.1} Hz",
                    commits as f64 / elapsed
                );
                player.layout_commits.set(0);
                player.layout_sample_at.set(now);
            }
            schedule_layout_render(player);
            Ok(())
        })
    }

    fn schedule_layout_render(player: &MpvPlayer) {
        if player.layout_redraw_pending.replace(true) {
            return;
        }
        let pending = Rc::clone(&player.layout_redraw_pending);
        player.gl_area.add_tick_callback(move |area, _| {
            pending.set(false);
            if let Some(parent) = area.parent() {
                parent.queue_draw();
            }
            area.queue_render();
            gtk::glib::ControlFlow::Break
        });
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

    pub fn owns_session(session_key: &str) -> bool {
        PLAYER.with(|slot| {
            slot.borrow()
                .as_ref()
                .is_some_and(|player| player.session_key == session_key)
        })
    }

    pub fn force_close() -> Result<()> {
        PLAYER.with(|slot| {
            slot.borrow_mut().take();
        });
        Ok(())
    }

    fn park_player() -> Result<()> {
        PLAYER.with(|slot| {
            let mut slot = slot.borrow_mut();
            let Some(player) = slot.as_mut() else {
                return Ok(());
            };
            // Keep GtkGLArea and libmpv's render context alive between source
            // changes. Destroying and immediately recreating a native GL child
            // can invalidate WebKit's transparent composited layer on Wayland,
            // leaving a live DOM whose pixels are no longer presented.
            player.mpv.command("stop", &[]).map_err(mpv_error)?;
            player.widget.hide();
            player.session_key.clear();
            player.tracks.clear();
            player.track_targets.clear();
            player.tracks_dirty = true;
            *player.error.borrow_mut() = None;
            Ok(())
        })
    }

    fn snapshot(player: &mut MpvPlayer) -> Result<NativePlaybackSnapshot> {
        drain_events(player)?;
        if let Some(error) = player.error.borrow().clone() {
            return Err(Error::Pipeline(error));
        }
        if player.tracks_dirty {
            refresh_tracks(player);
            player.tracks_dirty = false;
        }
        let position = property::<f64>(&player.mpv, "time-pos")
            .unwrap_or(0.0)
            .max(0.0);
        let duration = property::<f64>(&player.mpv, "duration")
            .unwrap_or(0.0)
            .max(0.0);
        let buffered = property::<f64>(&player.mpv, "demuxer-cache-time")
            .unwrap_or(position)
            .max(position)
            .min(duration.max(position));
        let rendered = player.presented_frames.get();
        let dropped = property::<i64>(&player.mpv, "frame-drop-count")
            .unwrap_or(0)
            .max(0) as u64;
        let now = Instant::now();
        let elapsed = now.duration_since(player.last_sample_at).as_secs_f64();
        if elapsed >= 0.5 {
            player.measured_fps =
                rendered.saturating_sub(player.last_presented_frames) as f64 / elapsed;
            player.last_presented_frames = rendered;
            player.last_sample_at = now;
            if std::env::var_os("TAURI_VIDEO_TELEMETRY").is_some() {
                eprintln!(
                    "mpv telemetry: presented={rendered} dropped={dropped} fps={:.2} position={position:.2}s",
                    player.measured_fps,
                );
            }
        }
        let video_width = property::<i64>(&player.mpv, "video-params/w")
            .unwrap_or(0)
            .max(0) as u32;
        let video_height = property::<i64>(&player.mpv, "video-params/h")
            .unwrap_or(0)
            .max(0) as u32;
        let paused = property::<bool>(&player.mpv, "pause").unwrap_or(true);
        let decoder = property::<String>(&player.mpv, "video-codec").unwrap_or_default();
        let hwdec =
            property::<String>(&player.mpv, "hwdec-current").unwrap_or_else(|| "software".into());
        Ok(NativePlaybackSnapshot {
            duration_seconds: duration,
            current_time_seconds: position,
            buffered_seconds: buffered,
            playing: !paused,
            video_width,
            video_height,
            tracks: player.tracks.clone(),
            presented_frames: rendered,
            dropped_frames: dropped,
            measured_fps: player.measured_fps,
            hardware_backend: format!("mpv:{hwdec}:{decoder}:gtk-glarea"),
            encoded_bytes_buffered: property::<i64>(&player.mpv, "cache-used")
                .unwrap_or(0)
                .max(0) as u64
                * 1024,
            average_frame_processing_us: 0.0,
        })
    }

    fn refresh_tracks(player: &mut MpvPlayer) {
        let count = property::<i64>(&player.mpv, "track-list/count")
            .unwrap_or(0)
            .max(0);
        let mut tracks = Vec::with_capacity(count as usize);
        let mut targets = Vec::with_capacity(count as usize);
        for source_index in 0..count {
            let prefix = format!("track-list/{source_index}");
            let track_type =
                property::<String>(&player.mpv, &format!("{prefix}/type")).unwrap_or_default();
            let kind = match track_type.as_str() {
                "video" => TrackKind::Video,
                "audio" => TrackKind::Audio,
                "sub" => TrackKind::Subtitle,
                _ => continue,
            };
            let mpv_id =
                property::<i64>(&player.mpv, &format!("{prefix}/id")).unwrap_or(source_index);
            let public_index = tracks.len() as i32;
            let language = property::<String>(&player.mpv, &format!("{prefix}/lang"))
                .unwrap_or_else(|| "und".into());
            let title =
                property::<String>(&player.mpv, &format!("{prefix}/title")).unwrap_or_default();
            let codec =
                property::<String>(&player.mpv, &format!("{prefix}/codec")).unwrap_or_default();
            let selected =
                property::<bool>(&player.mpv, &format!("{prefix}/selected")).unwrap_or(false);
            tracks.push(NativeTrackInfo {
                id: format!("mpv-{track_type}-{mpv_id}"),
                index: public_index,
                kind,
                language: language.clone(),
                label: if title.is_empty() {
                    if language == "und" {
                        track_type.clone()
                    } else {
                        language.to_uppercase()
                    }
                } else {
                    title
                },
                codec,
                selected,
            });
            targets.push(TrackTarget {
                public_index,
                mpv_id,
                kind,
            });
        }
        player.tracks = tracks;
        player.track_targets = targets;
    }

    fn select_track(player: &mut MpvPlayer, index: i32, enabled: bool) -> Result<()> {
        let target = player
            .track_targets
            .iter()
            .find(|target| target.public_index == index)
            .cloned()
            .ok_or_else(|| Error::InvalidRequest(format!("unknown native track index {index}")))?;
        let property = match target.kind {
            TrackKind::Video => "vid",
            TrackKind::Audio => "aid",
            TrackKind::Subtitle => "sid",
        };
        let result = if enabled {
            player
                .mpv
                .set_property(property, target.mpv_id)
                .map_err(mpv_error)
        } else {
            player
                .mpv
                .set_property(property, "no".to_owned())
                .map_err(mpv_error)
        };
        if result.is_ok() {
            player.tracks_dirty = true;
        }
        result
    }

    fn drain_events(player: &mut MpvPlayer) -> Result<()> {
        // Event production is independent of the UI poll rate. Never let a hot
        // event queue monopolize GTK's main thread and starve frame presentation.
        for _ in 0..64 {
            let Some(event) = player.mpv.wait_event(0.0) else {
                break;
            };
            match event.map_err(|error| {
                let error = mpv_error(error);
                eprintln!("mpv event error: {error}");
                error
            })? {
                Event::Shutdown => return Err(Error::Pipeline("mpv shut down".into())),
                Event::StartFile
                | Event::FileLoaded
                | Event::VideoReconfig
                | Event::AudioReconfig => player.tracks_dirty = true,
                Event::EndFile(_) => {}
                _ => {}
            }
        }
        Ok(())
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

    fn property<T: libmpv2::GetData>(mpv: &Mpv, name: &str) -> Option<T> {
        mpv.get_property(name).ok()
    }

    fn encode_mpv_list(values: &[String]) -> String {
        values
            .iter()
            .map(|value| format!("%{}%{}", value.len(), value))
            .collect::<Vec<_>>()
            .join(",")
    }

    fn mpv_error(error: libmpv2::Error) -> Error {
        Error::Pipeline(format!("mpv backend: {error}"))
    }

    fn open_gl_proc_address(_: &(), name: &str) -> *mut c_void {
        let Ok(name) = CString::new(name) else {
            return std::ptr::null_mut();
        };
        let pointer = unsafe { glXGetProcAddressARB(name.as_ptr().cast()) };
        if pointer.is_null() {
            unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) }
        } else {
            pointer
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn mpv_list_encoding_preserves_commas_in_headers() {
            assert_eq!(
                encode_mpv_list(&["Cookie: a=1,b=2".into()]),
                "%15%Cookie: a=1,b=2"
            );
        }
    }
}

#[cfg(all(target_os = "linux", not(feature = "mpv-runtime")))]
mod linux_mpv {
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
            "Linux mpv playback requires the mpv-runtime feature".into(),
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
    pub fn owns_session(_: &str) -> bool {
        false
    }
    pub fn force_close() -> Result<()> {
        Ok(())
    }
}

#[cfg(all(target_os = "linux", not(feature = "gstreamer-runtime")))]
mod linux_gstreamer {
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
    pub fn stats(_: NativeSessionRequest) -> Result<NativePlaybackSnapshot> {
        unavailable()
    }
    pub fn close(_: NativeSessionRequest) -> Result<()> {
        Ok(())
    }
    pub fn owns_session(_: &str) -> bool {
        false
    }
    pub fn force_close() -> Result<()> {
        Ok(())
    }
}
