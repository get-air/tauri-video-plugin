use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("source is not permitted: {0}")]
    SourceDenied(String),
    #[error("session was not found")]
    SessionNotFound,
    #[error("the configured player resource budget is exhausted")]
    ResourceLimit,
    #[error("GStreamer is unavailable: {0}")]
    RuntimeUnavailable(String),
    #[error("media discovery failed: {0}")]
    Discovery(String),
    #[error("the source cannot be normalized by the installed codec profile: {0}")]
    UnsupportedCodec(String),
    #[error("media pipeline failed: {0}")]
    Pipeline(String),
    #[error("fragment broker failed: {0}")]
    Broker(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest(_) => "INVALID_REQUEST",
            Self::SourceDenied(_) => "SOURCE_DENIED",
            Self::SessionNotFound => "SESSION_NOT_FOUND",
            Self::ResourceLimit => "RESOURCE_LIMIT",
            Self::RuntimeUnavailable(_) => "RUNTIME_UNAVAILABLE",
            Self::Discovery(_) => "DISCOVERY_FAILED",
            Self::UnsupportedCodec(_) => "UNSUPPORTED_CODEC",
            Self::Pipeline(_) => "PIPELINE_FAILED",
            Self::Broker(_) => "BROKER_FAILED",
            Self::Io(_) => "IO_ERROR",
            #[cfg(mobile)]
            Self::PluginInvoke(_) => "MOBILE_PLUGIN_ERROR",
        }
    }

    fn recoverable(&self) -> bool {
        matches!(
            self,
            Self::ResourceLimit | Self::Pipeline(_) | Self::Broker(_) | Self::Io(_)
        )
    }
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct WireError<'a> {
            code: &'static str,
            message: String,
            recoverable: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            stage: Option<&'a str>,
        }

        WireError {
            code: self.code(),
            message: self.to_string(),
            recoverable: self.recoverable(),
            stage: match self {
                Self::Discovery(_) => Some("discover"),
                Self::Pipeline(_) | Self::UnsupportedCodec(_) => Some("pipeline"),
                Self::Broker(_) => Some("transport"),
                _ => None,
            },
        }
        .serialize(serializer)
    }
}
