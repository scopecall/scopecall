-- Self-hosted Postgres schema initialisation.
-- Runs once on first `docker compose up` via docker-entrypoint-initdb.d.
-- Schema only — NO seed data, NO hardcoded credentials, NO dev API keys.
-- First admin account is created via the /setup web form on first login.

-- ── Core tables ───────────────────────────

CREATE TABLE IF NOT EXISTS orgs (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key_hash     TEXT NOT NULL UNIQUE,  -- SHA-256 of raw key, lowercase hex
    name         TEXT,
    key_prefix   TEXT,                  -- public prefix shown in the UI (e.g. "sc_live_a1b2")
    scopes       TEXT[],                -- {ingest:write, traces:read}; NULL = legacy "all scopes"
    revoked      BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,           -- bumped by auth middleware, coalesced to 1 write/min/key
    revoked_at   TIMESTAMPTZ            -- set when revoke flips, used for periodic cleanup + UI countdown
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
    ON api_keys(key_hash) WHERE revoked = false;
CREATE INDEX IF NOT EXISTS idx_api_keys_org_created_at
    ON api_keys (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_keys_scopes
    ON api_keys USING GIN (scopes);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at
    ON api_keys (revoked_at) WHERE revoked = true AND revoked_at IS NOT NULL;

-- ── Auth.js users table ────────────────────────────────────────────
-- Used by Auth.js Credentials provider for email + password authentication.
-- Supabase mode (cloud) does NOT use this table.

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,          -- bcrypt, cost 12
    org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'owner'
                    CHECK (role IN ('owner', 'admin', 'viewer')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── Alerts ──────────────────────────────────────────────────────────
-- Mirror of schemas/postgres/migrations/002_alerts.sql. Applied here for
-- first-startup self-hosted installs; the API also runs the same DDL
-- idempotently on every boot, so existing databases get the tables too.

CREATE TABLE IF NOT EXISTS alert_rules (
    id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('cost_spike', 'error_rate', 'latency_p99')),
    threshold       DOUBLE PRECISION NOT NULL,
    window_seconds  INTEGER NOT NULL DEFAULT 600 CHECK (window_seconds BETWEEN 60 AND 86400),
    dim_filter      JSONB NOT NULL DEFAULT '{}'::jsonb,
    channel_type    TEXT NOT NULL DEFAULT 'none' CHECK (channel_type IN ('slack', 'none')),
    channel_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_org_enabled ON alert_rules(org_id, enabled);

CREATE TABLE IF NOT EXISTS alert_events (
    id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    rule_id      TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    fired_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    value        DOUBLE PRECISION NOT NULL,
    message      TEXT NOT NULL,
    resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alert_events_rule_open ON alert_events(rule_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alert_events_fired ON alert_events(fired_at DESC);

-- Saved views (URL bookmarks). Per-org, shared. Backs the "Views" dropdown
-- in the top header.
CREATE TABLE IF NOT EXISTS saved_views (
    id              TEXT PRIMARY KEY DEFAULT ('sv_' || replace(gen_random_uuid()::text, '-', '')),
    org_id          TEXT NOT NULL,
    created_by      TEXT,
    name            TEXT NOT NULL,
    path            TEXT NOT NULL,
    query_string    TEXT NOT NULL DEFAULT '',
    icon            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT saved_views_name_org_unique UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_views_org ON saved_views(org_id, created_at DESC);
