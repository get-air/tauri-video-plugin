use std::collections::BTreeMap;

#[cfg(feature = "gstreamer-runtime")]
use std::sync::OnceLock;

use crate::{models::*, Error, Result};

#[cfg(feature = "gstreamer-runtime")]
use gstreamer as gst;

#[cfg(feature = "gstreamer-runtime")]
static GST_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();

pub fn initialize() -> Result<()> {
    #[cfg(feature = "gstreamer-runtime")]
    {
        GST_INIT
            .get_or_init(|| {
                gst::init().map_err(|error| error.to_string())?;
                Ok(())
            })
            .clone()
            .map_err(Error::RuntimeUnavailable)
    }
    #[cfg(not(feature = "gstreamer-runtime"))]
    {
        Err(Error::RuntimeUnavailable(
            "crate was built without the gstreamer-runtime feature".into(),
        ))
    }
}

pub fn capabilities(config: &VideoPluginConfig) -> RuntimeCapabilities {
    let initialized = initialize();
    let mut elements = BTreeMap::new();
    for name in [
        "uridecodebin",
        "souphttpsrc",
        "matroskademux",
        "dashdemux",
        "hlsdemux2",
        "mp4mux",
        "webmmux",
        "h264parse",
        "aacparse",
        "openh264enc",
        "avenc_aac",
        "avdec_h264",
        "avdec_h265",
        "avdec_vp8",
        "avdec_vp9",
        "avdec_av1",
        "vp8enc",
        "opusenc",
        "vah264dec",
        "vah264enc",
        "qsvh264dec",
        "qsvh264enc",
        "d3d11h264dec",
        "d3d11h265dec",
        "d3d11convert",
        "d3d12convert",
        "d3d12h264enc",
        "mfh264enc",
        "nvh264enc",
        "amfh264enc",
    ] {
        elements.insert(name.to_string(), has_element(name));
    }

    RuntimeCapabilities {
        available: initialized.is_ok(),
        version: version_string(),
        plugin_version: env!("CARGO_PKG_VERSION").into(),
        min_android_sdk: 24,
        platform: std::env::consts::OS.into(),
        elements,
        supported_input_schemes: vec![
            "http".into(),
            "https".into(),
            "file".into(),
            "content".into(),
        ],
        limits: RuntimeLimits {
            global_memory_mib: if cfg!(mobile) {
                config.mobile_memory_budget_mib
            } else {
                config.desktop_memory_budget_mib
            },
            session_memory_mib: config.session_memory_budget_mib,
            max_transcoders: if cfg!(mobile) {
                config.max_mobile_transcoders
            } else {
                config.max_desktop_transcoders
            },
        },
        error: initialized.err().map(|error| error.to_string()),
    }
}

pub fn has_element(name: &str) -> bool {
    #[cfg(feature = "gstreamer-runtime")]
    {
        initialize().is_ok() && gst::ElementFactory::find(name).is_some()
    }
    #[cfg(not(feature = "gstreamer-runtime"))]
    {
        let _ = name;
        false
    }
}

fn version_string() -> Option<String> {
    #[cfg(feature = "gstreamer-runtime")]
    {
        initialize().ok().map(|_| gst::version_string().to_string())
    }
    #[cfg(not(feature = "gstreamer-runtime"))]
    {
        None
    }
}

pub fn choose_mode(info: &MediaInfo, browser: &BrowserCapabilities) -> PlaybackMode {
    let video = info
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video && track.selected)
        .or_else(|| {
            info.tracks
                .iter()
                .find(|track| track.kind == TrackKind::Video)
        });
    let audio = info
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Audio && track.selected)
        .or_else(|| {
            info.tracks
                .iter()
                .find(|track| track.kind == TrackKind::Audio)
        });
    // The zero-decode path is deliberately conservative: the current fragmented-MP4
    // mux branch negotiates AVC plus AAC. Everything else goes through a selected
    // hardware encoder when available, then the software fallback.
    let supports_hevc = browser.supported_mime_types.iter().any(|mime| {
        let mime = mime.to_ascii_lowercase();
        mime.contains("hvc1") || mime.contains("hev1")
    });
    let video_compatible =
        video.is_none_or(|track| track.codec == "h264" || (track.codec == "h265" && supports_hevc));
    let supports_eac3 = browser
        .supported_mime_types
        .iter()
        .any(|mime| mime.to_ascii_lowercase().contains("ec-3"));
    let audio_compatible =
        audio.is_none_or(|track| track.codec == "aac" || (track.codec == "eac3" && supports_eac3));
    let supports_mp4 = browser.media_source
        && browser
            .supported_mime_types
            .iter()
            .any(|mime| mime.starts_with("video/mp4"));

    if video_compatible && audio_compatible && supports_mp4 {
        PlaybackMode::Remux
    } else if video_compatible && supports_mp4 {
        // Keep the browser-compatible encoded video untouched while converting
        // only unsupported audio (TrueHD/E-AC-3/etc.) to AAC.
        PlaybackMode::HybridRemux
    } else if hardware_encoder_available() {
        PlaybackMode::HardwareTranscode
    } else {
        PlaybackMode::SoftwareTranscode
    }
}

