use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[cfg(feature = "gstreamer-runtime")]
use std::{
    str::FromStr,
    sync::atomic::AtomicUsize,
    thread,
    time::{Duration, Instant},
};

use bytes::Bytes;
#[cfg(feature = "gstreamer-runtime")]
use parking_lot::Mutex;

use crate::{models::*, runtime, Error, Result};

#[cfg(feature = "gstreamer-runtime")]
use gstreamer as gst;
#[cfg(feature = "gstreamer-runtime")]
use gstreamer_app as gst_app;

type InitCallback = Arc<dyn Fn(&[u8]) + Send + Sync>;
type FragmentCallback = Arc<dyn Fn(Bytes, f64) + Send + Sync>;
type SubtitleCallback = Arc<dyn Fn(SubtitleCue) + Send + Sync>;
type ErrorCallback = Arc<dyn Fn(String) + Send + Sync>;
type EosCallback = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
#[cfg_attr(not(feature = "gstreamer-runtime"), allow(dead_code))]
pub struct PipelineCallbacks {
    pub on_init: InitCallback,
    pub on_fragment: FragmentCallback,
    pub on_subtitle: SubtitleCallback,
    pub on_error: ErrorCallback,
    pub on_eos: EosCallback,
}

#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(not(feature = "gstreamer-runtime"), allow(dead_code))]
pub struct StreamSelection {
    pub video_index: Option<usize>,
    pub audio_index: Option<usize>,
    pub subtitle_index: Option<usize>,
}

impl StreamSelection {
    pub fn from_media(media: &MediaInfo) -> Self {
        Self {
            video_index: media
                .tracks
                .iter()
                .find(|track| track.kind == TrackKind::Video && track.selected)
                .map(|track| track.stream_index),
            audio_index: media
                .tracks
                .iter()
                .find(|track| track.kind == TrackKind::Audio && track.selected)
                .map(|track| track.stream_index),
            subtitle_index: media
                .tracks
                .iter()
                .find(|track| track.kind == TrackKind::Subtitle && track.selected)
                .map(|track| track.stream_index),
        }
    }
}

pub struct MediaPipeline {
    #[cfg(feature = "gstreamer-runtime")]
    pipeline: gst::Pipeline,
    stopped: Arc<AtomicBool>,
    backend: Option<String>,
}

#[cfg(feature = "gstreamer-runtime")]
#[derive(Default)]
struct Mp4FragmentAssembler {
    pending: Vec<u8>,
    fragment: Vec<u8>,
}

#[cfg(feature = "gstreamer-runtime")]
impl Mp4FragmentAssembler {
    const MAX_BOX_BYTES: usize = 64 * 1024 * 1024;

    fn push(&mut self, bytes: &[u8]) -> std::result::Result<Vec<Bytes>, String> {
        self.pending.extend_from_slice(bytes);
        let mut completed = Vec::new();
        while let Some(size) = mp4_box_size(&self.pending)? {
            if self.pending.len() < size {
                break;
            }
            let box_bytes = self.pending.drain(..size).collect::<Vec<_>>();
            let kind = &box_bytes[4..8];
            self.fragment.extend_from_slice(&box_bytes);
            if kind == b"mdat" {
                completed.push(Bytes::from(std::mem::take(&mut self.fragment)));
            }
        }
        Ok(completed)
    }
}

#[cfg(feature = "gstreamer-runtime")]
fn mp4_box_size(bytes: &[u8]) -> std::result::Result<Option<usize>, String> {
    if bytes.len() < 8 {
        return Ok(None);
    }
    let short = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    let size = match short {
        0 => return Err("MP4 box with an unbounded size is not streamable".into()),
        1 => {
            if bytes.len() < 16 {
                return Ok(None);
            }
            usize::try_from(u64::from_be_bytes(bytes[8..16].try_into().unwrap()))
                .map_err(|_| "MP4 box size exceeds this platform".to_string())?
        }
        value => value,
    };
    if !(8..=Mp4FragmentAssembler::MAX_BOX_BYTES).contains(&size) {
        return Err(format!("invalid or oversized MP4 box: {size} bytes"));
    }
    Ok(Some(size))
}

