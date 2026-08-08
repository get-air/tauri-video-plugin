use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
    Subtitle,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOpenRequest {
    /// Identifies the JavaScript controller that owns the singleton native surface.
    /// Late cleanup from an older React render must not close a newer player.
    #[serde(default)]
    pub session_key: String,
    pub uri: String,
    /// Playback engine requested by the JavaScript controller. `auto` selects
    /// the platform's primary native backend; alternatives must be explicit.
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
