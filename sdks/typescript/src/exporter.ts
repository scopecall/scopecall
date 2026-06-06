import type { Transport, ExportRequest, ExportResponse } from "./transport/types.js";
import type { LLMEvent } from "./wire/llm-event.js";
import type { ScopeCallConfig } from "./config.js";
import { ConsoleTransport } from "./transport/console.js";
import { FileTransport } from "./transport/file.js";
import { HttpTransport } from "./transport/http.js";
import { ConfigError } from "./config.js";

// ---------------------------------------------------------------------------
// Circular buffer — O(1) enqueue and dequeue, drop-oldest on overflow
// ---------------------------------------------------------------------------

class CircularBuffer<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  enqueue(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      // Buffer full — advance tail to drop the oldest entry
      this.tail = (this.tail + 1) % this.capacity;
    }
  }

  dequeue(count: number): T[] {
    const out: T[] = [];
    const n = Math.min(count, this.size);
    for (let i = 0; i < n; i++) {
      out.push(this.buf[this.tail] as T);
      this.buf[this.tail] = undefined; // allow GC
      this.tail = (this.tail + 1) % this.capacity;
      this.size--;
    }
    return out;
  }

  get length(): number {
    return this.size;
  }
}

// ---------------------------------------------------------------------------
// Select transport based on config precedence
// ---------------------------------------------------------------------------