impl MediaPipeline {
    pub fn build(
        source: &VideoSource,
        mode: PlaybackMode,
        selection: StreamSelection,
        callbacks: PipelineCallbacks,
    ) -> Result<Self> {
        runtime::initialize()?;
        #[cfg(feature = "gstreamer-runtime")]
        {
            use gst::prelude::*;

            let pipeline = gst::Pipeline::new();
            let decodebin_name = if runtime::has_element("uridecodebin3") {
                "uridecodebin3"
            } else {
                "uridecodebin"
            };
            let uri_decode = gst::ElementFactory::make(decodebin_name)
                .property("uri", &source.uri)
                .property("download", false)
                .property("use-buffering", true)
                .property("ring-buffer-max-size", 64u64 * 1024 * 1024)
                .build()
                .map_err(|error| Error::Pipeline(error.to_string()))?;

            if matches!(mode, PlaybackMode::Remux | PlaybackMode::HybridRemux) {
                let caps = if mode == PlaybackMode::HybridRemux {
                    // Stop before decoding HEVC, but decode unsupported audio so
                    // only the much cheaper audio branch needs transcoding.
                    "video/x-h265; audio/x-raw; text/x-raw"
                } else {
                    "video/x-h264; video/x-h265; audio/mpeg,mpegversion=(int)4; audio/x-eac3; audio/x-ac3; text/x-raw"
                };
                let caps = gst::Caps::from_str(caps)
                    .map_err(|error| Error::Pipeline(error.to_string()))?;
                uri_decode.set_property("caps", caps);
            }
            let source_options = source.clone();
            uri_decode.connect("source-setup", false, move |values| {
                if let Ok(element) = values[1].get::<gst::Element>() {
                    configure_source(&element, &source_options);
                }
                None
            });
            let native_stream_selection = decodebin_name == "uridecodebin3";
            if native_stream_selection {
                let selection_for_signal = selection;
                uri_decode.connect("select-stream", false, move |values| {
                    let Ok(collection) = values[1].get::<gst::StreamCollection>() else {
                        return Some((-1i32).to_value());
                    };
                    let Ok(stream) = values[2].get::<gst::Stream>() else {
                        return Some((-1i32).to_value());
                    };
                    let stream_type = stream.stream_type();
                    let (kind_type, selected_index) =
                        if stream_type.contains(gst::StreamType::VIDEO) {
                            (gst::StreamType::VIDEO, selection_for_signal.video_index)
                        } else if stream_type.contains(gst::StreamType::AUDIO) {
                            (gst::StreamType::AUDIO, selection_for_signal.audio_index)
                        } else if stream_type.contains(gst::StreamType::TEXT) {
                            (gst::StreamType::TEXT, selection_for_signal.subtitle_index)
                        } else {
                            return Some((0i32).to_value());
                        };
                    let stream_id = stream.stream_id();
                    let index = collection
                        .iter()
                        .filter(|candidate| candidate.stream_type().contains(kind_type))
                        .position(|candidate| candidate.stream_id() == stream_id);
                    Some((i32::from(index == selected_index)).to_value())
                });
            }

            let mux = gst::ElementFactory::make("mp4mux")
                .property("fragment-duration", 1_000u32)
                .property("streamable", true)
                .property("faststart", false)
                .build()
                .map_err(|error| Error::Pipeline(format!("mp4mux is unavailable: {error}")))?;
            // Request every selected mux input before qtmux starts. Otherwise
            // whichever decoded stream arrives first can start aggregation and
            // make a later video/audio request nondeterministically fail.
            let video_mux_pad = selection
                .video_index
                .map(|_| request_mux_pad(&mux, "video_%u"))
                .transpose()?;
            let audio_mux_pad = selection
                .audio_index
                .map(|_| request_mux_pad(&mux, "audio_%u"))
                .transpose()?;
            let appsink = gst::ElementFactory::make("appsink")
                // qtmux output-buffer timestamps are not a valid presentation
                // clock on every HEVC stream. Explicit fragment pacing below
                // avoids a measured 0.5x producer rate on Amlogic Android TV.
                .property("sync", false)
                .property("max-buffers", 64u32)
                .property("drop", false)
                .property("wait-on-eos", false)
                .build()
                .map_err(|error| Error::Pipeline(error.to_string()))?
                .downcast::<gst_app::AppSink>()
                .map_err(|_| Error::Pipeline("failed to create encoded appsink".into()))?;

            pipeline
                .add_many([&uri_decode, &mux, appsink.upcast_ref()])
                .map_err(|error| Error::Pipeline(error.to_string()))?;
            mux.link(&appsink).map_err(|error| {
                Error::Pipeline(format!("failed to link mp4mux to encoded appsink: {error}"))
            })?;

            let stopped = Arc::new(AtomicBool::new(false));
            let seen_media = Arc::new(AtomicBool::new(false));
            let callbacks_for_sink = callbacks.clone();
            let seen_media_for_sink = seen_media.clone();
            let assembler = Arc::new(Mutex::new(Mp4FragmentAssembler::default()));
            let pacing_started = Instant::now();
            let produced_fragments = Arc::new(AtomicUsize::new(0));
            let produced_fragments_for_sink = produced_fragments.clone();
            // qtmux emits one moof/mdat pair per active mux pad for each
            // fragment interval. An A/V session therefore produces roughly
            // two encoded fragments per timeline second.
            let fragments_per_second = usize::from(selection.video_index.is_some())
                + usize::from(selection.audio_index.is_some());
            let fragments_per_second = fragments_per_second.max(1);
            let initial_fragment_reserve = 15 * fragments_per_second;
            let fragment_duration_seconds = 1.0 / fragments_per_second as f64;
            appsink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |sink| {
                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        let Some(buffer) = sample.buffer() else {
                            return Ok(gst::FlowSuccess::Ok);
                        };
                        let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                        let bytes = map.as_slice();
                        // Encoded keyframes can inherit GStreamer's HEADER flag.
                        // Only actual top-level ftyp/moov boxes belong to the MSE
                        // initialization segment.
                        let is_header = !seen_media_for_sink.load(Ordering::Acquire)
                            && looks_like_mp4_header(bytes);
                        if is_header {
                            (callbacks_for_sink.on_init)(bytes);
                        } else {
                            seen_media_for_sink.store(true, Ordering::Release);
                            let fragments = assembler
                                .lock()
                                .push(bytes)
                                .map_err(|_| gst::FlowError::Error)?;
                            for fragment in fragments {
                                (callbacks_for_sink.on_fragment)(
                                    fragment,
                                    fragment_duration_seconds,
                                );
                                let produced =
                                    produced_fragments_for_sink.fetch_add(1, Ordering::AcqRel) + 1;
                                // Burst the initial reserve, then pace by the
                                // media timeline. This bounds encoded memory and
                                // prevents reading the source to completion.
                                if produced > initial_fragment_reserve {
                                    let deadline = Duration::from_secs_f64(
                                        (produced - initial_fragment_reserve) as f64
                                            / fragments_per_second as f64,
                                    );
                                    if let Some(delay) =
                                        deadline.checked_sub(pacing_started.elapsed())
                                    {
                                        thread::sleep(delay);
                                    }
                                }
                            }
                        }
                        Ok(gst::FlowSuccess::Ok)
                    })
                    .eos({
                        let callback = callbacks.on_eos.clone();
                        move |_| callback()
                    })
                    .build(),
            );

