//! File-backed durable Kafka offset store.
//!
//! ## Why this exists
//!
//! Before this module, the processor consumed with `StartOffset::Latest` —
//! meaning on every restart it skipped past any events produced while it was
//! down. That silently lost data. External review caught it as P0: "the
//! product loses customer events on every redeploy."
//!
//! ## The contract
//!
//! `save(offset)` is called AFTER a batch has been successfully written to
//! ClickHouse (or dead-lettered after retry exhaustion). On startup `load()`
//! returns the last persisted offset; the consumer resumes from
//! `StartOffset::At(offset + 1)`. On first run (no file), the consumer
//! starts from `StartOffset::Earliest` — preserving any pre-existing
//! backlog. We never default to `Latest` because that's the silent-drop
//! footgun this module was created to fix.
//!
//! ## Atomicity
//!
//! `save` writes to a `.tmp` sibling file and `rename`s into place — the
//! POSIX rename(2) syscall is atomic on the same filesystem, so a crash
//! mid-save leaves either the old offset OR the new one, never a partial
//! number. We do NOT fsync — at-least-once delivery means a few duplicates
//! on hard crash are acceptable, and ClickHouse's ReplacingMergeTree (on
//! `(org_id, timestamp, span_id)`) collapses them at merge time. Idempotent
//! by data shape, not by transactional write path.
//!
//! This holds for the raw `llm_calls` table only. The `llm_metrics_hourly`
//! rollup's additive columns DO sum a replayed batch (the materialized view
//! is not on the dedup path), so it is kept correct by a periodic
//! reconcile-from-raw rather than by this offset contract — see
//! `scripts/reconcile-llm-metrics-hourly.sh` and the Idempotency note on
//! `consumer::flush`.
//!
//! ## Non-goals
//!
//! - Multi-partition support. The processor currently consumes partition 0
//!   only. When we shard, this becomes per-partition (offset_p0, offset_p1).
//! - Multi-instance support. The file lock is implicit (one process,
//!   one file). Multi-instance needs a real coordinator — Redis or the
//!   broker-side consumer-group offset commit.

use std::path::PathBuf;

use anyhow::Context;

pub struct OffsetStore {
    path: PathBuf,
}

impl OffsetStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Read the last-persisted offset. Returns `None` when:
    /// - the file doesn't exist (first run)
    /// - the file is empty or unparseable (treated as first run; the
    ///   alternative — refusing to start — is worse, since a corrupt file
    ///   would jam the processor permanently)
    pub fn load(&self) -> Option<i64> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => match s.trim().parse::<i64>() {
                Ok(n) if n >= 0 => Some(n),
                Ok(_) => {
                    tracing::warn!(path = ?self.path, "offset file contained negative number; ignoring");
                    None
                }
                Err(e) => {
                    tracing::warn!(error = %e, path = ?self.path, "offset file unparseable; ignoring");
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                tracing::error!(error = %e, path = ?self.path, "offset file read error; treating as first run");
                None
            }
        }
    }

    /// Persist `offset`. Atomic via tmp-file + rename. Caller decides
    /// when to call this — typically after a batch has been written to
    /// ClickHouse OR dead-lettered (either outcome means "we are done with
    /// this offset and a restart should NOT replay it").
    pub fn save(&self, offset: i64) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            // The parent dir might not exist on first run if the operator
            // didn't pre-create the mount. Create it lazily.
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating offset dir {:?}", parent))?;
        }
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, offset.to_string())
            .with_context(|| format!("writing offset tmp file {:?}", tmp))?;
        // Atomic on POSIX: either the rename happens fully or not at all.
        // On the same filesystem this is a single inode-rename operation.
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("renaming offset file to {:?}", self.path))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmpdir() -> tempfile_lite::TempDir {
        tempfile_lite::TempDir::new().expect("tempdir")
    }

    // Minimal in-tree tempdir to avoid pulling tempfile as a runtime dep.
    // Test-only.
    mod tempfile_lite {
        use std::path::{Path, PathBuf};

        pub struct TempDir {
            path: PathBuf,
        }

        impl TempDir {
            pub fn new() -> std::io::Result<Self> {
                let mut path = std::env::temp_dir();
                let suffix = format!(
                    "scopecall-offset-test-{}",
                    std::process::id() as u64
                        ^ std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_nanos() as u64)
                            .unwrap_or(0)
                );
                path.push(suffix);
                std::fs::create_dir_all(&path)?;
                Ok(Self { path })
            }

            pub fn path(&self) -> &Path {
                &self.path
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
    }

    #[test]
    fn load_returns_none_when_file_absent() {
        let dir = tmpdir();
        let store = OffsetStore::new(dir.path().join("missing"));
        assert_eq!(store.load(), None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tmpdir();
        let store = OffsetStore::new(dir.path().join("offset"));
        store.save(12345).unwrap();
        assert_eq!(store.load(), Some(12345));
    }

    #[test]
    fn save_overwrites_previous() {
        let dir = tmpdir();
        let store = OffsetStore::new(dir.path().join("offset"));
        store.save(100).unwrap();
        store.save(200).unwrap();
        assert_eq!(store.load(), Some(200));
    }

    #[test]
    fn save_creates_parent_dir() {
        let dir = tmpdir();
        let nested = dir.path().join("nested/deeper/offset");
        let store = OffsetStore::new(&nested);
        store.save(7).unwrap();
        assert_eq!(store.load(), Some(7));
    }

    #[test]
    fn load_returns_none_on_garbage() {
        let dir = tmpdir();
        let path = dir.path().join("offset");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"not a number").unwrap();
        let store = OffsetStore::new(&path);
        assert_eq!(store.load(), None);
    }

    #[test]
    fn load_returns_none_on_negative() {
        // Defensive: kafka offsets are non-negative i64; a -1 in the file
        // suggests corruption or a tool poking around, treat as fresh start
        // rather than emitting `StartOffset::At(0)` and replaying everything.
        let dir = tmpdir();
        let path = dir.path().join("offset");
        std::fs::write(&path, "-5").unwrap();
        let store = OffsetStore::new(&path);
        assert_eq!(store.load(), None);
    }
}