function selectTransport(config: ScopeCallConfig): Transport {
  if (config.transport) return config.transport;           // custom injection
  if (config.debug)    return new ConsoleTransport();      // 1: debug flag
  if (config.output)   return new FileTransport(config.output); // 2: file path
  if (config.apiKey)   return new HttpTransport(config);   // 3: HTTP to ScopeCall
  throw new ConfigError(
    "No transport configured. Provide apiKey, output, debug:true, or a custom transport."
  );
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

type Logger = NonNullable<ScopeCallConfig["logger"]>;

const DEFAULT_LOGGER: Logger = {
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

export class ScopeCallExporter {
  private readonly transport: Transport;
  private readonly queue: CircularBuffer<LLMEvent>;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly logger: Logger | null;
  private closed = false;
  /**
   * Periodic auto-flush timer. Without this, a long-running server would
   * queue events forever and never surface them until process exit — the
   * README's "traces appear within seconds" claim was false in production.
   * The interval is .unref()'d so it doesn't keep the process alive on
   * its own.
   */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Concurrent-flush guard. The auto-flush tick and a user-driven
   * sdk.flush() can fire at the same moment; without this they'd
   * race over the queue's dequeue / sendWithRetry path and could
   * double-send batches. The guard tracks "a flush is in progress";
   * a second flush() call awaits the same promise instead of starting
   * its own loop.
   */
  private inflightFlush: Promise<void> | null = null;

  constructor(private readonly config: ScopeCallConfig) {
    this.transport = selectTransport(config);
    this.queue = new CircularBuffer<LLMEvent>(config.queueMaxSize ?? 10_000);
    this.batchSize = config.batchSize ?? 50;
    this.maxRetries = config.maxRetries ?? 3;
    this.baseDelayMs = config.baseDelayMs ?? 1_000;
    this.logger = config.logger === null ? null : (config.logger ?? DEFAULT_LOGGER);

    // Start the periodic auto-flush loop. 5s default — frequent enough that
    // an LLM call in a long-running server surfaces on the dashboard before
    // the user gets bored switching tabs. Set flushIntervalMs: 0 to opt out
    // (rare; test harnesses or callers that drive flush manually).
    const intervalMs = config.flushIntervalMs ?? 5_000;
    if (intervalMs > 0) {
      this.flushTimer = setInterval(() => {
        // Swallow errors — periodic flush failures already log via
        // sendWithRetry; an unhandled rejection here would kill the
        // user's process.
        this.flush().catch(() => undefined);
      }, intervalMs);
      // .unref() lets the host process exit even when our timer is the
      // only thing left on the loop. Without it, a CLI tool that uses
      // the SDK would hang forever waiting for our setInterval.
      this.flushTimer.unref?.();
    }
  }

  enqueue(event: LLMEvent): void {
    if (this.closed) return;
    this.queue.enqueue(event);
  }

  /**
   * Drain the entire queue, flushing in batches.
   * Exits early if the timeout elapses (default 5s).
   *
   * Concurrent callers (auto-flush tick + a manual sdk.flush()) await the
   * same in-flight drain instead of racing.
   */
  async flush(timeoutMs = 5_000): Promise<void> {
    if (this.inflightFlush) return this.inflightFlush;
    const p = this.drainOnce(timeoutMs);
    this.inflightFlush = p.finally(() => { this.inflightFlush = null; });
    return this.inflightFlush;
  }

  private async drainOnce(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0) {
      if (Date.now() > deadline) {
        this.logger?.warn(
          `[scopecall] flush timed out after ${timeoutMs}ms, ${this.queue.length} events dropped`
        );
        return;
      }
      const batch = this.queue.dequeue(this.batchSize);
      await this.sendWithRetry(batch);
    }
  }

  private async sendWithRetry(
    events: LLMEvent[],
    attempt = 0
  ): Promise<void> {
    // Wire format: snake_case to match the Rust ingest's serde DTO.
    // Early versions of the SDK sent `sentAt` (camelCase) — the ingest
    // rejected the batch with a 400 and the SDK swallowed the error.
    // See services-rust/common/src/event.rs IngestBatch.
    const req: ExportRequest = { events, sent_at: new Date().toISOString() } as ExportRequest;
    let res: ExportResponse;
    try {
      res = await this.transport.send(req);
    } catch (err) {
      res = { ok: false, status: 503 };
    }

    if (res.ok) return;

    // 4xx non-429: client error, do not retry
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      this.logger?.error(
        `[scopecall] export rejected (${res.status}), dropping ${events.length} events`
      );
      return;
    }

    if (attempt >= this.maxRetries) {
      this.logger?.warn(
        `[scopecall] export failed after ${this.maxRetries} retries, dropping ${events.length} events`
      );
      return;
    }

    // Honor Retry-After header (capped at 60s), otherwise use jitter backoff
    const retryAfter = res.retryAfterSeconds;
    const jitter =
      this.baseDelayMs * Math.pow(2, attempt) * (1 + Math.random() * 0.25);
    const delayMs =
      retryAfter != null && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60_000)
        : jitter;

    await new Promise<void>((r) => setTimeout(r, delayMs));
    return this.sendWithRetry(events, attempt + 1);
  }

  async close(): Promise<void> {
    this.closed = true;
    // Clear the auto-flush timer FIRST so no new flush starts after we've
    // begun the final drain. Otherwise the periodic tick could fire one
    // last time, race with our flush(), and either double-send (mitigated
    // by inflightFlush) or block close() by keeping inflightFlush busy.
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await this.transport.close?.();
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle hooks — set up once per exporter instance
// ---------------------------------------------------------------------------

export function attachProcessHooks(exporter: ScopeCallExporter): void {
  const onExit = () => {
    // beforeExit: synchronous flush is not possible; schedule microtask
    exporter.flush(3_000).catch(() => undefined);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    exporter
      .flush(5_000)
      .catch(() => undefined)
      .finally(() => {
        process.removeListener(signal, handlers[signal]);
        process.kill(process.pid, signal); // re-emit so other handlers run
      });
  };

  const handlers: Record<string, () => void> = {
    SIGTERM: () => onSignal("SIGTERM"),
    SIGINT:  () => onSignal("SIGINT"),
  };

  process.once("beforeExit", onExit);
  process.once("SIGTERM", handlers.SIGTERM);
  process.once("SIGINT",  handlers.SIGINT);
}