            let video_count = Arc::new(AtomicUsize::new(0));
            let audio_count = Arc::new(AtomicUsize::new(0));
            let subtitle_count = Arc::new(AtomicUsize::new(0));
            let video_attached = Arc::new(AtomicBool::new(false));
            let audio_attached = Arc::new(AtomicBool::new(false));
            let subtitle_attached = Arc::new(AtomicBool::new(false));
            let mode_for_pad = mode;
            let pipeline_for_pad = pipeline.clone();
            let video_mux_pad_for_pad = video_mux_pad.clone();
            let audio_mux_pad_for_pad = audio_mux_pad.clone();
            let error_for_pad = callbacks.on_error.clone();
            let subtitle_for_pad = callbacks.on_subtitle.clone();
            let selection_for_pad = selection;
            let selected_encoder = selected_h264_encoder(mode);
            let encoder_for_pad = selected_encoder.clone();
            uri_decode.connect_pad_added(move |_source, pad| {
                let caps = pad
                    .current_caps()
                    .or_else(|| Some(pad.query_caps(None)))
                    .unwrap_or_else(gst::Caps::new_empty);
                let name = caps
                    .structure(0)
                    .map(|value| value.name().to_string())
                    .unwrap_or_default();
                let kind = if name.starts_with("video/") {
                    let index = video_count.fetch_add(1, Ordering::Relaxed);
                    let selected = if native_stream_selection {
                        selection_for_pad.video_index.is_some()
                            && !video_attached.swap(true, Ordering::AcqRel)
                    } else {
                        Some(index) == selection_for_pad.video_index
                    };
                    selected.then_some(TrackKind::Video)
                } else if name.starts_with("audio/") {
                    let index = audio_count.fetch_add(1, Ordering::Relaxed);
                    let selected = if native_stream_selection {
                        selection_for_pad.audio_index.is_some()
                            && !audio_attached.swap(true, Ordering::AcqRel)
                    } else {
                        Some(index) == selection_for_pad.audio_index
                    };
                    selected.then_some(TrackKind::Audio)
                } else if name.starts_with("text/") || name.starts_with("application/x-ass") {
                    let index = subtitle_count.fetch_add(1, Ordering::Relaxed);
                    let selected = if native_stream_selection {
                        selection_for_pad.subtitle_index.is_some()
                            && !subtitle_attached.swap(true, Ordering::AcqRel)
                    } else {
                        Some(index) == selection_for_pad.subtitle_index
                    };
                    selected.then_some(TrackKind::Subtitle)
                } else {
                    None
                };
                let result = match kind {
                    Some(TrackKind::Subtitle) => {
                        attach_subtitle_branch(&pipeline_for_pad, pad, subtitle_for_pad.clone())
                    }
                    Some(kind) => {
                        let mux_sink_pad = match kind {
                            TrackKind::Video => video_mux_pad_for_pad.as_ref(),
                            TrackKind::Audio => audio_mux_pad_for_pad.as_ref(),
                            TrackKind::Subtitle => None,
                        };
                        mux_sink_pad.map_or_else(
                            || Err(Error::Pipeline(format!("missing {kind:?} mux pad"))),
                            |mux_sink_pad| {
                                attach_branch(
                                    &pipeline_for_pad,
                                    mux_sink_pad,
                                    pad,
                                    kind,
                                    mode_for_pad,
                                    encoder_for_pad.as_deref(),
                                )
                            },
                        )
                    }
                    None => attach_discard_branch(&pipeline_for_pad, pad),
                };
                if let Err(error) = result {
                    error_for_pad(error.to_string());
                }
            });

            let bus = pipeline
                .bus()
                .ok_or_else(|| Error::Pipeline("pipeline has no bus".into()))?;
            let stopped_for_bus = stopped.clone();
            let error_for_bus = callbacks.on_error.clone();
            let eos_for_bus = callbacks.on_eos.clone();
            thread::Builder::new()
                .name("tauri-video-gst-bus".into())
                .spawn(move || {
                    for message in bus.iter_timed(gst::ClockTime::NONE) {
                        if stopped_for_bus.load(Ordering::Acquire) {
                            break;
                        }
                        match message.view() {
                            gst::MessageView::Error(error) => {
                                let source = error
                                    .src()
                                    .map(|value| value.path_string())
                                    .unwrap_or_else(|| "unknown".into());
                                error_for_bus(format!(
                                    "{source}: {} ({:?})",
                                    error.error(),
                                    error.debug()
                                ));
                                break;
                            }
                            gst::MessageView::Eos(_) => {
                                eos_for_bus();
                                break;
                            }
                            _ => {}
                        }
                    }
                })
                .map_err(Error::Io)?;

            pipeline
                .set_state(gst::State::Paused)
                .map_err(|error| Error::Pipeline(error.to_string()))?;
            if let Some(position) = source.start_position_seconds.filter(|value| *value > 0.0) {
                let _ = pipeline.seek_simple(
                    gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                    gst::ClockTime::from_nseconds((position * 1_000_000_000.0) as u64),
                );
            }

            let backend = if mode == PlaybackMode::HardwareTranscode {
                selected_encoder
            } else {
                None
            };
            Ok(Self {
                pipeline,
                stopped,
                backend,
            })
        }
        #[cfg(not(feature = "gstreamer-runtime"))]
        {
            let _ = (source, mode, selection, callbacks);
            Err(Error::RuntimeUnavailable(
                "crate was built without GStreamer".into(),
            ))
        }
    }

    pub fn backend(&self) -> Option<&str> {
        self.backend.as_deref()
    }

    pub fn set_playback_state(&self, _state: PlaybackState) -> Result<()> {
        #[cfg(feature = "gstreamer-runtime")]
        {
            use gst::prelude::*;
            let target = match _state {
                PlaybackState::Playing => gst::State::Playing,
                PlaybackState::Paused => gst::State::Paused,
                PlaybackState::Suspended => gst::State::Ready,
            };
            self.pipeline
                .set_state(target)
                .map_err(|error| Error::Pipeline(error.to_string()))?;
        }
        Ok(())
    }

    pub fn seek(&self, position_seconds: f64) -> Result<()> {
        if !position_seconds.is_finite() || position_seconds < 0.0 {
            return Err(Error::InvalidRequest("invalid seek position".into()));
        }
        #[cfg(feature = "gstreamer-runtime")]
        {
            use gst::prelude::*;
            // `set_state(Paused)` is asynchronous for remote decode bins. A
            // seek sent before preroll has established a TIME segment is
            // rejected by GStreamer and can leave a track-switch rebuild
            // waiting forever. Resolve the transition before flushing it.
            let (transition, current, _) =
                self.pipeline.state(Some(gst::ClockTime::from_seconds(20)));
            transition.map_err(|error| Error::Pipeline(error.to_string()))?;
            if current < gst::State::Paused {
                return Err(Error::Pipeline(
                    "pipeline did not preroll before seek".into(),
                ));
            }
            self.pipeline
                .seek_simple(
                    gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                    gst::ClockTime::from_nseconds((position_seconds * 1_000_000_000.0) as u64),
                )
                .map_err(|error| Error::Pipeline(error.to_string()))?;
        }
        Ok(())
    }

    pub fn position_seconds(&self) -> f64 {
        #[cfg(feature = "gstreamer-runtime")]
        {
            use gst::prelude::*;
            self.pipeline
                .query_position::<gst::ClockTime>()
                .map(|position| position.seconds_f64())
                .unwrap_or(0.0)
        }
        #[cfg(not(feature = "gstreamer-runtime"))]
        0.0
    }
}

