use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use bytes::Bytes;
use parking_lot::RwLock;
use serde::Serialize;
use tokio::{net::TcpListener, sync::OnceCell};
use uuid::Uuid;

use crate::{models::SubtitleCue, Error, Result};

#[derive(Debug, Clone)]
pub struct EncodedFragment {
    pub sequence: u64,
    pub bytes: Bytes,
    pub duration_seconds: f64,
}

#[derive(Debug)]
pub struct FragmentStore {
    generation: u64,
    max_bytes: usize,
    total_bytes: usize,
    total_duration_seconds: f64,
    init: Vec<u8>,
    init_ready: bool,
    base_sequence: u64,
    next_sequence: u64,
    fragments: VecDeque<EncodedFragment>,
    eos: bool,
    subtitle_base_sequence: u64,
    subtitle_next_sequence: u64,
    subtitle_cues: VecDeque<SubtitleCue>,
    error: Option<String>,
}

impl FragmentStore {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            generation: 0,
            max_bytes,
            total_bytes: 0,
            total_duration_seconds: 0.0,
            init: Vec::new(),
            init_ready: false,
            base_sequence: 0,
            next_sequence: 0,
            fragments: VecDeque::new(),
            eos: false,
            subtitle_base_sequence: 0,
            subtitle_next_sequence: 0,
            subtitle_cues: VecDeque::new(),
            error: None,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }
    pub fn fragment_count(&self) -> usize {
        self.fragments.len()
    }
    pub fn total_duration_seconds(&self) -> f64 {
        self.total_duration_seconds
    }

    pub fn reset(&mut self) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.total_bytes = 0;
        self.total_duration_seconds = 0.0;
        self.init.clear();
        self.init_ready = false;
        self.base_sequence = 0;
        self.next_sequence = 0;
        self.fragments.clear();
        self.eos = false;
        self.subtitle_base_sequence = 0;
        self.subtitle_next_sequence = 0;
        self.subtitle_cues.clear();
        self.error = None;
        self.generation
    }

    pub fn append_init(&mut self, bytes: &[u8]) {
        self.init.extend_from_slice(bytes);
    }

    pub fn push(&mut self, bytes: Bytes, duration_seconds: f64) -> u64 {
        // mp4mux emits ftyp and moov as separate HEADER buffers. Do not expose
        // a partial initialization segment to MediaSource; the first media
        // buffer is the boundary proving every header buffer has arrived.
        self.init_ready = true;
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        self.total_duration_seconds += duration_seconds;
        self.fragments.push_back(EncodedFragment {
            sequence,
            bytes,
            duration_seconds,
        });

        while self.total_bytes > self.max_bytes && self.fragments.len() > 1 {
            if let Some(evicted) = self.fragments.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(evicted.bytes.len());
                self.total_duration_seconds =
                    (self.total_duration_seconds - evicted.duration_seconds).max(0.0);
                self.base_sequence = evicted.sequence.saturating_add(1);
            }
        }
        sequence
    }

    pub fn mark_eos(&mut self) {
        self.eos = true;
    }

    pub fn mark_error(&mut self, message: String) {
        self.error = Some(message);
    }

    pub fn push_subtitle(&mut self, cue: SubtitleCue) -> u64 {
        let sequence = self.subtitle_next_sequence;
        self.subtitle_next_sequence = self.subtitle_next_sequence.saturating_add(1);
        self.subtitle_cues.push_back(cue);
        while self.subtitle_cues.len() > 10_000 {
            self.subtitle_cues.pop_front();
            self.subtitle_base_sequence = self.subtitle_base_sequence.saturating_add(1);
        }
        sequence
    }

    fn init(&self, generation: u64) -> StoreLookup {
        if generation != self.generation {
            return StoreLookup::Stale;
        }
        if let Some(message) = &self.error {
            return StoreLookup::Failed(message.clone());
        }
        if self.init.is_empty() || !self.init_ready {
            StoreLookup::Pending
        } else {
            StoreLookup::Ready(Bytes::copy_from_slice(&self.init))
        }
    }

    fn fragment(&mut self, generation: u64, sequence: u64) -> StoreLookup {
        if generation != self.generation {
            return StoreLookup::Stale;
        }
        if let Some(message) = &self.error {
            return StoreLookup::Failed(message.clone());
        }
        if sequence < self.base_sequence {
            return StoreLookup::Evicted(self.base_sequence);
        }
        // A session has a single ordered MSE consumer. Once it requests N, all
        // earlier encoded fragments already live in the WebView SourceBuffer
        // and do not need a second copy in Rust memory. Keep N itself so a
        // failed HTTP delivery can retry it until N+1 is requested.
        while self
            .fragments
            .front()
            .is_some_and(|fragment| fragment.sequence < sequence)
        {
            if let Some(consumed) = self.fragments.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(consumed.bytes.len());
                self.total_duration_seconds =
                    (self.total_duration_seconds - consumed.duration_seconds).max(0.0);
                self.base_sequence = consumed.sequence.saturating_add(1);
            }
        }
        if let Some(fragment) = self.fragments.iter().find(|item| item.sequence == sequence) {
            return StoreLookup::Ready(fragment.bytes.clone());
        }
        if self.eos && sequence >= self.next_sequence {
            StoreLookup::Eos
        } else {
            StoreLookup::Pending
        }
    }

    fn subtitle(&self, generation: u64, sequence: u64) -> SubtitleLookup {
        if generation != self.generation {
            return SubtitleLookup::Stale;
        }
        if let Some(message) = &self.error {
            return SubtitleLookup::Failed(message.clone());
        }
        if sequence < self.subtitle_base_sequence {
            return SubtitleLookup::Evicted(self.subtitle_base_sequence);
        }
        let offset = sequence.saturating_sub(self.subtitle_base_sequence) as usize;
        if let Some(cue) = self.subtitle_cues.get(offset) {
            return SubtitleLookup::Ready(cue.clone());
        }
        if self.eos && sequence >= self.subtitle_next_sequence {
            SubtitleLookup::Eos
        } else {
            SubtitleLookup::Pending
        }
    }
}

