-- Dev seed data — bootstraps one org + one API key for local development.
-- Raw key: sc_live_dev_000000000000000000
-- key_hash = SHA-256 of the raw key (Postgres encode(sha256(...), 'hex'))

INSERT INTO orgs (id, name)
VALUES ('org_dev', 'Dev Org')
ON CONFLICT DO NOTHING;

INSERT INTO api_keys (org_id, key_hash, name)
VALUES (
    'org_dev',
    encode(sha256('sc_live_dev_000000000000000000'::bytea), 'hex'),
    'dev key'
)
ON CONFLICT DO NOTHING;
