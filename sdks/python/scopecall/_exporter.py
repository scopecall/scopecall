"""Background exporter — circular buffer + auto-flush + HTTP transport.

Architecturally identical to the TS SDK's
`sdks/typescript/src/exporter.ts`:

  - A bounded in-memory queue (drops oldest on overflow).
  - A background thread that wakes up every `flush_interval` seconds (or
    immediately on `.flush()`), drains up to `batch_size` events, and
    posts them as one HTTP request.
  - Auto-flush is enabled by default — without it, long-running servers
    queued events forever and no traces ever appeared in the dashboard.
  - `.close()` clears the wake-up signal, drains remaining events, and
    joins the thread within `timeout` seconds.

Why a thread (not asyncio):
  Python's `asyncio` doesn't run in non-async contexts (e.g. a sync
  Flask request handler in a pre-3.12 app), and we have to work in both.
  A daemon thread is the lowest-common-denominator that works for
  sync code, async code, and background scripts. The thread holds a
  `queue.Queue` which is itself thread-safe; the synchronisation cost
  is negligible compared to the HTTP latency we're hiding.

Why httpx (not requests):
  httpx supports both sync and async with one API. Chunk 2's
  AsyncOpenAI / AsyncAnthropic instrumentation lives in the same
  process; sharing httpx means we don't ship two HTTP clients.
"""

from __future__ import annotations

import atexit
import json
import logging
import queue
import threading
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import httpx

from ._version import __version__
from .wire._event import LLMEvent

if TYPE_CHECKING:
    from ._config import ScopeCallConfig

logger = logging.getLogger(__name__)


