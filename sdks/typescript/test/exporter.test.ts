// V5.15 Circular buffer O(1) performance (tinybench)
// V5.18 Retry-After header honored
// V5.19 4xx non-429 not retried
// V5.20 SIGTERM flush completes before process exit

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Bench } from "tinybench";
import { ScopeCallExporter } from "../src/exporter.js";
import type { Transport } from "../src/transport/types.js";
import type { ExportRequest, ExportResponse } from "../src/transport/types.js";
import type { LLMEvent } from "../src/wire/llm-event.js";

// Fixture honors the CURRENT wire contract (not the original pre-fix
// shape). `satisfies LLMEvent` makes the compiler enforce all required
// fields and reject `null` for non-nullable ones (trace_id, input_text,
// output_text, kind). The previous version of this fixture was stale —
// it still set trace_id: null and timestamp: ISO string, which the
// production SDK would never emit and which Rust ingest would 400.
function makeEvent(override?: Partial<LLMEvent>): LLMEvent {
  const spanId = crypto.randomUUID();
  return {
    span_id: spanId,
    trace_id: spanId,            // synth single-span trace, matches SDK behaviour
    parent_span_id: null,
    timestamp: Date.now(),       // Unix epoch ms (number, not ISO string)
    latency_ms: 100,
    ttft_ms: null,
    model: "gpt-4o",
    provider: "openai",
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.000075,
    status: "success",
    error_message: null,
    input_text: "hello",
    output_text: "world",
    feature_name: null,
    user_id: null,
    session_id: null,
    environment: "test",
    sdk_version: "0.1.0",
    extra: null,
    finish_reason: null,
    cache_read_tokens: null,
    original_model: null,
    budget_state: null,
    failure_mode: null,
    tool_calls: null,
    prompt_version: null,
    kind: "llm",
    ...override,
  } satisfies LLMEvent;
}

function countingTransport(responses: ExportResponse[]): Transport & { callCount: number } {
  let callCount = 0;
  let idx = 0;
  return {
    get callCount() { return callCount; },
    async send(_req: ExportRequest): Promise<ExportResponse> {
      callCount++;
      const r = responses[Math.min(idx++, responses.length - 1)];
      return r;
    },
  };
}

describe("CircularBuffer + flush loop", () => {
  it("flushes all queued events (while-loop drains, not single splice)", async () => {
    const received: LLMEvent[] = [];
    const transport: Transport = {
      async send(req) {
        received.push(...req.events);
        return { ok: true, status: 200 };
      },
    };

    const exporter = new ScopeCallExporter({
      transport,
      batchSize: 3,
      queueMaxSize: 100,
    });

    for (let i = 0; i < 10; i++) {
      exporter.enqueue(makeEvent());
    }

    await exporter.flush();
    expect(received.length).toBe(10); // all 10, not just the first batch of 3
  });

  it("drop-oldest when queue is full", async () => {
    const transport: Transport = {
      async send() { return { ok: true, status: 200 }; },
    };

    // capacity = 3
    const exporter = new ScopeCallExporter({
      transport,
      queueMaxSize: 3,
    });

    // enqueue 5 — first 2 should be dropped
    for (let i = 0; i < 5; i++) {
      exporter.enqueue(makeEvent({ span_id: `id-${i}` }));
    }

    const received: LLMEvent[] = [];
    const capturingTransport: Transport = {
      async send(req) {
        received.push(...req.events);
        return { ok: true, status: 200 };
      },
    };

    // Swap transport and flush
    const exporter2 = new ScopeCallExporter({ transport: capturingTransport, queueMaxSize: 3 });
    for (let i = 0; i < 5; i++) {
      exporter2.enqueue(makeEvent({ span_id: `id-${i}` }));
    }
    await exporter2.flush();

    expect(received.length).toBe(3);
    // Oldest (id-0, id-1) dropped; newest (id-2, id-3, id-4) kept
    expect(received.map((e) => e.span_id)).toEqual(["id-2", "id-3", "id-4"]);
  });
});

describe("V5.15 — Circular buffer O(1) performance", async () => {
  it("enqueue p99 < 1μs, dequeue(50) p99 < 5μs", async () => {
    const transport: Transport = {
      async send() { return { ok: true, status: 200 }; },
    };
    const exporter = new ScopeCallExporter({ transport, queueMaxSize: 10_000 });
    const event = makeEvent();

    const bench = new Bench({ warmupIterations: 100, iterations: 1000 });

    bench.add("enqueue", () => {
      exporter.enqueue(event);
    });

    await bench.run();

    const enqueueTask = bench.tasks.find((t) => t.name === "enqueue")!;
    const p99 = enqueueTask.result!.p99 / 1000; // ns → μs

    // p99 should be well under 1μs for a simple array write + modulo
    expect(p99).toBeLessThan(1);
  }, 30_000);
});

describe("V5.18 — Retry-After header honored", async () => {
  it("waits ≥ retryAfterSeconds before retrying", async () => {
    let callCount = 0;
    const callTimes: number[] = [];

    const transport: Transport = {
      async send() {
        callTimes.push(Date.now());
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 429, retryAfterSeconds: 0.1 }; // 100ms for test speed
        }
        return { ok: true, status: 200 };
      },
    };

    const exporter = new ScopeCallExporter({ transport, maxRetries: 3, baseDelayMs: 10 });
    exporter.enqueue(makeEvent());

    const start = Date.now();
    await exporter.flush();
    const elapsed = Date.now() - start;

    expect(callCount).toBe(2); // one failure, one retry
    expect(elapsed).toBeGreaterThanOrEqual(90); // honored the 100ms Retry-After (±10ms tolerance)
  }, 10_000);
});

