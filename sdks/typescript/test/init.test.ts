// V5.7  init() basic + return value
// V5.10 init() idempotent — second call returns first instance + warns
// V5.11 disabled:true emits zero events

import { describe, it, expect, beforeEach, vi } from "vitest";
import { init, _resetInstance, ConfigError } from "../src/index.js";
import type { Transport } from "../src/transport/types.js";
import type { ExportRequest, ExportResponse } from "../src/transport/types.js";
import type { LLMEvent } from "../src/wire/llm-event.js";

function collectingTransport(): Transport & { events: LLMEvent[] } {
  const events: LLMEvent[] = [];
  return {
    events,
    async send(req: ExportRequest): Promise<ExportResponse> {
      events.push(...req.events);
      return { ok: true, status: 200 };
    },
  };
}

beforeEach(() => {
  _resetInstance();
});

describe("init()", () => {
  it("throws ConfigError when no transport is configured", () => {
    expect(() => init({})).toThrow(ConfigError);
  });

  it("returns an SDK instance with custom transport", () => {
    const mock = collectingTransport();
    const sdk = init({ transport: mock });
    expect(sdk).toBeDefined();
    expect(sdk.disabled).toBe(false);
  });

  it("V5.10 — second call returns first instance and warns", () => {
    const warnMessages: string[] = [];
    const mock = collectingTransport();
    const logger = { warn: (m: string) => warnMessages.push(m), error: vi.fn() };

    const a = init({ transport: mock, logger });
    const b = init({ transport: mock, logger });

    expect(a).toBe(b);
    expect(warnMessages.length).toBe(1);
    expect(warnMessages[0]).toMatch(/more than once/);
  });

  it("V5.11 — disabled:true emits zero events", async () => {
    const mock = collectingTransport();
    const sdk = init({ disabled: true, transport: mock });

    expect(sdk.disabled).toBe(true);
    await sdk.trace("noop", async () => "x");
    await sdk.flush();

    expect(mock.events.length).toBe(0);
  });

  it("debug:true selects ConsoleTransport (no throw)", () => {
    expect(() => init({ debug: true })).not.toThrow();
  });

  it("output path selects FileTransport (no throw)", () => {
    expect(() => init({ output: "/tmp/test-scopecall.ndjson" })).not.toThrow();
  });

  it("apiKey + endpoint selects HttpTransport (no throw)", () => {
    expect(() =>
      init({ apiKey: "sc_test_key", endpoint: "http://localhost:8080/v1/ingest" })
    ).not.toThrow();
  });

  it("apiKey WITHOUT endpoint throws ConfigError", () => {
    // A missing endpoint used to silently default to a hosted-Cloud URL
    // that doesn't exist yet, so a fresh user would lose events with no
    // signal. We now require endpoint up front.
    expect(() => init({ apiKey: "sc_test_key" })).toThrow(/endpoint/i);
  });
});