enum StoreLookup {
    Ready(Bytes),
    Pending,
    Stale,
    Evicted(u64),
    Eos,
    Failed(String),
}

enum SubtitleLookup {
    Ready(SubtitleCue),
    Pending,
    Stale,
    Evicted(u64),
    Eos,
    Failed(String),
}

#[derive(Clone)]
pub struct BrokerSession {
    pub store: Arc<RwLock<FragmentStore>>,
    pub mime_type: String,
}

#[derive(Clone)]
struct BrokerState {
    sessions: Arc<RwLock<HashMap<Uuid, BrokerSession>>>,
    allowed_origins: Arc<Vec<String>>,
}

pub struct FragmentBroker {
    state: BrokerState,
    address: OnceCell<SocketAddr>,
}

impl FragmentBroker {
    pub fn new(allowed_origins: Vec<String>) -> Self {
        Self {
            state: BrokerState {
                sessions: Arc::new(RwLock::new(HashMap::new())),
                allowed_origins: Arc::new(allowed_origins),
            },
            address: OnceCell::new(),
        }
    }

    pub async fn ensure_started(&self) -> Result<SocketAddr> {
        let address = self
            .address
            .get_or_try_init(|| async {
                let listener =
                    TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
                        .await
                        .map_err(|error| Error::Broker(error.to_string()))?;
                let address = listener
                    .local_addr()
                    .map_err(|error| Error::Broker(error.to_string()))?;
                let state = self.state.clone();
                let app = Router::new()
                    .route("/health", get(health))
                    .route("/v1/{session}/{generation}/init", get(init_segment))
                    .route(
                        "/v1/{session}/{generation}/fragment/{sequence}",
                        get(media_fragment),
                    )
                    .route(
                        "/v1/{session}/{generation}/subtitle/{sequence}",
                        get(subtitle_cue),
                    )
                    .layer(middleware::from_fn_with_state(
                        state.clone(),
                        validate_origin,
                    ))
                    .with_state(state);

                tauri::async_runtime::spawn(async move {
                    if let Err(error) = axum::serve(listener, app).await {
                        tracing::error!(%error, "video fragment broker stopped");
                    }
                });
                Ok::<_, Error>(address)
            })
            .await?;
        Ok(*address)
    }

    pub fn register(&self, id: Uuid, session: BrokerSession) {
        self.state.sessions.write().insert(id, session);
    }

    pub fn unregister(&self, id: &Uuid) {
        self.state.sessions.write().remove(id);
    }

    pub fn transport_urls(
        address: SocketAddr,
        id: Uuid,
        generation: u64,
    ) -> (String, String, String, String) {
        let base = format!("http://{address}/v1/{id}/{generation}");
        (
            base.clone(),
            format!("{base}/init"),
            format!("{base}/fragment/{{sequence}}"),
            format!("{base}/subtitle/{{sequence}}"),
        )
    }
}

async fn validate_origin(
    State(state): State<BrokerState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let allowed = origin
            .to_str()
            .ok()
            .is_some_and(|value| state.allowed_origins.iter().any(|item| item == value));
        if !allowed {
            return (StatusCode::FORBIDDEN, "origin is not allowed").into_response();
        }
    }
    let origin = request.headers().get(header::ORIGIN).cloned();
    let mut response = next.run(request).await;
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    sessions: usize,
}