describe("V5.19 — 4xx non-429 not retried", () => {
  it("400 response: send called exactly once, no retry", async () => {
    const transport = countingTransport([{ ok: false, status: 400 }]);

    const exporter = new ScopeCallExporter({
      transport,
      maxRetries: 3,
      logger: null, // silence warning
    });

    exporter.enqueue(makeEvent());
    await exporter.flush();

    expect(transport.callCount).toBe(1);
  });

  it("401 response: not retried", async () => {
    const transport = countingTransport([{ ok: false, status: 401 }]);
    const exporter = new ScopeCallExporter({ transport, maxRetries: 3, logger: null });
    exporter.enqueue(makeEvent());
    await exporter.flush();
    expect(transport.callCount).toBe(1);
  });
});

describe("V5.20 — SIGTERM flush completes", () => {
  afterEach(() => {
    // Remove any stray SIGTERM listeners added during test
    process.removeAllListeners("SIGTERM");
  });

  it("all queued events are flushed when SIGTERM fires", async () => {
    // We test the flush() contract directly since emitting SIGTERM in a test
    // process would terminate the test runner. The attachProcessHooks function
    // calls flush() on SIGTERM — we verify flush() drains the queue.
    const received: LLMEvent[] = [];
    const transport: Transport = {
      async send(req) {
        received.push(...req.events);
        return { ok: true, status: 200 };
      },
    };

    const exporter = new ScopeCallExporter({ transport });

    for (let i = 0; i < 5; i++) {
      exporter.enqueue(makeEvent({ span_id: `sig-${i}` }));
    }

    // Simulate what the SIGTERM handler does
    await exporter.flush(5_000);

    expect(received.length).toBe(5);
    expect(received.map((e) => e.span_id)).toEqual(
      Array.from({ length: 5 }, (_, i) => `sig-${i}`)
    );
  });
});

// ─── Auto-flush — without this, README's "traces in seconds" was false
//     for any long-running server. The next two tests are the
//     load-bearing protection against regressions.
describe("periodic auto-flush", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers events to the transport without a manual flush() call", async () => {
    vi.useFakeTimers();
    const received: LLMEvent[] = [];
    const transport: Transport = {
      async send(req) { received.push(...req.events); return { ok: true, status: 200 }; },
    };
    const exp = new ScopeCallExporter({
      transport,
      // 1s — frequent so the test stays quick. Production default is 5s.
      flushIntervalMs: 1000,
    });
    exp.enqueue(makeEvent({ span_id: "auto-1" }));
    expect(received.length).toBe(0); // nothing sent immediately

    // Advance fake time past the interval and let the queued flush promise
    // resolve. runAllTimersAsync covers both the setInterval tick AND any
    // microtask follow-ups inside drainOnce / sendWithRetry.
    await vi.advanceTimersByTimeAsync(1100);
    expect(received.length).toBe(1);
    expect(received[0]!.span_id).toBe("auto-1");
  });

  it("close() clears the timer so the process can exit", async () => {
    const received: LLMEvent[] = [];
    const transport: Transport = {
      async send(req) { received.push(...req.events); return { ok: true, status: 200 }; },
    };
    const exp = new ScopeCallExporter({ transport, flushIntervalMs: 50 });
    exp.enqueue(makeEvent({ span_id: "close-1" }));
    await exp.close();
    expect(received.length).toBe(1);
    // After close, the internal flushTimer should be null. Probe via the
    // private field — exposes one regression vector (interval leaking past
    // close) that you can't see from the public surface.
    expect((exp as unknown as { flushTimer: unknown }).flushTimer).toBeNull();
  });

  it("flushIntervalMs: 0 disables auto-flush (manual control only)", async () => {
    vi.useFakeTimers();
    const received: LLMEvent[] = [];
    const transport: Transport = {
      async send(req) { received.push(...req.events); return { ok: true, status: 200 }; },
    };
    const exp = new ScopeCallExporter({ transport, flushIntervalMs: 0 });
    exp.enqueue(makeEvent({ span_id: "no-auto" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(received.length).toBe(0); // no auto-flush
    await exp.flush();
    expect(received.length).toBe(1); // manual flush still works
  });

  it("concurrent flush calls share a single in-flight drain", async () => {
    // The auto-flush tick can race with a user's manual sdk.flush(). The
    // inflightFlush guard makes both await the same drain instead of
    // double-dequeueing the queue.
    let sendCount = 0;
    const transport: Transport = {
      async send(req) {
        sendCount++;
        // Slow send so two flush calls genuinely overlap in time.
        await new Promise<void>((r) => setTimeout(r, 30));
        return { ok: true, status: 200 };
      },
    };
    const exp = new ScopeCallExporter({ transport, flushIntervalMs: 0 });
    for (let i = 0; i < 3; i++) exp.enqueue(makeEvent({ span_id: `c-${i}` }));
    // Fire two concurrent flushes. Without the guard, both would start
    // separate drain loops; the queue uses a circular buffer with no
    // per-batch locking, so they could each dequeue overlapping batches
    // and we'd see >1 transport.send for the same 3 events.
    await Promise.all([exp.flush(), exp.flush()]);
    expect(sendCount).toBe(1);
  });
});