impl Drop for MediaPipeline {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        #[cfg(feature = "gstreamer-runtime")]
        {
            use gst::prelude::*;
            let _ = self.pipeline.set_state(gst::State::Null);
        }
    }
}

#[cfg(feature = "gstreamer-runtime")]
fn attach_branch(
    pipeline: &gst::Pipeline,
    mux_sink_pad: &gst::Pad,
    source_pad: &gst::Pad,
    kind: TrackKind,
    mode: PlaybackMode,
    encoder: Option<&str>,
) -> Result<()> {
    use gst::prelude::*;

    let queue_bytes = match kind {
        TrackKind::Video => 64u32 * 1024 * 1024,
        TrackKind::Audio | TrackKind::Subtitle => 16u32 * 1024 * 1024,
    };
    let mut elements = vec![gst::ElementFactory::make("queue")
        .property("max-size-bytes", queue_bytes)
        .property("max-size-time", 20_000_000_000u64)
        .build()
        .map_err(|error| Error::Pipeline(error.to_string()))?];

    match (kind, mode) {
        (TrackKind::Video, PlaybackMode::Remux) => {
            let caps_name = source_pad
                .current_caps()
                .or_else(|| Some(source_pad.query_caps(None)))
                .and_then(|caps| caps.structure(0).map(|s| s.name().to_string()))
                .unwrap_or_default();
            if caps_name == "video/x-h265" {
                elements.extend(make_mp4_h265_tail()?);
            } else {
                elements.extend(make_mp4_h264_tail()?);
            }
        }
        (TrackKind::Audio, PlaybackMode::Remux) => {
            let caps_name = source_pad
                .current_caps()
                .or_else(|| Some(source_pad.query_caps(None)))
                .and_then(|caps| caps.structure(0).map(|s| s.name().to_string()))
                .unwrap_or_default();
            if caps_name == "audio/x-eac3" {
                elements.push(make("ac3parse")?);
                // Matroska stores E-AC-3 as individual frames, while qtmux's
                // EC-3 sample entry accepts the IEC 61937 alignment. ac3parse
                // performs that lossless framing conversion when downstream
                // requests it; without the filter the dynamic pad fails with
                // GST_PAD_LINK_NOFORMAT on otherwise compatible streams.
                let filter = gst::ElementFactory::make("capsfilter")
                    .property(
                        "caps",
                        gst::Caps::builder("audio/x-eac3")
                            .field("framed", true)
                            .field("alignment", "iec61937")
                            .build(),
                    )
                    .build()
                    .map_err(|error| Error::Pipeline(error.to_string()))?;
                elements.push(filter);
            } else if caps_name == "audio/x-ac3" {
                elements.push(make("ac3parse")?);
            } else {
                elements.push(make("aacparse")?);
            }
        }
        (TrackKind::Video, PlaybackMode::HybridRemux) => {
            elements.extend(make_mp4_h265_tail()?);
        }
        (TrackKind::Audio, PlaybackMode::HybridRemux) => {
            elements.extend([make("audioconvert")?, make("audioresample")?]);
            let caps_filter = gst::ElementFactory::make("capsfilter")
                .property(
                    "caps",
                    gst::Caps::builder("audio/x-raw")
                        .field("channels", 2i32)
                        .build(),
                )
                .build()
                .map_err(|error| Error::Pipeline(error.to_string()))?;
            elements.push(caps_filter);
            elements.push(make("avenc_aac")?);
            elements.push(make("aacparse")?);
        }
        (TrackKind::Video, _) => {
            let encoder = encoder
                .ok_or_else(|| Error::UnsupportedCodec("no H.264 encoder is installed".into()))?;
            if encoder.starts_with("d3d12") && runtime::has_element("d3d12convert") {
                // Windows D3D12 decode/convert/encode keeps UHD frames in GPU
                // memory instead of downloading them through videoconvert.
                elements.push(make("d3d12convert")?);
            } else if matches!(
                encoder,
                "qsvh264enc" | "nvh264enc" | "amfh264enc" | "mfh264enc"
            ) && runtime::has_element("d3d11convert")
            {
                // Vendor and Media Foundation encoders negotiate D3D11Memory
                // on Windows. d3d11convert also handles the upload when an
                // upstream decoder can only expose system memory.
                elements.push(make("d3d11convert")?);
            } else if encoder.starts_with("va") && runtime::has_element("vapostproc") {
                // VA decode -> VA post-process -> VA encode preserves GPU memory
                // on Linux instead of forcing a full-frame download/upload.
                elements.push(make("vapostproc")?);
            } else {
                elements.extend([make("videoconvert")?, make("videoscale")?]);
            }
            elements.push(make_realtime_h264_encoder(encoder)?);
            elements.extend(make_mp4_h264_tail()?);
        }
        (TrackKind::Audio, _) => {
            elements.extend([make("audioconvert")?, make("audioresample")?]);
            let caps_filter = gst::ElementFactory::make("capsfilter")
                .property(
                    "caps",
                    gst::Caps::builder("audio/x-raw")
                        .field("channels", 2i32)
                        .build(),
                )
                .build()
                .map_err(|error| Error::Pipeline(error.to_string()))?;
            elements.push(caps_filter);
            elements.push(make("avenc_aac")?);
            elements.push(make("aacparse")?);
        }
        (TrackKind::Subtitle, _) => return Ok(()),
    }

    for element in &elements {
        pipeline
            .add(element)
            .map_err(|error| Error::Pipeline(error.to_string()))?;
    }
    for pair in elements.windows(2) {
        let upstream = &pair[0];
        let downstream = &pair[1];
        upstream.link(downstream).map_err(|error| {
            let upstream_name = upstream.factory().map(|factory| factory.name()).unwrap_or_else(|| upstream.name());
            let downstream_name = downstream.factory().map(|factory| factory.name()).unwrap_or_else(|| downstream.name());
            let source_caps = upstream
                .static_pad("src")
                .map(|pad| pad.query_caps(None).to_string())
                .unwrap_or_else(|| "<dynamic>".into());
            let sink_caps = downstream
                .static_pad("sink")
                .map(|pad| pad.query_caps(None).to_string())
                .unwrap_or_else(|| "<dynamic>".into());
            Error::Pipeline(format!(
                "failed to link {upstream_name} [{source_caps}] to {downstream_name} [{sink_caps}]: {error}"
            ))
        })?;
    }
    let branch_src_pad = elements
        .last()
        .expect("branch always has elements")
        .static_pad("src")
        .ok_or_else(|| Error::Pipeline("encoded branch has no source pad".into()))?;
    branch_src_pad.link(mux_sink_pad).map_err(|error| {
        Error::Pipeline(format!("failed to link {kind:?} into mp4mux: {error}"))
    })?;
    let sink_pad = elements[0]
        .static_pad("sink")
        .ok_or_else(|| Error::Pipeline("queue has no sink pad".into()))?;
    source_pad.link(&sink_pad).map_err(|error| {
        Error::Pipeline(format!(
            "failed to link decoded {kind:?} pad [{}] into branch queue [{}]: {error}",
            source_pad.query_caps(None),
            sink_pad.query_caps(None),
        ))
    })?;
    for element in &elements {
        element
            .sync_state_with_parent()
            .map_err(|error| Error::Pipeline(error.to_string()))?;
    }
    Ok(())
}

