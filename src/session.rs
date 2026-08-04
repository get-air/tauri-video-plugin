use std::{collections::HashMap, sync::Arc};

use parking_lot::{Mutex, RwLock};
use uuid::Uuid;

use crate::{
    broker::{BrokerSession, FragmentBroker, FragmentStore},
    discovery,
    models::*,
    pipeline::{MediaPipeline, PipelineCallbacks, StreamSelection},
    runtime, Error, Result,
};

struct Session {
    id: Uuid,
    source: VideoSource,
    media: RwLock<MediaInfo>,
    mode: PlaybackMode,
    mime_type: String,
    store: Arc<RwLock<FragmentStore>>,
    pipeline: Mutex<Option<MediaPipeline>>,
    state: RwLock<PlaybackState>,
    stats: Arc<RwLock<SessionStats>>,
}

impl Session {
    fn generation(&self) -> u64 {
        self.store.read().generation()
    }
}

pub struct SessionManager {
    config: VideoPluginConfig,
    broker: FragmentBroker,
    sessions: RwLock<HashMap<Uuid, Arc<Session>>>,
}

impl SessionManager {
    pub fn new(config: VideoPluginConfig) -> Self {
        Self {
            broker: FragmentBroker::new(config.allowed_origins.clone()),
            config,
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub fn runtime_capabilities(&self) -> RuntimeCapabilities {
        runtime::capabilities(&self.config)
    }

    pub async fn create_session(&self, request: CreateSessionRequest) -> Result<SessionDescriptor> {
        if !request.browser.media_source {
            return Err(Error::InvalidRequest(
                "this WebView does not expose MediaSource".into(),
            ));
        }
        discovery::validate_source(&request.source)?;
        self.enforce_session_budget()?;

        let source_for_discovery = request.source.clone();
        let mut media = tauri::async_runtime::spawn_blocking(move || {
            discovery::discover(&source_for_discovery)
        })
        .await
        .map_err(|error| Error::Discovery(error.to_string()))??;
        prefer_native_audio_track(&mut media, &request.browser);
        let mode = runtime::choose_mode(&media, &request.browser);
        self.enforce_transcoder_budget(mode)?;

        if request.transcode_policy == TranscodePolicy::HardwareOnly
            && mode == PlaybackMode::SoftwareTranscode
        {
            return Err(Error::UnsupportedCodec(
                "the source needs transcoding but no compatible hardware encoder is installed"
                    .into(),
            ));
        }

        let address = self.broker.ensure_started().await?;
        let id = Uuid::new_v4();
        let max_bytes = self.config.session_memory_budget_mib * 1024 * 1024;
        let store = Arc::new(RwLock::new(FragmentStore::new(max_bytes)));
        let mime_type = fragment_mime_type(&media, mode);
        self.broker.register(
            id,
            BrokerSession {
                store: store.clone(),
                mime_type: mime_type.clone(),
            },
        );

        let stats = Arc::new(RwLock::new(initial_stats(id, mode, &media)));
        let callbacks = callbacks(store.clone(), stats.clone());
        let selection = StreamSelection::from_media(&media);
        let pipeline = match MediaPipeline::build(&request.source, mode, selection, callbacks) {
            Ok(pipeline) => pipeline,
            Err(error) => {
                self.broker.unregister(&id);
                return Err(error);
            }
        };
        if let Some(backend) = pipeline.backend() {
            stats.write().hardware_backend = Some(backend.into());
        }

        let session = Arc::new(Session {
            id,
            source: request.source,
            media: RwLock::new(media.clone()),
            mode,
            mime_type: mime_type.clone(),
            store,
            pipeline: Mutex::new(Some(pipeline)),
            state: RwLock::new(PlaybackState::Paused),
            stats,
        });
        self.sessions.write().insert(id, session.clone());

        let transport = self.transport(address, &session);
        Ok(SessionDescriptor {
            session_id: id,
            mode,
            media,
            transport,
        })
    }

    pub fn set_playback_state(&self, request: SetPlaybackStateRequest) -> Result<()> {
        let session = self.session(request.session_id)?;
        let pipeline = session.pipeline.lock();
        let pipeline = pipeline
            .as_ref()
            .ok_or_else(|| Error::Pipeline("session is stopped".into()))?;
        pipeline.set_playback_state(request.state)?;
        *session.state.write() = request.state;
        session.stats.write().state = Some(request.state);
        Ok(())
    }

    pub async fn seek(&self, request: SeekRequest) -> Result<SeekResponse> {
        let session = self.session(request.session_id)?;
        if !request.position_seconds.is_finite() || request.position_seconds < 0.0 {
            return Err(Error::InvalidRequest("invalid seek position".into()));
        }
        let generation = self.rebuild_pipeline(&session, request.position_seconds)?;
        let address = self.broker.ensure_started().await?;
        Ok(SeekResponse {
            generation,
            transport: self.transport(address, &session),
        })
    }

    pub async fn select_track(&self, request: SelectTrackRequest) -> Result<SeekResponse> {
        let session = self.session(request.session_id)?;
        {
            let mut media = session.media.write();
            if let Some(track_id) = &request.track_id {
                let valid = media
                    .tracks
                    .iter()
                    .any(|track| track.kind == request.kind && &track.id == track_id);
                if !valid {
                    return Err(Error::InvalidRequest(format!("unknown track: {track_id}")));
                }
            }
            for track in &mut media.tracks {
                if track.kind == request.kind {
                    track.selected = request.track_id.as_ref().is_some_and(|id| id == &track.id);
                }
            }
        }
        let position = request.position_seconds.unwrap_or_else(|| {
            session
                .pipeline
                .lock()
                .as_ref()
                .map(MediaPipeline::position_seconds)
                .unwrap_or_default()
        });
        if !position.is_finite() || position < 0.0 {
            return Err(Error::InvalidRequest(
                "invalid track-switch position".into(),
            ));
        }
        let generation = self.rebuild_pipeline(&session, position)?;
        let address = self.broker.ensure_started().await?;
        Ok(SeekResponse {
            generation,
            transport: self.transport(address, &session),
        })
    }

    pub fn update_visibility(&self, request: VisibilityRequest) -> Result<()> {
        if !(0.0..=1.0).contains(&request.intersection_ratio) {
            return Err(Error::InvalidRequest(
                "intersectionRatio must be between 0 and 1".into(),
            ));
        }
        let session = self.session(request.session_id)?;
        let mut stats = session.stats.write();
        stats.visible = request.visible && request.intersection_ratio > 0.0;
        Ok(())
    }

    pub fn stats(&self, id: Uuid) -> Result<SessionStats> {
        let session = self.session(id)?;
        let mut stats = session.stats.read().clone();
        let store = session.store.read();
        stats.generation = store.generation();
        stats.encoded_bytes_buffered = store.total_bytes() as u64;
        stats.fragments_buffered = store.fragment_count();
        stats.source_buffer_ahead_seconds = store.total_duration_seconds();
        stats.state = Some(*session.state.read());
        stats.mode = Some(session.mode);
        Ok(stats)
    }

    pub fn destroy(&self, id: Uuid) -> Result<()> {
        let session = self
            .sessions
            .write()
            .remove(&id)
            .ok_or(Error::SessionNotFound)?;
        self.broker.unregister(&session.id);
        session.pipeline.lock().take();
        Ok(())
    }

    #[cfg(mobile)]
    pub fn has_playing_sessions(&self) -> bool {
        self.sessions
            .read()
            .values()
            .any(|session| *session.state.read() == PlaybackState::Playing)
    }

    fn session(&self, id: Uuid) -> Result<Arc<Session>> {
        self.sessions
            .read()
            .get(&id)
            .cloned()
            .ok_or(Error::SessionNotFound)
    }

    fn enforce_session_budget(&self) -> Result<()> {
        let global_mib = if cfg!(mobile) {
            self.config.mobile_memory_budget_mib
        } else {
            self.config.desktop_memory_budget_mib
        };
        let maximum = (global_mib / self.config.session_memory_budget_mib.max(1)).max(1);
        if self.sessions.read().len() >= maximum {
            Err(Error::ResourceLimit)
        } else {
            Ok(())
        }
    }

    fn enforce_transcoder_budget(&self, mode: PlaybackMode) -> Result<()> {
        if matches!(mode, PlaybackMode::Remux | PlaybackMode::HybridRemux) {
            return Ok(());
        }
        let limit = if cfg!(mobile) {
            self.config.max_mobile_transcoders
        } else {
            self.config.max_desktop_transcoders
        };
        let active = self
            .sessions
            .read()
            .values()
            .filter(|session| {
                !matches!(
                    session.mode,
                    PlaybackMode::Remux | PlaybackMode::HybridRemux
                )
            })
            .count();
        (active < limit).then_some(()).ok_or(Error::ResourceLimit)
    }

    fn rebuild_pipeline(&self, session: &Session, position_seconds: f64) -> Result<u64> {
        // Stop the producer before clearing its generation. This prevents a late
        // appsink callback from inserting pre-seek bytes into the new byte stream.
        session.pipeline.lock().take();
        let generation = session.store.write().reset();
        let callbacks = callbacks(session.store.clone(), session.stats.clone());
        let selection = StreamSelection::from_media(&session.media.read());
        let replacement =
            MediaPipeline::build(&session.source, session.mode, selection, callbacks)?;
        if position_seconds > 0.0 {
            replacement.seek(position_seconds)?;
        }
        replacement.set_playback_state(*session.state.read())?;
        session.pipeline.lock().replace(replacement);
        session.stats.write().generation = generation;
        Ok(generation)
    }

    fn transport(&self, address: std::net::SocketAddr, session: &Session) -> FragmentTransport {
        let generation = session.generation();
        let (base_url, init_url, fragment_url_template, subtitle_url_template) =
            FragmentBroker::transport_urls(address, session.id, generation);
        FragmentTransport {
            base_url,
            generation,
            mime_type: session.mime_type.clone(),
            init_url,
            fragment_url_template,
            subtitle_url_template,
        }
    }
}

fn callbacks(
    store: Arc<RwLock<FragmentStore>>,
    stats: Arc<RwLock<SessionStats>>,
) -> PipelineCallbacks {
    PipelineCallbacks {
        on_init: Arc::new({
            let store = store.clone();
            move |bytes| store.write().append_init(bytes)
        }),
        on_fragment: Arc::new({
            let store = store.clone();
            let stats = stats.clone();
            move |bytes, duration| {
                let len = bytes.len();
                store.write().push(bytes, duration);
                let mut stats = stats.write();
                stats.bytes_fetched = stats.bytes_fetched.saturating_add(len as u64);
                stats.source_buffer_ahead_seconds += duration;
            }
        }),
        on_subtitle: Arc::new({
            let store = store.clone();
            move |cue| {
                store.write().push_subtitle(cue);
            }
        }),
        on_error: Arc::new({
            let store = store.clone();
            move |message| {
                tracing::error!(error = %message, "video pipeline failed");
                store.write().mark_error(message);
            }
        }),
        on_eos: Arc::new(move || store.write().mark_eos()),
    }
}

fn initial_stats(id: Uuid, mode: PlaybackMode, media: &MediaInfo) -> SessionStats {
    let video = media
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video);
    let audio = media
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Audio);
    SessionStats {
        session_id: Some(id),
        mode: Some(mode),
        generation: 0,
        input_video_codec: video.map(|track| track.codec.clone()),
        output_video_codec: Some(
            if matches!(mode, PlaybackMode::Remux | PlaybackMode::HybridRemux)
                && video.is_some_and(|track| track.codec == "h265")
            {
                "h265".into()
            } else {
                "h264".into()
            },
        ),
        input_audio_codec: audio.map(|track| track.codec.clone()),
        output_audio_codec: Some(if mode == PlaybackMode::Remux {
            audio.map_or_else(|| "aac".into(), |track| track.codec.clone())
        } else {
            "aac".into()
        }),
        decoded_frame_copies: 0,
        visible: true,
        state: Some(PlaybackState::Paused),
        ..SessionStats::default()
    }
}

