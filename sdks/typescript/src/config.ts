import type { Transport } from "./transport/types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ScopeCallConfig {
  /** API key for the ScopeCall ingest endpoint. Selects HttpTransport. */
  apiKey?: string;
  /** Ingest endpoint URL. Required for apiKey-based HTTP transport — set to
   *  your self-hosted ingest, e.g. "http://localhost:8080/v1/ingest". A
   *  managed-Cloud default will be reintroduced when scopecall.com hosted
   *  ingest is live. */
  endpoint?: string;
  /** Pretty-print events to stdout instead of sending. Overrides apiKey + output. */
  debug?: boolean;
  /** Write NDJSON events to this file path. Overrides apiKey. */
  output?: string;
  /** Inject a custom Transport implementation. Overrides all built-in selection. */
  transport?: Transport;
  /** deployment environment label */
  environment?: string;
  /** Redact PII from input_text / output_text. Set false to disable entirely. */
  redact?: boolean | { additionalPatterns?: Array<{ name: string; regex: string }> };
  /** Capture LLM input/output text. Default true. */
  captureContent?: boolean;
  /** Max events in the circular buffer before oldest are dropped. Default 10_000. */
  queueMaxSize?: number;
  /** Batch size per flush call. Default 50. */
  batchSize?: number;
  /** Max retries on failed export. Default 3. */
  maxRetries?: number;
  /** Base delay (ms) for jitter backoff. Default 1_000. */
  baseDelayMs?: number;
  /**
   * Milliseconds between automatic background flushes. The exporter holds
   * events in a circular buffer; without periodic flushing they only ship
   * on sdk.close() or process exit, so a long-running server would never
   * surface traces. Default 5000ms (5s). Set to 0 to DISABLE auto-flush
   * (rare; tests or callers driving flush manually).
   *
   * Round-5 external review P0: the README claims "traces appear within
   * seconds" but without auto-flush that's only true in test harnesses.
   * Production servers ran forever queuing events with no visible output.
   */
  flushIntervalMs?: number;
  /** Disable the SDK entirely — no events emitted. */
  disabled?: boolean;
  /** Default feature name attached to all events. */
  defaultFeature?: string;
  /** Default user ID attached to all events. */
  defaultUserId?: string;
  /** Default session ID attached to all events. */
  defaultSessionId?: string;
  /**
   * Default prompt version label attached to events when no trace-level
   * promptVersion is set. Useful for single-prompt apps that want every
   * call tagged with a build/commit/release identifier.
   *
   * Precedence (highest first): trace() opts.promptVersion → parent
   * trace's promptVersion → this default → null.
   */
  defaultPromptVersion?: string;
  /** Logger for internal SDK warnings. Defaults to console. Set null to silence. */
  logger?: { warn(msg: string): void; error(msg: string): void } | null;
}

export function validate(config: ScopeCallConfig): void {
  if (config.disabled) return; // disabled mode: no transport needed
  if (config.transport) return; // custom transport: always valid
  if (config.debug) return;
  if (config.output) return;
  if (!config.apiKey) {
    throw new ConfigError(
      "scopecall.init() requires one of: apiKey, output, debug:true, or a custom transport."
    );
  }
  // endpoint is required when using apiKey-based HTTP transport.
  //
  // The previous default — https://ingest.scopecall.com/v1/ingest — points at
  // a hosted-Cloud endpoint that doesn't exist yet. A user who omitted
  // `endpoint` would silently send events into the void with no actionable
  // signal that anything was wrong. (Round-8 review.)
  //
  // For the source-available release we make `endpoint` an explicit
  // requirement and the error tells the user exactly what to supply. When
  // ScopeCall Cloud goes live we can revisit and reintroduce a default —
  // but ONLY at the same moment that domain actually serves traffic.
  if (!config.endpoint) {
    throw new ConfigError(
      "scopecall.init({ apiKey }) requires `endpoint`. " +
      "Self-hosted: point at your ingest service, e.g. " +
      "endpoint: 'http://localhost:8080/v1/ingest'. " +
      "(ScopeCall Cloud is not yet available; a managed default endpoint will return in a future release.)"
    );
  }
}