#[cfg(feature = "gstreamer-runtime")]
fn request_mux_pad(mux: &gst::Element, template: &str) -> Result<gst::Pad> {
    use gst::prelude::*;

    mux.request_pad_simple(template).ok_or_else(|| {
        Error::Pipeline(format!(
            "mp4mux could not allocate a {template} request pad"
        ))
    })
}

#[cfg(feature = "gstreamer-runtime")]
fn make(name: &str) -> Result<gst::Element> {
    gst::ElementFactory::make(name)
        .build()
        .map_err(|error| Error::Pipeline(format!("{name} is unavailable: {error}")))
}

#[cfg(feature = "gstreamer-runtime")]
fn make_mp4_h264_tail() -> Result<[gst::Element; 2]> {
    let parser = gst::ElementFactory::make("h264parse")
        .property("config-interval", -1i32)
        .build()
        .map_err(|error| Error::Pipeline(format!("h264parse is unavailable: {error}")))?;
    let caps = gst::Caps::builder("video/x-h264")
        .field("stream-format", "avc")
        .field("alignment", "au")
        .build();
    let filter = gst::ElementFactory::make("capsfilter")
        .property("caps", caps)
        .build()
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    Ok([parser, filter])
}

#[cfg(feature = "gstreamer-runtime")]
fn make_mp4_h265_tail() -> Result<[gst::Element; 2]> {
    let parser = gst::ElementFactory::make("h265parse")
        .property("config-interval", -1i32)
        .build()
        .map_err(|error| Error::Pipeline(format!("h265parse is unavailable: {error}")))?;
    let caps = gst::Caps::builder("video/x-h265")
        .field("stream-format", "hvc1")
        .field("alignment", "au")
        .build();
    let filter = gst::ElementFactory::make("capsfilter")
        .property("caps", caps)
        .build()
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    Ok([parser, filter])
}

#[cfg(feature = "gstreamer-runtime")]
fn make_realtime_h264_encoder(name: &str) -> Result<gst::Element> {
    use gst::prelude::*;

    let encoder = make(name)?;
    let has = |property: &str| encoder.find_property(property).is_some();

    // Streaming needs bounded encode latency. These values remove look-ahead
    // and reference-frame work while retaining ordinary AVC compatibility.
    if has("b-frames") {
        encoder.set_property("b-frames", 0u32);
    }
    if has("bframes") {
        encoder.set_property("bframes", 0u32);
    }
    if has("ref-frames") {
        encoder.set_property("ref-frames", 1u32);
    }
    if has("key-int-max") {
        encoder.set_property("key-int-max", 48u32);
    }
    if has("target-usage") {
        encoder.set_property("target-usage", 7u32);
    }
    if has("rc-lookahead") {
        encoder.set_property("rc-lookahead", 0i32);
    }
    if has("sync-lookahead") {
        encoder.set_property("sync-lookahead", 0i32);
    }
    if has("qos") {
        encoder.set_property("qos", true);
    }
    if name == "x264enc" {
        encoder.set_property_from_str("speed-preset", "ultrafast");
        encoder.set_property_from_str("tune", "zerolatency");
    }
    Ok(encoder)
}

#[cfg(feature = "gstreamer-runtime")]
fn attach_discard_branch(pipeline: &gst::Pipeline, source_pad: &gst::Pad) -> Result<()> {
    use gst::prelude::*;

    // Legacy uridecodebin exposes every decoded stream. All pads still need a
    // downstream consumer or a many-track Matroska source can terminate with
    // GST_FLOW_NOT_LINKED after initially producing valid fragments.
    let queue = gst::ElementFactory::make("queue")
        .property("max-size-buffers", 1u32)
        .build()
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    let sink = gst::ElementFactory::make("fakesink")
        .property("sync", false)
        .property("async", false)
        .build()
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    pipeline
        .add_many([&queue, &sink])
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    queue.link(&sink).map_err(|error| {
        Error::Pipeline(format!("failed to link discard queue to sink: {error}"))
    })?;
    let sink_pad = queue
        .static_pad("sink")
        .ok_or_else(|| Error::Pipeline("discard queue has no sink pad".into()))?;
    source_pad.link(&sink_pad).map_err(|error| {
        Error::Pipeline(format!(
            "failed to link discarded pad [{}] into queue: {error}",
            source_pad.query_caps(None),
        ))
    })?;
    queue
        .sync_state_with_parent()
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    sink.sync_state_with_parent()
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    Ok(())
}