fn fragment_mime_type(media: &MediaInfo, mode: PlaybackMode) -> String {
    let video = media
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video && track.selected);
    let audio = media
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Audio && track.selected);
    if mode == PlaybackMode::Remux && video.is_some_and(|track| track.codec == "h265") {
        let audio_codec = audio.map(|track| {
            if track.codec == "eac3" {
                "ec-3"
            } else {
                "mp4a.40.2"
            }
        });
        return audio_codec.map_or_else(
            || "video/mp4; codecs=\"hvc1.2.4.L153.B0\"".into(),
            |audio| format!("video/mp4; codecs=\"hvc1.2.4.L153.B0,{audio}\""),
        );
    }
    if mode == PlaybackMode::HybridRemux {
        return if audio.is_some() {
            "video/mp4; codecs=\"hvc1.2.4.L153.B0,mp4a.40.2\"".into()
        } else {
            "video/mp4; codecs=\"hvc1.2.4.L153.B0\"".into()
        };
    }
    let avc = if mode == PlaybackMode::Remux {
        video
            .and_then(|track| avc_codec_from_caps(&track.caps))
            .unwrap_or_else(|| "avc1.42E01E".into())
    } else {
        "avc1.42E01E".into()
    };
    if audio.is_some() {
        format!("video/mp4; codecs=\"{avc},mp4a.40.2\"")
    } else {
        format!("video/mp4; codecs=\"{avc}\"")
    }
}

