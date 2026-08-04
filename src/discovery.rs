#[cfg(feature = "gstreamer-runtime")]
use gstreamer as gst;
#[cfg(feature = "gstreamer-runtime")]
use gstreamer_pbutils as gst_pbutils;

use crate::{models::*, runtime, Error, Result};

pub fn discover(source: &VideoSource) -> Result<MediaInfo> {
    validate_source(source)?;
    runtime::initialize()?;

    #[cfg(feature = "gstreamer-runtime")]
    {
        use gst_pbutils::prelude::*;

        // Android/TV emulators can take substantially longer to walk the headers
        // of very large remote Matroska remuxes (especially through redirects).
        // This is only a discovery deadline: GStreamer still performs ranged,
        // streaming reads and never downloads the complete asset first.
        #[cfg(target_os = "android")]
        let discovery_timeout = gst::ClockTime::from_seconds(90);
        #[cfg(not(target_os = "android"))]
        let discovery_timeout = gst::ClockTime::from_seconds(20);
        let discoverer = gst_pbutils::Discoverer::new(discovery_timeout)
            .map_err(|error| Error::Discovery(error.to_string()))?;
        let source_options = source.clone();
        discoverer.connect_source_setup(move |_, element| {
            crate::pipeline::configure_source(element, &source_options);
        });
        let info = match discoverer.discover_uri(&source.uri) {
            Ok(info) => info,
            Err(error) => {
                #[cfg(target_os = "android")]
                if error.to_string().contains("Internal data stream error")
                    && url::Url::parse(&source.uri)
                        .is_ok_and(|uri| matches!(uri.scheme(), "http" | "https"))
                {
                    tracing::warn!(%error, uri = %source.uri, "Android discoverer rejected a remote child stream; deferring stream selection to decodebin");
                    return Ok(android_stream_fallback(&source.uri));
                }
                return Err(Error::Discovery(error.to_string()));
            }
        };

        if info.result() != gst_pbutils::DiscovererResult::Ok {
            let missing = info
                .missing_elements_installer_details()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            return Err(Error::Discovery(if missing.is_empty() {
                format!("discoverer returned {:?}", info.result())
            } else {
                format!("missing runtime elements: {missing}")
            }));
        }

        let mut tracks = Vec::new();
        for (index, video) in info.video_streams().into_iter().enumerate() {
            let caps = video
                .caps()
                .map(|caps| caps.to_string())
                .unwrap_or_default();
            let rate = video.framerate();
            tracks.push(MediaTrack {
                id: video
                    .stream_id()
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| format!("video-{index}")),
                kind: TrackKind::Video,
                stream_index: index,
                codec: codec_from_caps(&caps),
                caps,
                label: None,
                language: None,
                selected: index == 0,
                default: index == 0,
                forced: false,
                width: Some(video.width()),
                height: Some(video.height()),
                frame_rate: (rate.denom() != 0).then(|| rate.numer() as f64 / rate.denom() as f64),
                channels: None,
                sample_rate: None,
            });
        }
        for (index, audio) in info.audio_streams().into_iter().enumerate() {
            let caps = audio
                .caps()
                .map(|caps| caps.to_string())
                .unwrap_or_default();
            tracks.push(MediaTrack {
                id: audio
                    .stream_id()
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| format!("audio-{index}")),
                kind: TrackKind::Audio,
                stream_index: index,
                codec: codec_from_caps(&caps),
                caps,
                label: None,
                language: audio.language().map(|value| value.to_string()),
                selected: index == 0,
                default: index == 0,
                forced: false,
                width: None,
                height: None,
                frame_rate: None,
                channels: Some(audio.channels()),
                sample_rate: Some(audio.sample_rate()),
            });
        }
        for (index, subtitle) in info.subtitle_streams().into_iter().enumerate() {
            let caps = subtitle
                .caps()
                .map(|caps| caps.to_string())
                .unwrap_or_default();
            tracks.push(MediaTrack {
                id: subtitle
                    .stream_id()
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| format!("subtitle-{index}")),
                kind: TrackKind::Subtitle,
                stream_index: index,
                codec: codec_from_caps(&caps),
                caps,
                label: None,
                language: subtitle.language().map(|value| value.to_string()),
                selected: false,
                default: false,
                forced: false,
                width: None,
                height: None,
                frame_rate: None,
                channels: None,
                sample_rate: None,
            });
        }

        let container = info
            .container_streams()
            .first()
            .and_then(|stream| stream.caps())
            .map(|caps| caps.to_string())
            .or_else(|| container_from_uri(&source.uri));

        Ok(MediaInfo {
            duration_seconds: info.duration().map(|value| value.seconds_f64()),
            seekable: info.is_seekable(),
            live: info.is_live(),
            container,
            tracks,
            chapters: Vec::new(),
        })
    }

    #[cfg(not(feature = "gstreamer-runtime"))]
    unreachable!()
}

