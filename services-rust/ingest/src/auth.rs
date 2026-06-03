use common::errors::AppError;
use common::key::hash_api_key;
use redis::AsyncCommands;
use sqlx::PgPool;

const CACHE_TTL_SECS: u64 = 60;
const NEG_CACHE_KEY: &str = "revoked:";
// Namespaced positive cache. Critical: the Go API uses a separate namespace
// (`key:read:`) because its scope check is different — a key that's valid
// for ingest is NOT automatically valid for the read API. If both services
// shared `key:<hash>`, a write-scope-only key cached after a successful
// ingest could bypass the Go API's traces:read enforcement on subsequent
// requests (Round-7 review fix). The negative cache (`revoked:`) is still
// shared so a single revoke invalidates both paths.
const POS_CACHE_KEY: &str = "key:ingest:";

/// Scope an API key needs in order to write to /v1/ingest. Legacy keys
/// with NULL `scopes` are treated as fully-privileged (back-compat with
/// keys minted before scope support landed).
const INGEST_SCOPE: &str = "ingest:write";

/// Resolve a raw API key to an org_id, enforcing the ingest scope.
///
/// Three-layer lookup:
///   1. Redis negative cache (revoked:<hash>) → reject immediately
///   2. Redis positive cache (key:<hash>) → return cached org_id
///   3. Postgres source of truth → populate positive cache
///
/// When Redis is unavailable, falls back directly to Postgres (degraded mode).
///
/// On a Postgres cache-miss, two side effects fire in the background:
///   - `last_used_at` is bumped on the row (self-coalesced to 60s so the
///     write rate is bounded regardless of request rate).
///   - `key:<hash>` is set in Redis with a 60s TTL.
///
/// The dashboard's Settings → API Keys page reads `last_used_at` to show
/// "last used 3m ago"; without this bump, ingest-only keys (the primary
/// product use case) would forever show "—" because the Go API auth path
/// is the only thing that previously stamped the column.
pub async fn resolve_key(
    raw_key: &str,
    redis_client: &redis::Client,
    pg: &PgPool,
) -> Result<String, AppError> {
    let hash = hash_api_key(raw_key);

    match redis_client.get_multiplexed_async_connection().await {
        Ok(mut conn) => {
            // Negative cache check
            let neg_key = format!("{NEG_CACHE_KEY}{hash}");
            let revoked: bool = conn.exists(&neg_key).await.unwrap_or(false);
            if revoked {
                return Err(AppError::Unauthorized);
            }

            // Positive cache check. Cached entries are written ONLY after
            // a full scope-validating Postgres lookup, so a hit means the
            // key was authorized to write to ingest at the moment we
            // populated the cache. Within the 60s TTL we trust the cache.
            let pos_key = format!("{POS_CACHE_KEY}{hash}");
            if let Ok(Some(org_id)) = conn.get::<_, Option<String>>(&pos_key).await {
                return Ok(org_id);
            }

            // Cache miss → Postgres
            let org_id = lookup_postgres(&hash, pg).await?;
            let _: () = conn
                .set_ex(&pos_key, &org_id, CACHE_TTL_SECS)
                .await
                .unwrap_or(());
            // Fire-and-forget last_used_at bump. We deliberately do NOT
            // await: a slow Postgres should not delay the ingest request
            // it just authenticated. Errors are logged at debug level —
            // a missed last-used stamp is a UX paper-cut, not a failure.
            spawn_touch_last_used(pg.clone(), hash);
            Ok(org_id)
        }
        Err(_) => {
            // Redis unavailable — degrade to Postgres
            tracing::warn!("Redis unavailable, falling back to Postgres for auth");
            let org_id = lookup_postgres(&hash, pg).await?;
            spawn_touch_last_used(pg.clone(), hash);
            Ok(org_id)
        }
    }
}

/// Write the negative-cache entry for instant revocation.
/// Called by the revocation endpoint.
#[allow(dead_code)]
pub async fn revoke_key(
    raw_key: &str,
    redis_client: &redis::Client,
) -> anyhow::Result<()> {
    let hash = hash_api_key(raw_key);
    let mut conn = redis_client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| anyhow::anyhow!("Redis connection for revocation: {e}"))?;

    let neg_key = format!("{NEG_CACHE_KEY}{hash}");
    let pos_key = format!("{POS_CACHE_KEY}{hash}");

    let _: () = conn
        .set_ex(&neg_key, "1", 300u64)
        .await
        .map_err(|e| anyhow::anyhow!("write negative cache: {e}"))?;
    let _: () = conn.del(&pos_key).await.unwrap_or(());
    Ok(())
}

/// Look up a key by hash, enforce that it carries the ingest scope, and
/// return the org_id. `scopes` is TEXT[] in Postgres; we treat NULL as
/// "fully privileged" so keys minted before scopes existed keep working.
async fn lookup_postgres(key_hash: &str, pg: &PgPool) -> Result<String, AppError> {
    let row: Option<(String, Option<Vec<String>>)> = sqlx::query_as(
        "SELECT org_id, scopes FROM api_keys WHERE key_hash = $1 AND revoked = false LIMIT 1",
    )
    .bind(key_hash)
    .fetch_optional(pg)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;

    match row {
        Some((org_id, scopes)) => {
            // NULL scopes = legacy key, allow. Non-null and missing
            // INGEST_SCOPE = a read-only or admin-only key trying to
            // write events; reject so an accidentally-leaked read key
            // can't pollute the trace store.
            let allowed = match scopes.as_deref() {
                None => true,
                Some(list) => list.iter().any(|s| s == INGEST_SCOPE),
            };
            if !allowed {
                return Err(AppError::Unauthorized);
            }
            Ok(org_id)
        }
        None => Err(AppError::Unauthorized),
    }
}

/// Fire a coalesced UPDATE in a detached task. The WHERE clause itself
/// rate-limits writes to ≤1 per key per 60s, so even sustained ingest
/// traffic produces a bounded write rate. Logging is debug-level on
/// failure because this is opportunistic — losing a stamp is fine.
fn spawn_touch_last_used(pg: PgPool, key_hash: String) {
    tokio::spawn(async move {
        let res = sqlx::query(
            "UPDATE api_keys
               SET last_used_at = NOW()
             WHERE key_hash = $1
               AND (last_used_at IS NULL
                    OR last_used_at < NOW() - INTERVAL '60 seconds')",
        )
        .bind(&key_hash)
        .execute(&pg)
        .await;
        if let Err(e) = res {
            tracing::debug!("last_used_at bump failed: {e}");
        }
    });
}
