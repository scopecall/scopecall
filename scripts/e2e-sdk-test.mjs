#!/usr/bin/env node
// End-to-end check using the ACTUAL TypeScript SDK (not curl-bypass).
//
// What this proves
// ----------------
// Round-5 reviewer flagged that scripts/e2e-test.sh sends events via curl,
// bypassing sdks/typescript/src/exporter.ts entirely. So a regression where
// the exporter stops auto-flushing wouldn't be caught.
//
// This script:
//   1. Imports the built @scopecall/scopecall-js from ../sdks/typescript/dist.
//   2. Initialises with a SHORT flushIntervalMs (1.5s) and no manual flush.
//   3. Wraps a fake openai-shaped client in sdk.trace() + sdk.instrument().
//   4. Awaits 3s (well past the flush interval) WITHOUT calling sdk.flush().
//   5. Queries ClickHouse directly to assert the workflow row + LLM row
//      both landed via the periodic auto-flush.
//
// If this script ever starts failing while scripts/e2e-test.sh still
// passes, the exporter's auto-flush has regressed and "events appear
// within seconds" stopped being true.
//
// Prerequisite: SDK must be built (pnpm --filter @scopecall/scopecall-js build,
// or `cd sdks/typescript && npm run build`). The bootstrap script does
// this for you.
//
// Usage:
//   node scripts/e2e-sdk-test.mjs
//
// Env overrides:
//   SDK_API_KEY    (default sc_live_dev_000000000000000000)
//   INGEST_URL     (default http://localhost:8080/v1/ingest)
//   CH_CONTAINER   (default scopecall-clickhouse)
//   FLUSH_INTERVAL_MS (default 1500)

import { init } from "../sdks/typescript/dist/index.js";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const SDK_API_KEY  = process.env.SDK_API_KEY  ?? "sc_live_dev_000000000000000000";
const INGEST_URL   = process.env.INGEST_URL   ?? "http://localhost:8080/v1/ingest";
const CH_CONTAINER = process.env.CH_CONTAINER ?? "scopecall-clickhouse";
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS ?? 1500);

// Unique marker so we can find ONLY this run's events in CH. The SDK uses
// feature_name as the dashboard's user-facing label, so this is the
// cleanest dimension to filter on.
const RUN_MARKER = `e2e-sdk-${randomUUID().slice(0, 8)}`;

// Tiny duck-type of the OpenAI client shape so we can exercise
// sdk.instrument(client, "openai") without taking a peer dep. The
// instrumenter only cares about chat.completions.create being a function
// that returns a Promise<ChatCompletion>.
const fakeOpenAI = {
  chat: {
    completions: {
      async create({ model, messages }) {
        return {
          id: `cmpl_${randomUUID().slice(0, 12)}`,
          model,
          usage: { prompt_tokens: 50, completion_tokens: 25 },
          choices: [{
            message: { content: `(echo) ${messages[0]?.content ?? ""}`, role: "assistant" },
            finish_reason: "stop",
          }],
        };
      },
    },
  },
};

async function main() {
  console.log(`→ Using run marker feature_name="${RUN_MARKER}"`);
  console.log(`→ Initialising SDK (flushIntervalMs=${FLUSH_INTERVAL_MS}, NO manual flush)`);

  const sdk = init({
    apiKey: SDK_API_KEY,
    endpoint: INGEST_URL,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    // Belt + suspenders: defaultFeature would also tag the events, but
    // ctx.name from sdk.trace() takes precedence (the trace name IS the
    // user-facing feature_name). So we pass RUN_MARKER as the trace name
    // and use that to filter our row in CH.
    defaultFeature: RUN_MARKER,
  });
  sdk.instrument(fakeOpenAI, "openai");

  // sdk.trace(name, ...) overwrites feature_name = name on children.
  // Use RUN_MARKER as the name so the workflow + LLM rows we just created
  // are uniquely findable in CH (no flakes from other test runs).
  await sdk.trace(RUN_MARKER, async () => {
    await fakeOpenAI.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello from e2e-sdk-test" }],
    });
  });

  // CRITICAL: NO manual flush. The whole point of this test is that the
  // periodic auto-flush sends the events without our help.
  const waitMs = FLUSH_INTERVAL_MS + 2000;
  console.log(`→ Awaiting ${waitMs}ms (FLUSH_INTERVAL_MS + 2s grace)…`);
  await new Promise((r) => setTimeout(r, waitMs));

  // Query CH for our marker. We expect:
  //   1 workflow row (kind=workflow, span_id = trace's spanId)
  //   1 LLM row     (kind=llm,      parent_span_id = workflow's span_id)
  console.log("→ Querying ClickHouse…");
  const query = `
    SELECT
      countIf(kind='workflow') AS workflow_rows,
      countIf(kind='llm')      AS llm_rows,
      uniqExact(trace_id)      AS unique_traces
    FROM llm_calls
    WHERE feature_name = '${RUN_MARKER}'`.replace(/\n\s*/g, " ");

  const out = execSync(
    `docker exec ${CH_CONTAINER} clickhouse-client --query "${query}" --format TabSeparated`,
    { encoding: "utf8" },
  ).trim();
  const [workflowRows, llmRows, uniqueTraces] = out.split("\t").map(Number);

  console.log(`  workflow_rows=${workflowRows}  llm_rows=${llmRows}  unique_traces=${uniqueTraces}`);

  // The TS SDK auto-flush regression target: BOTH rows must appear without
  // any explicit flush(). One row means only one of them got drained
  // (rare); zero means the auto-flush never fired (regression).
  let ok = true;
  if (workflowRows !== 1) {
    console.error(`  ✗ expected 1 workflow row, got ${workflowRows}`);
    ok = false;
  }
  if (llmRows !== 1) {
    console.error(`  ✗ expected 1 LLM row, got ${llmRows}`);
    ok = false;
  }
  if (uniqueTraces !== 1) {
    console.error(`  ✗ expected 1 unique trace_id (workflow + LLM share it), got ${uniqueTraces}`);
    ok = false;
  }

  await sdk.close();

  if (!ok) {
    console.error("\nFAIL — auto-flush may have regressed.");
    process.exit(1);
  }
  console.log("\n✓ Auto-flush works — events surfaced without sdk.flush().");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
