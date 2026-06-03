-- Minimal Postgres schema (API key resolution)
-- Full schema lives in services-go/api/migrations/

CREATE TABLE IF NOT EXISTS orgs (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    org_id      TEXT NOT NULL REFERENCES orgs(id),
    key_hash    TEXT NOT NULL UNIQUE,  -- SHA-256 of raw key, lowercase hex
    name        TEXT,
    revoked     BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
    ON api_keys(key_hash) WHERE revoked = false;
