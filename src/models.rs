use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPluginConfig {
    #[serde(default = "default_desktop_memory")]
    pub desktop_memory_budget_mib: usize,
    #[serde(default = "default_mobile_memory")]
    pub mobile_memory_budget_mib: usize,
    #[serde(default = "default_desktop_transcoders")]
    pub max_desktop_transcoders: usize,
    #[serde(default = "default_mobile_transcoders")]
    pub max_mobile_transcoders: usize,
    #[serde(default = "default_session_memory")]
    pub session_memory_budget_mib: usize,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
}

const fn default_desktop_memory() -> usize {
    384
}
const fn default_mobile_memory() -> usize {
    256
}
const fn default_desktop_transcoders() -> usize {
    2
}
const fn default_mobile_transcoders() -> usize {
    1
}
const fn default_session_memory() -> usize {
    // Enough for roughly 15 seconds of a 55 Mbit/s UHD remux, with headroom
    // for bitrate spikes, without letting one stream dominate system RAM.
    128
}

impl Default for VideoPluginConfig {
    fn default() -> Self {
        Self {
            desktop_memory_budget_mib: default_desktop_memory(),
            mobile_memory_budget_mib: default_mobile_memory(),
            max_desktop_transcoders: default_desktop_transcoders(),
            max_mobile_transcoders: default_mobile_transcoders(),
            session_memory_budget_mib: default_session_memory(),
            allowed_origins: vec![
                "tauri://localhost".into(),
                "http://tauri.localhost".into(),
                "https://tauri.localhost".into(),
            ],
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    #[serde(default)]
    pub media_source: bool,
    #[serde(default)]
    pub managed_media_source: bool,
    #[serde(default)]
    pub supported_mime_types: Vec<String>,
    #[serde(default)]
    pub hardware_concurrency: Option<u32>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSource {
    pub uri: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub cookies: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub tls_ca_file: Option<String>,
    #[serde(default)]
    pub start_position_seconds: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TranscodePolicy {
    #[default]
    Realtime,
    PreserveQuality,
    HardwareOnly,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub source: VideoSource,
    pub browser: BrowserCapabilities,
    #[serde(default)]
    pub transcode_policy: TranscodePolicy,
    #[serde(default)]
    pub buffer_ahead_seconds: Option<f64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybackMode {
    Remux,
    HybridRemux,
    HardwareTranscode,
    SoftwareTranscode,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
    Subtitle,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaTrack {
    pub id: String,
    pub kind: TrackKind,
    pub stream_index: usize,
    pub codec: String,
    pub caps: String,
    pub label: Option<String>,
    pub language: Option<String>,
    pub selected: bool,
    pub default: bool,
    pub forced: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub id: String,
    pub title: Option<String>,
    pub start_seconds: f64,
    pub end_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCue {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration_seconds: Option<f64>,
    pub seekable: bool,
    pub live: bool,
    pub container: Option<String>,
    pub tracks: Vec<MediaTrack>,
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentTransport {
    pub base_url: String,
    pub generation: u64,
    pub mime_type: String,
    pub init_url: String,
    pub fragment_url_template: String,
    pub subtitle_url_template: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptor {
    pub session_id: Uuid,
    pub mode: PlaybackMode,
    pub media: MediaInfo,
    pub transport: FragmentTransport,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackState {
    Playing,
    Paused,
    Suspended,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdRequest {
    pub session_id: Uuid,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPlaybackStateRequest {
    pub session_id: Uuid,
    pub state: PlaybackState,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekRequest {
    pub session_id: Uuid,
    pub position_seconds: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekResponse {
    pub generation: u64,
    pub transport: FragmentTransport,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectTrackRequest {
    pub session_id: Uuid,
    pub kind: TrackKind,
    pub track_id: Option<String>,
    pub position_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityRequest {
    pub session_id: Uuid,
    pub visible: bool,
    pub intersection_ratio: f64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub session_id: Option<Uuid>,
    pub mode: Option<PlaybackMode>,
    pub generation: u64,
    pub bytes_fetched: u64,
    pub encoded_bytes_buffered: u64,
    pub fragments_buffered: usize,
    pub source_buffer_ahead_seconds: f64,
    pub transcode_speed: Option<f64>,
    pub input_video_codec: Option<String>,
    pub output_video_codec: Option<String>,
    pub input_audio_codec: Option<String>,
    pub output_audio_codec: Option<String>,
    pub hardware_backend: Option<String>,
    pub decoded_frame_copies: u64,
    pub dropped_frames: u64,
    pub av_drift_milliseconds: Option<f64>,
    pub visible: bool,
    pub state: Option<PlaybackState>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub available: bool,
    pub version: Option<String>,
    pub plugin_version: String,
    pub min_android_sdk: u32,
    pub platform: String,
    pub elements: BTreeMap<String, bool>,
    pub supported_input_schemes: Vec<String>,
    pub limits: RuntimeLimits,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLimits {
    pub global_memory_mib: usize,
    pub session_memory_mib: usize,
    pub max_transcoders: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOpenRequest {
    /// Identifies the JavaScript controller that owns the singleton native surface.
    /// Late cleanup from an older React render must not close a newer player.
    #[serde(default)]
    pub session_key: String,
    pub uri: String,
    /// Playback engine requested by the JavaScript controller. `auto` preserves
    /// the platform-native default and permits its configured compatibility fallback.
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub cookies: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub tls_ca_file: Option<String>,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub scroll_x: f64,
    #[serde(default)]
    pub scroll_y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_true")]
    pub autoplay: bool,
    #[serde(default = "default_volume")]
    pub volume: f64,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub min_buffer_ms: Option<u32>,
    #[serde(default)]
    pub max_buffer_ms: Option<u32>,
    #[serde(default)]
    pub playback_buffer_ms: Option<u32>,
    #[serde(default)]
    pub rebuffer_ms: Option<u32>,
    #[serde(default)]
    pub target_buffer_bytes: Option<u64>,
    #[serde(default)]
    pub decoder_fallback: Option<bool>,
    #[serde(default)]
    pub compatibility_fallback: Option<String>,
    #[serde(default)]
    pub startup_timeout_ms: Option<u32>,
    #[serde(default)]
    pub dolby_vision_mode: Option<String>,
    #[serde(default)]
    pub tunneling: Option<bool>,
}

const fn default_true() -> bool {
    true
}

const fn default_volume() -> f64 {
    1.0
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLayoutRequest {
    #[serde(default)]
    pub session_key: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub scroll_x: f64,
    #[serde(default)]
    pub scroll_y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeControlRequest {
    #[serde(default)]
    pub session_key: String,
    pub action: String,
    #[serde(default)]
    pub value: f64,
    #[serde(default = "default_native_track_index")]
    pub index: i32,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionRequest {
    #[serde(default)]
    pub session_key: String,
}

const fn default_native_track_index() -> i32 {
    -1
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTrackInfo {
    pub id: String,
    pub index: i32,
    pub kind: TrackKind,
    pub language: String,
    pub label: String,
    pub codec: String,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlaybackSnapshot {
    pub duration_seconds: f64,
    pub current_time_seconds: f64,
    pub buffered_seconds: f64,
    pub playing: bool,
    pub video_width: u32,
    pub video_height: u32,
    pub tracks: Vec<NativeTrackInfo>,
    #[serde(default)]
    pub presented_frames: u64,
    #[serde(default)]
    pub dropped_frames: u64,
    #[serde(default)]
    pub measured_fps: f64,
    #[serde(default)]
    pub hardware_backend: String,
    #[serde(default)]
    pub encoded_bytes_buffered: u64,
    #[serde(default)]
    pub average_frame_processing_us: f64,
}