async fn health(State(state): State<BrokerState>) -> impl IntoResponse {
    axum::Json(HealthResponse {
        status: "ok",
        sessions: state.sessions.read().len(),
    })
}

async fn init_segment(
    State(state): State<BrokerState>,
    Path((session, generation)): Path<(Uuid, u64)>,
) -> Response {
    lookup_response(&state, session, generation, None)
}

async fn media_fragment(
    State(state): State<BrokerState>,
    Path((session, generation, sequence)): Path<(Uuid, u64, u64)>,
) -> Response {
    lookup_response(&state, session, generation, Some(sequence))
}

async fn subtitle_cue(
    State(state): State<BrokerState>,
    Path((session, generation, sequence)): Path<(Uuid, u64, u64)>,
) -> Response {
    let sessions = state.sessions.read();
    let Some(session) = sessions.get(&session) else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };
    let lookup = session.store.read().subtitle(generation, sequence);
    match lookup {
        SubtitleLookup::Ready(cue) => {
            let mut response = axum::Json(cue).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        SubtitleLookup::Pending => StatusCode::NO_CONTENT.into_response(),
        SubtitleLookup::Stale => (StatusCode::CONFLICT, "stale generation").into_response(),
        SubtitleLookup::Evicted(next) => {
            let mut response = (StatusCode::GONE, "subtitle cue evicted").into_response();
            if let Ok(value) = HeaderValue::from_str(&next.to_string()) {
                response.headers_mut().insert("x-next-sequence", value);
            }
            response
        }
        SubtitleLookup::Eos => StatusCode::RANGE_NOT_SATISFIABLE.into_response(),
        SubtitleLookup::Failed(message) => {
            (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
        }
    }
}

fn lookup_response(
    state: &BrokerState,
    session_id: Uuid,
    generation: u64,
    sequence: Option<u64>,
) -> Response {
    let sessions = state.sessions.read();
    let Some(session) = sessions.get(&session_id) else {
        return (StatusCode::NOT_FOUND, "unknown session").into_response();
    };
    let mut store = session.store.write();
    let lookup = match sequence {
        Some(sequence) => store.fragment(generation, sequence),
        None => store.init(generation),
    };
    match lookup {
        StoreLookup::Ready(bytes) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&session.mime_type)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            );
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            (StatusCode::OK, headers, bytes).into_response()
        }
        StoreLookup::Pending => StatusCode::NO_CONTENT.into_response(),
        StoreLookup::Stale => (StatusCode::CONFLICT, "stale generation").into_response(),
        StoreLookup::Evicted(next) => {
            let mut response = (StatusCode::GONE, "fragment evicted").into_response();
            if let Ok(value) = HeaderValue::from_str(&next.to_string()) {
                response.headers_mut().insert("x-next-sequence", value);
            }
            response
        }
        StoreLookup::Eos => StatusCode::RANGE_NOT_SATISFIABLE.into_response(),
        StoreLookup::Failed(message) => {
            (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_store_evicts_oldest_fragments() {
        let mut store = FragmentStore::new(8);
        store.push(Bytes::from_static(b"aaaa"), 1.0);
        store.push(Bytes::from_static(b"bbbb"), 1.0);
        store.push(Bytes::from_static(b"cccc"), 1.0);

        assert_eq!(store.total_bytes(), 8);
        assert_eq!(store.fragment_count(), 2);
        assert!(matches!(store.fragment(0, 0), StoreLookup::Evicted(1)));
        assert!(matches!(store.fragment(0, 2), StoreLookup::Ready(_)));
    }

    #[test]
    fn sequential_delivery_releases_consumed_fragments() {
        let mut store = FragmentStore::new(1024);
        store.push(Bytes::from_static(b"first"), 1.0);
        store.push(Bytes::from_static(b"second"), 1.0);
        assert!(matches!(store.fragment(0, 0), StoreLookup::Ready(_)));
        assert!(matches!(store.fragment(0, 1), StoreLookup::Ready(_)));
        assert_eq!(store.total_bytes(), 6);
        assert_eq!(store.fragment_count(), 1);
        assert!(matches!(store.fragment(0, 0), StoreLookup::Evicted(1)));
    }

    #[test]
    fn resetting_invalidates_previous_generation() {
        let mut store = FragmentStore::new(1024);
        store.append_init(b"header");
        assert!(matches!(store.init(0), StoreLookup::Pending));
        store.push(Bytes::from_static(b"fragment"), 1.0);
        assert!(matches!(store.init(0), StoreLookup::Ready(_)));
        assert_eq!(store.reset(), 1);
        assert!(matches!(store.init(0), StoreLookup::Stale));
        assert!(matches!(store.init(1), StoreLookup::Pending));
    }
}
