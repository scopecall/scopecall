-- Saved views (URL bookmarks). Per-org, shared across users in the org.
-- Backs the "Views" dropdown in the top header — lets a team curate
-- "prod-error board" / "team-X cost view" as durable URLs.
--
-- Idempotent. The Go-side ApplySchema(savedviews.ApplySchema) runs the same
-- statements at startup for self-hosted instances; this file documents the
-- canonical schema for users running their own migrations.

CREATE TABLE IF NOT EXISTS saved_views (
    -- gen_random_uuid is built into Postgres 13+ (no pgcrypto extension required).
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
CREATE INDEX IF NOT EXISTS saved_views_org_idx ON saved_views(org_id, created_at DESC);