fn hardware_encoder_available() -> bool {
    selected_hardware_h264_encoder().is_some()
}

pub(crate) fn selected_hardware_h264_encoder() -> Option<String> {
    #[cfg(feature = "gstreamer-runtime")]
    {
        use gst::prelude::*;

        if initialize().is_err() {
            return None;
        }
        let factories = gst::ElementFactory::factories_with_type(
            gst::ElementFactoryType::VIDEO_ENCODER | gst::ElementFactoryType::HARDWARE,
            gst::Rank::NONE,
        );
        let supports_h264 = |factory: &gst::ElementFactory| {
            factory.has_type(gst::ElementFactoryType::VIDEO_ENCODER)
                && factory.has_type(gst::ElementFactoryType::HARDWARE)
                && !is_software_only_h264_encoder(factory.name().as_str())
                && factory.static_pad_templates().iter().any(|template| {
                    template.direction() == gst::PadDirection::Src
                        && template.caps().to_string().contains("video/x-h264")
                })
        };

        // Prefer mature zero-copy platform encoders over the registry's
        // unspecified ordering for rank-none hardware elements. Android codec
        // names are device-specific and continue through the generic fallback.
        for preferred in [
            "vah264enc",
            "qsvh264enc",
            "nvh264enc",
            "amfh264enc",
            "d3d12h264enc",
            "mfh264enc",
            "vtenc_h264_hw",
            "vulkanh264enc",
        ] {
            if factories.iter().any(|factory| {
                factory.name() == preferred
                    && supports_h264(factory)
                    && encoder_reaches_ready(preferred)
            }) {
                return Some(preferred.to_string());
            }
        }

        factories
            .into_iter()
            .filter(supports_h264)
            .map(|factory| factory.name().to_string())
            .find(|name| encoder_reaches_ready(name))
    }
    #[cfg(not(feature = "gstreamer-runtime"))]
    None
}

fn is_software_only_h264_encoder(name: &str) -> bool {
    matches!(name, "openh264enc" | "x264enc" | "avenc_h264")
}

#[cfg(feature = "gstreamer-runtime")]
fn encoder_reaches_ready(name: &str) -> bool {
    use gst::prelude::*;

    let Ok(element) = gst::ElementFactory::make(name).build() else {
        return false;
    };
    let usable = element.set_state(gst::State::Ready).is_ok();
    let _ = element.set_state(gst::State::Null);
    usable
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn software_encoders_are_never_reported_as_hardware() {
        for name in ["openh264enc", "x264enc", "avenc_h264"] {
            assert!(is_software_only_h264_encoder(name));
        }
        assert!(!is_software_only_h264_encoder("vah264enc"));
    }

    fn info(video: &str, audio: &str) -> MediaInfo {
        MediaInfo {
            duration_seconds: Some(60.0),
            seekable: true,
            live: false,
            container: Some("Matroska".into()),
            chapters: vec![],
            tracks: vec![
                MediaTrack {
                    id: "v0".into(),
                    kind: TrackKind::Video,
                    stream_index: 0,
                    codec: video.into(),
                    caps: String::new(),
                    label: None,
                    language: None,
                    selected: true,
                    default: true,
                    forced: false,
                    width: None,
                    height: None,
                    frame_rate: None,
                    channels: None,
                    sample_rate: None,
                },
                MediaTrack {
                    id: "a0".into(),
                    kind: TrackKind::Audio,
                    stream_index: 0,
                    codec: audio.into(),
                    caps: String::new(),
                    label: None,
                    language: None,
                    selected: true,
                    default: true,
                    forced: false,
                    width: None,
                    height: None,
                    frame_rate: None,
                    channels: Some(2),
                    sample_rate: Some(48_000),
                },
            ],
        }
    }

    #[test]
    fn compatible_mkv_is_remuxed() {
        let browser = BrowserCapabilities {
            media_source: true,
            managed_media_source: false,
            supported_mime_types: vec!["video/mp4; codecs=\"avc1.42E01E,mp4a.40.2\"".into()],
            hardware_concurrency: None,
            user_agent: None,
        };
        assert_eq!(
            choose_mode(&info("h264", "aac"), &browser),
            PlaybackMode::Remux
        );
    }

    #[test]
    fn hevc_is_not_sent_to_the_avc_remux_branch() {
        let browser = BrowserCapabilities {
            media_source: true,
            managed_media_source: false,
            supported_mime_types: vec!["video/mp4; codecs=\"avc1.42E01E,mp4a.40.2\"".into()],
            hardware_concurrency: None,
            user_agent: None,
        };
        assert_ne!(
            choose_mode(&info("h265", "aac"), &browser),
            PlaybackMode::Remux
        );
    }
}