class Exporter:
    """Thread-safe queue + auto-flush + HTTP delivery.

    One instance per SDK. `enqueue()` is what every instrumentation /
    manual-API call hits on the hot path — must be O(1) and never block.
    """

    def __init__(self, config: ScopeCallConfig) -> None:
        self._config = config
        self._queue: queue.Queue[LLMEvent] = queue.Queue(maxsize=config.queue_max_size)
        self._shutdown_event = threading.Event()
        self._flush_now = threading.Event()
        self._file_lock = threading.Lock()

        # Concurrent flush guard — without this lock, an auto-tick and a
        # manual `flush()` could each drain half a batch and post both
        # halves in parallel. The lock makes flush serial; the auto-tick
        # yields if a manual flush is in progress.
        self._flush_lock = threading.Lock()

        # HTTP client lives for the SDK's lifetime so we get TCP keepalive
        # across batches. Headers are constant — set once.
        self._http: httpx.Client | None = None
        if config.mode == "api":
            self._http = httpx.Client(
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {config.api_key or ''}",
                    "User-Agent": f"scopecall-python/{__version__}",
                    "X-ScopeCall-SDK": "python",
                },
                timeout=10.0,
            )

        # Background flush thread. Daemon=True so a misbehaving thread
        # doesn't block process exit; the atexit hook below explicitly
        # drains before the interpreter tears down.
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="scopecall-exporter"
        )
        self._thread.start()
        # atexit-driven drain is the safety net for callers who forget
        # to `sdk.close()`. Same role as TS's `attachProcessHooks`.
        atexit.register(self._on_atexit)

    # ── Hot path ────────────────────────────────────────────────────────

    def enqueue(self, event: LLMEvent) -> None:
        """Add an event to the export queue. Non-blocking.

        On overflow we drop the OLDEST event (not the new one) — same
        policy as the TS circular buffer. Rationale: in a sustained
        burst the freshest events are the most useful for live debugging,
        so we'd rather keep "what just happened" than "what happened
        first" when the queue saturates.
        """
        if self._config.mode == "noop":
            return
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            # Drop oldest, retry. Two-stage so the get + put are both
            # non-blocking; if another thread drains between them we
            # might still fail to enqueue — that's acceptable degraded
            # behavior under heavy backpressure.
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(event)
            except (queue.Empty, queue.Full):
                pass

    # ── User-facing controls ────────────────────────────────────────────

    def flush(self, timeout: float = 5.0) -> None:
        """Drain the queue synchronously, blocking up to `timeout` seconds.

        Returns when either:
          - every queued event has been posted (or written to file /
            console), OR
          - `timeout` elapses, whichever comes first.

        Safe to call concurrently with auto-flush ticks — the lock
        serialises them.
        """
        self._flush_now.set()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            # unfinished_tasks counts items dequeued but not `task_done()`d —
            # essentially "events that started flushing but haven't
            # finished." When the queue is empty AND no flush is in
            # flight, we're truly drained.
            if self._queue.unfinished_tasks == 0:
                return
            time.sleep(0.02)

    def close(self, timeout: float = 5.0) -> None:
        """Shut the SDK down: stop the auto-flush thread, drain remaining
        events, close the HTTP client.

        Idempotent — calling twice is a no-op.
        """
        if self._shutdown_event.is_set():
            return
        self._shutdown_event.set()
        # Wake the flush thread so it sees the shutdown signal without
        # waiting out its current sleep interval.
        self._flush_now.set()
        self._thread.join(timeout=timeout)
        if self._http is not None:
            self._http.close()
            self._http = None

    # ── Internals ───────────────────────────────────────────────────────

    def _on_atexit(self) -> None:
        # atexit is best-effort — if the process is dying from SIGKILL
        # we never get here. For graceful exits this gives us one last
        # chance to ship the queue.
        try:
            self.close(timeout=2.0)
        except Exception:  # noqa: BLE001
            pass

    def _run(self) -> None:
        """Auto-flush loop. Wakes on either a periodic tick or an explicit
        `flush_now` signal."""
        while not self._shutdown_event.is_set():
            self._flush_now.wait(timeout=self._config.flush_interval)
            self._flush_now.clear()
            self._drain()
        # Final drain on shutdown — the wait loop above might exit without
        # draining the queue if `_shutdown_event` was set first.
        self._drain()

    def _drain(self) -> None:
        """Pop up to batch_size events, ship them, mark task_done.

        Held under `_flush_lock` so a manual flush() can't double-drain
        while the auto-tick is mid-flight.
        """
        with self._flush_lock:
            batch: list[LLMEvent] = []
            while len(batch) < self._config.batch_size:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break
            if not batch:
                return

            try:
                self._send_batch(batch)
            except Exception as exc:  # noqa: BLE001
                # The SDK must NEVER raise into customer code. A failed
                # batch is logged at debug — operators who want louder
                # logging can crank `logging.getLogger("scopecall")` up.
                logger.debug("scopecall: export failed: %s", exc)
            finally:
                for _ in batch:
                    self._queue.task_done()

    def _send_batch(self, batch: list[LLMEvent]) -> None:
        """Ship one batch via the configured transport (console/file/API).

        The HTTP envelope matches the Rust ingest contract documented in
        `services-rust/ingest/src/routes/ingest.rs`:

            { "events": [ <LLMEvent.to_wire()>, ... ],
              "sent_at": "<RFC3339 timestamp>" }

        The Rust side rejects payloads without `sent_at` to catch clock
        skew / stale-deliveries.
        """
        mode = self._config.mode

        if mode == "console":
            for ev in batch:
                print(json.dumps(ev.to_wire(), indent=2, default=str))
            return

        if mode == "file":
            assert self._config.output is not None
            with self._file_lock, open(self._config.output, "a") as f:
                for ev in batch:
                    f.write(json.dumps(ev.to_wire(), default=str) + "\n")
            return

        # API mode. Retries with exponential backoff; on final failure
        # the events are silently dropped (logged at debug). The Rust
        # ingest is durable past this point — once a 2xx returns, the
        # event is committed to Redpanda before the HTTP response is
        # sent, so we don't have to worry about partial acceptance.
        assert self._http is not None
        assert self._config.endpoint is not None
        envelope = {
            "events": [ev.to_wire() for ev in batch],
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }
        backoff = 0.1
        for attempt in range(self._config.max_retries):
            if self._shutdown_event.is_set() and attempt > 0:
                # Don't keep retrying past shutdown — better to drop
                # than to delay process exit.
                return
            try:
                resp = self._http.post(self._config.endpoint, json=envelope)
                resp.raise_for_status()
                return
            except httpx.HTTPError as exc:
                if attempt < self._config.max_retries - 1:
                    # Use the shutdown event as the sleep — wakes early
                    # on close() so we don't waste backoff time during
                    # graceful shutdown.
                    self._shutdown_event.wait(timeout=backoff)
                    backoff *= 2
                else:
                    logger.debug(
                        "scopecall: dropping %d events after %d retries: %s",
                        len(batch),
                        self._config.max_retries,
                        exc,
                    )
