use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("upstream unavailable: {0}")]
    Unavailable(String),

    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}