#[cfg(all(feature = "gstreamer-runtime", target_os = "android"))]
fn android_stream_fallback(uri: &str) -> MediaInfo {
    let track = |id: &str, kind: TrackKind| MediaTrack {
        id: id.into(),
        kind,
        stream_index: 0,
        // Unknown deliberately selects the transcode path. decodebin performs
        // the authoritative stream/caps selection once the pipeline is live.
        codec: "unknown".into(),
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
    };
    MediaInfo {
        duration_seconds: None,
        seekable: true,
        live: false,
        container: container_from_uri(uri),
        tracks: vec![
            track("video-0", TrackKind::Video),
            track("audio-0", TrackKind::Audio),
        ],
        chapters: Vec::new(),
    }
}

fn container_from_uri(uri: &str) -> Option<String> {
    let path = url::Url::parse(uri).ok()?.path().to_ascii_lowercase();
    let container = if path.ends_with(".mkv") {
        "video/x-matroska"
    } else if path.ends_with(".webm") {
        "video/webm"
    } else if path.ends_with(".avi") {
        "video/x-msvideo"
    } else if path.ends_with(".ts") || path.ends_with(".m2ts") || path.ends_with(".mts") {
        "video/mpegts"
    } else if path.ends_with(".mp4") || path.ends_with(".m4v") || path.ends_with(".mov") {
        "video/quicktime"
    } else {
        return None;
    };
    Some(container.into())
}

pub fn validate_source(source: &VideoSource) -> Result<()> {
    if source.uri.len() > 16 * 1024 {
        return Err(Error::InvalidRequest("source URI is too long".into()));
    }
    let parsed = url::Url::parse(&source.uri)
        .map_err(|error| Error::InvalidRequest(format!("invalid source URI: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https" | "file" | "content") {
        return Err(Error::SourceDenied(parsed.scheme().into()));
    }
    if source.headers.len() > 64 {
        return Err(Error::InvalidRequest("too many request headers".into()));
    }
    for (name, value) in &source.headers {
        if name.is_empty()
            || name.contains(['\r', '\n'])
            || value.contains(['\r', '\n'])
            || name.len() > 256
            || value.len() > 8 * 1024
        {
            return Err(Error::InvalidRequest(format!(
                "invalid request header: {name}"
            )));
        }
    }
    Ok(())
}

#[cfg(any(feature = "gstreamer-runtime", test))]
pub fn codec_from_caps(caps: &str) -> String {
    let lower = caps.to_ascii_lowercase();
    for (needle, codec) in [
        ("video/x-h264", "h264"),
        ("video/x-h265", "h265"),
        ("video/x-vp9", "vp9"),
        ("video/x-vp8", "vp8"),
        ("video/x-av1", "av1"),
        ("video/mpeg", "mpeg-video"),
        ("audio/x-opus", "opus"),
        ("audio/x-vorbis", "vorbis"),
        ("audio/x-flac", "flac"),
        ("audio/x-ac3", "ac3"),
        ("audio/x-eac3", "eac3"),
        ("audio/x-dts", "dts"),
        ("application/x-ass", "ass"),
        ("application/x-ssa", "ssa"),
        ("subpicture/x-pgs", "pgs"),
        ("subpicture/x-dvd", "vobsub"),
        ("text/x-raw", "text"),
    ] {
        if lower.contains(needle) {
            return codec.into();
        }
    }
    if lower.contains("audio/mpeg") && lower.contains("mpegversion=(int)4") {
        return "aac".into();
    }
    caps.split(',').next().unwrap_or("unknown").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn rejects_header_injection() {
        let source = VideoSource {
            uri: "https://example.com/movie.mkv".into(),
            headers: BTreeMap::from([("X-Test".into(), "ok\r\nInjected: yes".into())]),
            cookies: None,
            user_agent: None,
            referrer: None,
            tls_ca_file: None,
            start_position_seconds: None,
        };
        assert!(matches!(
            validate_source(&source),
            Err(Error::InvalidRequest(_))
        ));
    }

    #[test]
    fn maps_common_caps_to_stable_codec_names() {
        assert_eq!(
            codec_from_caps("video/x-h264, stream-format=(string)avc"),
            "h264"
        );
        assert_eq!(codec_from_caps("audio/mpeg, mpegversion=(int)4"), "aac");
        assert_eq!(codec_from_caps("subpicture/x-pgs"), "pgs");
    }

    #[test]
    fn infers_container_from_url_path_when_discovery_omits_it() {
        assert_eq!(
            container_from_uri("https://example.com/watch/Movie.MKV?token=secret").as_deref(),
            Some("video/x-matroska")
        );
        assert_eq!(
            container_from_uri("https://example.com/video.mp4").as_deref(),
            Some("video/quicktime")
        );
        assert_eq!(container_from_uri("https://example.com/stream"), None);
    }
}