fn prefer_native_audio_track(media: &mut MediaInfo, browser: &BrowserCapabilities) {
    let supports_eac3 = browser
        .supported_mime_types
        .iter()
        .any(|mime| mime.to_ascii_lowercase().contains("ec-3"));
    if !supports_eac3 {
        return;
    }
    let selected_is_native = media
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Audio && track.selected)
        .is_some_and(|track| matches!(track.codec.as_str(), "aac" | "eac3"));
    if selected_is_native {
        return;
    }
    let replacement = media
        .tracks
        .iter()
        .position(|track| track.kind == TrackKind::Audio && track.codec == "eac3");
    if let Some(replacement) = replacement {
        for track in &mut media.tracks {
            if track.kind == TrackKind::Audio {
                track.selected = false;
            }
        }
        media.tracks[replacement].selected = true;
    }
}

fn avc_codec_from_caps(caps: &str) -> Option<String> {
    let lower = caps.to_ascii_lowercase();
    let data = lower.split("codec_data=(buffer)").nth(1)?;
    let header = data.get(..8)?;
    header
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit())
        .then(|| format!("avc1.{}", &header[2..8]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "gstreamer-runtime")]
    #[test]
    #[ignore = "requires TAURI_VIDEO_REMOTE_URL and network access"]
    fn qualifies_remote_stream_initialization() {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;

        let uri =
            std::env::var("TAURI_VIDEO_REMOTE_URL").expect("TAURI_VIDEO_REMOTE_URL is required");
        let manager = SessionManager::new(VideoPluginConfig::default());
        tauri::async_runtime::block_on(async {
            let descriptor = manager
                .create_session(CreateSessionRequest {
                    source: VideoSource {
                        uri,
                        headers: Default::default(),
                        cookies: None,
                        user_agent: Some("tauri-video-remote-qualification/1.0".into()),
                        referrer: None,
                        tls_ca_file: None,
                        start_position_seconds: None,
                    },
                    browser: BrowserCapabilities {
                        media_source: true,
                        managed_media_source: false,
                        supported_mime_types: vec![
                            "video/mp4; codecs=\"avc1.42E01E,mp4a.40.2\"".into(),
                            "video/mp4; codecs=\"hvc1.2.4.L153.B0,mp4a.40.2\"".into(),
                            "video/mp4; codecs=\"hvc1.2.4.L153.B0,ec-3\"".into(),
                        ],
                        hardware_concurrency: Some(8),
                        user_agent: Some("qualification-webview".into()),
                    },
                    transcode_policy: TranscodePolicy::Realtime,
                    buffer_ahead_seconds: Some(8.0),
                })
                .await
                .expect("create remote session");
            eprintln!(
                "remote mode={:?} mime={} selected_codecs={:?}",
                descriptor.mode,
                descriptor.transport.mime_type,
                descriptor
                    .media
                    .tracks
                    .iter()
                    .filter(|track| track.selected)
                    .map(|track| (&track.kind, &track.codec))
                    .collect::<Vec<_>>()
            );
            manager
                .set_playback_state(SetPlaybackStateRequest {
                    session_id: descriptor.session_id,
                    state: PlaybackState::Playing,
                })
                .expect("play remote session");

            let init = url::Url::parse(&descriptor.transport.init_url).expect("init URL");
            let address = format!(
                "{}:{}",
                init.host_str().expect("init host"),
                init.port_or_known_default().expect("init port")
            );
            let started = std::time::Instant::now();
            let response = loop {
                let mut socket = TcpStream::connect(&address).expect("connect to fragment broker");
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .expect("set broker timeout");
                write!(
                    socket,
                    "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                    init.path(),
                    init.host_str().expect("init host")
                )
                .expect("request initialization segment");
                let mut response = Vec::new();
                socket
                    .read_to_end(&mut response)
                    .expect("read initialization response");
                if !response.starts_with(b"HTTP/1.1 204")
                    || started.elapsed() >= Duration::from_secs(45)
                {
                    break response;
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            assert!(
                response.starts_with(b"HTTP/1.1 200"),
                "remote initialization failed: {}",
                String::from_utf8_lossy(&response[..response.len().min(2048)])
            );
            manager
                .destroy(descriptor.session_id)
                .expect("destroy remote session");
        });
    }

    #[cfg(feature = "gstreamer-runtime")]
    #[test]
    #[ignore = "requires qualification/https_range_server.py"]
    fn qualifies_full_https_session_lifecycle() {
        let base = std::env::var("TAURI_VIDEO_QUALIFICATION_BASE_URL")
            .expect("TAURI_VIDEO_QUALIFICATION_BASE_URL is required");
        let ca_file = std::env::var("TAURI_VIDEO_QUALIFICATION_CA_FILE")
            .expect("TAURI_VIDEO_QUALIFICATION_CA_FILE is required");
        let manager = SessionManager::new(VideoPluginConfig::default());
        tauri::async_runtime::block_on(async {
            let descriptor = manager
                .create_session(CreateSessionRequest {
                    source: VideoSource {
                        uri: format!("{}/h264-aac-60.mkv", base.trim_end_matches('/')),
                        headers: Default::default(),
                        cookies: None,
                        user_agent: Some("tauri-video-session-qualification/1.0".into()),
                        referrer: None,
                        tls_ca_file: Some(ca_file),
                        start_position_seconds: None,
                    },
                    browser: BrowserCapabilities {
                        media_source: true,
                        managed_media_source: false,
                        supported_mime_types: vec![
                            "video/mp4; codecs=\"avc1.42E01E,mp4a.40.2\"".into()
                        ],
                        hardware_concurrency: Some(8),
                        user_agent: Some("qualification-webview".into()),
                    },
                    transcode_policy: TranscodePolicy::Realtime,
                    buffer_ahead_seconds: Some(8.0),
                })
                .await
                .expect("create HTTPS session");
            eprintln!(
                "qualification transport MIME: {}; media: {:?}",
                descriptor.transport.mime_type, descriptor.media.tracks
            );
            manager
                .set_playback_state(SetPlaybackStateRequest {
                    session_id: descriptor.session_id,
                    state: PlaybackState::Playing,
                })
                .expect("play session");
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let stats = manager.stats(descriptor.session_id).expect("session stats");
            assert!(stats.encoded_bytes_buffered > 0);
            let seek = manager
                .seek(SeekRequest {
                    session_id: descriptor.session_id,
                    position_seconds: 3.0,
                })
                .await
                .expect("seek session");
            assert_eq!(seek.generation, 1);
            manager
                .destroy(descriptor.session_id)
                .expect("destroy session");
        });
    }

    #[test]
    fn memory_budget_limits_prepared_sessions() {
        let manager = SessionManager::new(VideoPluginConfig {
            desktop_memory_budget_mib: 128,
            session_memory_budget_mib: 64,
            ..VideoPluginConfig::default()
        });
        assert!(manager.enforce_session_budget().is_ok());
    }

    #[test]
    fn reports_the_remuxed_h264_profile_to_media_source() {
        let media = MediaInfo {
            duration_seconds: None,
            seekable: true,
            live: false,
            container: None,
            tracks: vec![MediaTrack {
                id: "v0".into(),
                kind: TrackKind::Video,
                stream_index: 0,
                codec: "h264".into(),
                caps: "video/x-h264, profile=(string)high, codec_data=(buffer)01640020ffe1001967640020acd9405005bb0110000003001000000780".into(),
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
            }],
            chapters: vec![],
        };
        assert_eq!(
            fragment_mime_type(&media, PlaybackMode::Remux),
            "video/mp4; codecs=\"avc1.640020\""
        );
    }
}