#[cfg(feature = "gstreamer-runtime")]
fn attach_subtitle_branch(
    pipeline: &gst::Pipeline,
    source_pad: &gst::Pad,
    on_subtitle: Arc<dyn Fn(SubtitleCue) + Send + Sync>,
) -> Result<()> {
    use gst::prelude::*;

    let queue = make("queue")?;
    let sink = gst::ElementFactory::make("appsink")
        .property("sync", false)
        .property("max-buffers", 256u32)
        .property("drop", false)
        .build()
        .map_err(|error| Error::Pipeline(error.to_string()))?
        .downcast::<gst_app::AppSink>()
        .map_err(|_| Error::Pipeline("failed to create subtitle appsink".into()))?;
    sink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let Some(buffer) = sample.buffer() else {
                    return Ok(gst::FlowSuccess::Ok);
                };
                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                let text = String::from_utf8_lossy(map.as_slice())
                    .trim_end_matches('\0')
                    .to_string();
                if !text.is_empty() {
                    let start = buffer.pts().map(|value| value.seconds_f64()).unwrap_or(0.0);
                    let duration = buffer
                        .duration()
                        .map(|value| value.seconds_f64())
                        .unwrap_or(3.0);
                    on_subtitle(SubtitleCue {
                        start_seconds: start,
                        end_seconds: start + duration,
                        text,
                    });
                }
                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );
    pipeline
        .add_many([&queue, sink.upcast_ref()])
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    queue.link(&sink).map_err(|error| {
        Error::Pipeline(format!("failed to link subtitle queue to appsink: {error}"))
    })?;
    let sink_pad = queue
        .static_pad("sink")
        .ok_or_else(|| Error::Pipeline("subtitle queue has no sink pad".into()))?;
    source_pad.link(&sink_pad).map_err(|error| {
        Error::Pipeline(format!(
            "failed to link subtitle pad [{}] into queue: {error}",
            source_pad.query_caps(None),
        ))
    })?;
    queue
        .sync_state_with_parent()
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    sink.sync_state_with_parent()
        .map_err(|error| Error::Pipeline(error.to_string()))?;
    Ok(())
}

