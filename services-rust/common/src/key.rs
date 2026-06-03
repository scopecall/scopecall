use sha2::{Digest, Sha256};

/// Hash a raw API key with SHA-256. Returns lowercase hex.
/// Matches the Postgres seed: encode(sha256('sc_live_...'::bytea), 'hex')
pub fn hash_api_key(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}