#[cfg(feature = "gstreamer-runtime")]
pub(crate) fn configure_source(element: &gst::Element, source: &VideoSource) {
    use gst::prelude::*;

    if element.find_property("user-agent").is_some() {
        let user_agent = source.user_agent.as_deref().unwrap_or(
            "Mozilla/5.0 (Linux; Android TV) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/138.0 Safari/537.36",
        );
        element.set_property("user-agent", user_agent);
    }
    if element.find_property("timeout").is_some() {
        element.set_property("timeout", 60u32);
    }
    #[cfg(target_os = "android")]
    if element.find_property("keep-alive").is_some() {
        // Some large-file CDNs close ranged persistent responses without a
        // clean libsoup EOF. A fresh connection per range avoids surfacing that
        // server behavior as GST_FLOW_ERROR.
        element.set_property("keep-alive", false);
    }
    if let Some(cookies) = &source.cookies {
        if element.find_property("cookies").is_some() {
            let cookies = gst::glib::StrV::from([cookies.as_str()]);
            element.set_property("cookies", cookies);
        }
    }
    #[cfg(target_os = "android")]
    let default_ca_file = crate::android_static_plugins::tls_ca_file();
    #[cfg(not(target_os = "android"))]
    let default_ca_file: Option<&str> = None;
    if let Some(ca_file) = source.tls_ca_file.as_deref().or(default_ca_file) {
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

#[cfg(feature = "gstreamer-runtime")]
fn selected_h264_encoder(mode: PlaybackMode) -> Option<String> {
    match mode {
        PlaybackMode::Remux => None,
        PlaybackMode::HybridRemux => None,
        PlaybackMode::HardwareTranscode => runtime::selected_hardware_h264_encoder(),
        PlaybackMode::SoftwareTranscode => ["openh264enc", "x264enc", "avenc_h264"]
            .into_iter()
            .find(|name| runtime::has_element(name))
            .map(str::to_string),
    }
}

#[cfg(any(feature = "gstreamer-runtime", test))]
fn looks_like_mp4_header(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && matches!(&bytes[4..8], b"ftyp" | b"moov")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_mp4_initialization_boxes() {
        assert!(looks_like_mp4_header(b"\0\0\0\x18ftypisom"));
        assert!(looks_like_mp4_header(b"\0\0\0\x18moovsuffix"));
        assert!(!looks_like_mp4_header(b"prefixmoovsuffix"));
        assert!(!looks_like_mp4_header(b"\0\0\0\x18moof"));
    }

    #[cfg(feature = "gstreamer-runtime")]
    #[test]
    fn assembles_complete_fragmented_mp4_boxes() {
        fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
            let mut bytes = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(payload);
            bytes
        }
        let moof = boxed(b"moof", b"metadata");
        let mdat = boxed(b"mdat", b"encoded samples");
        let mut assembler = Mp4FragmentAssembler::default();
        assert!(assembler.push(&moof[..5]).unwrap().is_empty());
        assert!(assembler.push(&moof[5..]).unwrap().is_empty());
        assert!(assembler.push(&mdat[..8]).unwrap().is_empty());
        let output = assembler.push(&mdat[8..]).unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].len(), moof.len() + mdat.len());
        assert_eq!(&output[0][4..8], b"moof");
    }

    #[cfg(feature = "gstreamer-runtime")]
    #[test]
    fn remuxes_a_local_mkv_into_encoded_mp4_fragments() {
        assert_mkv_pipeline("openh264enc ! h264parse", PlaybackMode::Remux);
    }

    #[cfg(feature = "gstreamer-runtime")]
    #[test]
    fn transcodes_vp8_mkv_into_avc_mp4_fragments() {
        if !runtime::has_element("vp8enc") {
            eprintln!("skipping VP8 fixture because vp8enc is unavailable");
            return;
        }
        assert_mkv_pipeline("vp8enc", PlaybackMode::SoftwareTranscode);
    }

    #[cfg(feature = "gstreamer-runtime")]
    #[test]
    #[ignore = "requires qualification/https_range_server.py"]
    fn qualifies_https_codec_and_container_matrix() {
        use std::collections::BTreeMap;

        let base = std::env::var("TAURI_VIDEO_QUALIFICATION_BASE_URL")
            .expect("TAURI_VIDEO_QUALIFICATION_BASE_URL is required");
        let ca_file = std::env::var("TAURI_VIDEO_QUALIFICATION_CA_FILE")
            .expect("TAURI_VIDEO_QUALIFICATION_CA_FILE is required");
        let cases = [
            "h264-aac-30.mkv",
            "h264-aac-60.mkv",
            "h264-multitrack-subtitles.mkv",
            "vp8-vorbis.webm",
            "vp9-opus.webm",
            "hevc-ac3.mkv",
            "mpeg4-mp3.avi",
            "h264-aac.ts",
            "av1-opus.mkv",
            "h264-flac.mkv",
        ];
        let browser = BrowserCapabilities {
            media_source: true,
            managed_media_source: false,
            supported_mime_types: vec!["video/mp4; codecs=\"avc1.42E01E,mp4a.40.2\"".into()],
            hardware_concurrency: Some(8),
            user_agent: Some("qualification-webview".into()),
        };

        for name in cases {
            let source = VideoSource {
                uri: format!("{}/{name}", base.trim_end_matches('/')),
                headers: BTreeMap::from([("X-Tauri-Video-Qualification".into(), name.into())]),
                cookies: Some("qualification=true".into()),
                user_agent: Some("tauri-video-qualification/1.0".into()),
                referrer: Some("https://qualification.invalid/matrix".into()),
                tls_ca_file: Some(ca_file.clone()),
                start_position_seconds: None,
            };
            let media = crate::discovery::discover(&source)
                .unwrap_or_else(|error| panic!("failed to discover {name}: {error}"));
            assert!(
                media
                    .tracks
                    .iter()
                    .any(|track| track.kind == TrackKind::Video),
                "{name} has no discovered video"
            );
            let mode = runtime::choose_mode(&media, &browser);
            qualify_source_pipeline(&source, &media, mode, false)
                .unwrap_or_else(|error| panic!("failed to qualify {name} ({mode:?}): {error}"));
        }
    }

    #[cfg(feature = "gstreamer-runtime")]
    #[test]
    #[ignore = "requires qualification/https_range_server.py"]
    fn qualifies_second_audio_subtitles_and_https_seek() {
        use std::collections::BTreeMap;

        let base = std::env::var("TAURI_VIDEO_QUALIFICATION_BASE_URL")
            .expect("TAURI_VIDEO_QUALIFICATION_BASE_URL is required");
        let ca_file = std::env::var("TAURI_VIDEO_QUALIFICATION_CA_FILE")
            .expect("TAURI_VIDEO_QUALIFICATION_CA_FILE is required");
        let source = VideoSource {
            uri: format!(
                "{}/h264-multitrack-subtitles.mkv",
                base.trim_end_matches('/')
            ),
            headers: BTreeMap::new(),
            cookies: None,
            user_agent: Some("tauri-video-seek-qualification/1.0".into()),
            referrer: None,
            tls_ca_file: Some(ca_file),
            start_position_seconds: None,
        };
        let media = crate::discovery::discover(&source).expect("discover multitrack fixture");
        assert_eq!(
            media
                .tracks
                .iter()
                .filter(|track| track.kind == TrackKind::Audio)
                .count(),
            2
        );
        assert_eq!(
            media
                .tracks
                .iter()
                .filter(|track| track.kind == TrackKind::Subtitle)
                .count(),
            1
        );
        qualify_source_pipeline(&source, &media, PlaybackMode::Remux, true)
            .expect("qualify selected tracks");
    }

    #[cfg(feature = "gstreamer-runtime")]
    #[test]
    #[ignore = "requires qualification/https_range_server.py"]
    fn qualifies_h264_60_mp4_boundaries() {
        let base = std::env::var("TAURI_VIDEO_QUALIFICATION_BASE_URL")
            .expect("TAURI_VIDEO_QUALIFICATION_BASE_URL is required");
        let ca_file = std::env::var("TAURI_VIDEO_QUALIFICATION_CA_FILE")
            .expect("TAURI_VIDEO_QUALIFICATION_CA_FILE is required");
        let source = VideoSource {
            uri: format!("{}/h264-aac-60.mkv", base.trim_end_matches('/')),
            headers: Default::default(),
            cookies: None,
            user_agent: Some("tauri-video-boundary-qualification/1.0".into()),
            referrer: None,
            tls_ca_file: Some(ca_file),
            start_position_seconds: None,
        };
        let media = crate::discovery::discover(&source).expect("discover H.264 60fps fixture");
        qualify_source_pipeline(&source, &media, PlaybackMode::Remux, false)
            .expect("qualify H.264 60fps boundaries");
    }

    #[cfg(feature = "gstreamer-runtime")]
    fn qualify_source_pipeline(
        source: &VideoSource,
        media: &MediaInfo,
        mode: PlaybackMode,
        select_secondary_tracks: bool,
    ) -> std::result::Result<(), String> {
        use std::{
            sync::mpsc,
            time::{Duration, Instant},
        };

        let (events, received) = mpsc::channel();
        let pipeline = MediaPipeline::build(
            source,
            mode,
            StreamSelection {
                video_index: Some(0),
                audio_index: Some(usize::from(select_secondary_tracks)),
                subtitle_index: select_secondary_tracks.then_some(0),
            },
            PipelineCallbacks {
                on_init: Arc::new({
                    let events = events.clone();
                    move |bytes| {
                        if std::env::var_os("TAURI_VIDEO_QUALIFICATION_TRACE_MP4").is_some() {
                            eprintln!(
                                "init chunk: {} bytes, boxes={:?}",
                                bytes.len(),
                                mp4_box_names(bytes)
                            );
                        }
                        let _ = events.send(("init", bytes.len()));
                    }
                }),
                on_fragment: Arc::new({
                    let events = events.clone();
                    move |bytes, _| {
                        if std::env::var_os("TAURI_VIDEO_QUALIFICATION_TRACE_MP4").is_some() {
                            eprintln!(
                                "media chunk: {} bytes, boxes={:?}",
                                bytes.len(),
                                mp4_box_names(&bytes)
                            );
                        }
                        let _ = events.send(("fragment", bytes.len()));
                    }
                }),
                on_subtitle: Arc::new({
                    let events = events.clone();
                    move |cue| {
                        let _ = events.send(("subtitle", cue.text.len()));
                    }
                }),
                on_error: Arc::new({
                    let events = events.clone();
                    move |message| {
                        eprintln!("pipeline error: {message}");
                        let _ = events.send(("error", message.len()));
                    }
                }),
                on_eos: Arc::new(move || {
                    let _ = events.send(("eos", 0));
                }),
            },
        )
        .map_err(|error| error.to_string())?;
        pipeline
            .set_playback_state(PlaybackState::Playing)
            .map_err(|error| error.to_string())?;

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut init_bytes = 0;
        let mut fragment_bytes = 0;
        let mut subtitle_cues = 0;
        let mut seeked = false;
        while Instant::now() < deadline {
            match received.recv_timeout(Duration::from_millis(250)) {
                Ok(("init", size)) => init_bytes += size,
                Ok(("fragment", size)) => {
                    fragment_bytes += size;
                    if select_secondary_tracks && !seeked {
                        pipeline.seek(3.0).map_err(|error| error.to_string())?;
                        seeked = true;
                    }
                }
                Ok(("subtitle", _)) => subtitle_cues += 1,
                Ok(("error", _)) => return Err("pipeline emitted an error".into()),
                Ok(("eos", _)) => break,
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        if init_bytes == 0 || fragment_bytes == 0 {
            return Err(format!(
                "missing output: init={init_bytes}, fragments={fragment_bytes}, tracks={:?}",
                media.tracks
            ));
        }
        if select_secondary_tracks && (!seeked || subtitle_cues == 0) {
            return Err(format!(
                "seek/subtitle evidence missing: seeked={seeked}, cues={subtitle_cues}"
            ));
        }
        Ok(())
    }

    #[cfg(feature = "gstreamer-runtime")]
    fn mp4_box_names(mut bytes: &[u8]) -> Vec<String> {
        let mut names = Vec::new();
        while bytes.len() >= 8 {
            let size = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
            if size < 8 || size > bytes.len() {
                break;
            }
            names.push(String::from_utf8_lossy(&bytes[4..8]).into_owned());
            bytes = &bytes[size..];
        }
        names
    }

    #[cfg(feature = "gstreamer-runtime")]
    fn assert_mkv_pipeline(encoder_chain: &str, mode: PlaybackMode) {
        use std::{
            collections::BTreeMap,
            sync::mpsc,
            time::{Duration, Instant},
        };

        use gst::prelude::*;

        runtime::initialize().expect("GStreamer should initialize");
        if !runtime::has_element("openh264enc") {
            eprintln!("skipping fixture generation because openh264enc is unavailable");
            return;
        }
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("fixture.mkv");
        let launch = format!(
            "videotestsrc num-buffers=45 ! video/x-raw,width=160,height=90,framerate=30/1 \
             ! videoconvert ! {encoder_chain} ! matroskamux ! filesink location={}",
            path.display(),
        );
        let fixture = gst::parse::launch(&launch).expect("fixture pipeline");
        fixture
            .set_state(gst::State::Playing)
            .expect("play fixture");
        let bus = fixture.bus().expect("fixture bus");
        let message = bus.timed_pop_filtered(
            gst::ClockTime::from_seconds(10),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        fixture.set_state(gst::State::Null).expect("stop fixture");
        assert!(message.is_some(), "fixture generation timed out");

        let (events, received) = mpsc::channel();
        let pipeline = MediaPipeline::build(
            &VideoSource {
                uri: url::Url::from_file_path(&path).unwrap().to_string(),
                headers: BTreeMap::new(),
                cookies: None,
                user_agent: None,
                referrer: None,
                tls_ca_file: None,
                start_position_seconds: None,
            },
            mode,
            StreamSelection {
                video_index: Some(0),
                audio_index: None,
                subtitle_index: None,
            },
            PipelineCallbacks {
                on_init: Arc::new({
                    let events = events.clone();
                    move |bytes| {
                        let _ = events.send(("init", bytes.len()));
                    }
                }),
                on_fragment: Arc::new({
                    let events = events.clone();
                    move |bytes, _| {
                        let _ = events.send(("fragment", bytes.len()));
                    }
                }),
                on_subtitle: Arc::new(|_| {}),
                on_error: Arc::new({
                    let events = events.clone();
                    move |message| {
                        let _ = events.send(("error", message.len()));
                    }
                }),
                on_eos: Arc::new(move || {
                    let _ = events.send(("eos", 0));
                }),
            },
        )
        .expect("video pipeline");
        pipeline
            .set_playback_state(PlaybackState::Playing)
            .expect("play pipeline");

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut init_bytes = 0;
        let mut fragment_bytes = 0;
        while Instant::now() < deadline {
            match received.recv_timeout(Duration::from_millis(250)) {
                Ok(("init", size)) => init_bytes += size,
                Ok(("fragment", size)) => fragment_bytes += size,
                Ok(("error", _)) => panic!("video pipeline emitted an error"),
                Ok(("eos", _)) => break,
                Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(init_bytes > 0, "missing MP4 initialization data");
        assert!(fragment_bytes > 0, "missing MP4 media fragments");
    }
}
