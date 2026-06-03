/**
 * SDK initialisation entry point — env-var driven.
 *
 * v0.1 scope: this file handles init() only via environment variables.
 * It does NOT auto-patch AI client libraries.
 * After loading this file, call sdk.instrument(client) in your application:
 *
 *   // ESM (--import flag):
 *   node --import @scopecall/scopecall-js/register my-app.js
 *
 *   // CJS (-r flag):
 *   node -r @scopecall/scopecall-js/register my-app.js
 *
 *   // Then in my-app.js:
 *   import { init } from "@scopecall/scopecall-js";
 *   const sdk = init();          // idempotent — returns the instance created by register.ts
 *   sdk.instrument(openaiClient); // explicit instrument call required at v0.1
 *
 * Environment variables:
 *   SCOPECALL_API_KEY      — sets apiKey (selects HttpTransport)
 *   SCOPECALL_ENDPOINT     — overrides default ingest endpoint
 *   SCOPECALL_DEBUG        — "1" or "true" → ConsoleTransport (overrides apiKey)
 *   SCOPECALL_OUTPUT       — file path → FileTransport
 *   SCOPECALL_ENVIRONMENT  — deployment environment label (default: "production")
 *   SCOPECALL_DISABLED     — "1" or "true" → disabled no-op mode
 */

import { init } from "./index.js";

const env = process.env;

const debug = env.SCOPECALL_DEBUG === "1" || env.SCOPECALL_DEBUG === "true";
const disabled = env.SCOPECALL_DISABLED === "1" || env.SCOPECALL_DISABLED === "true";

// Only init if at least one transport-selecting env var is present
if (debug || env.SCOPECALL_OUTPUT || env.SCOPECALL_API_KEY || disabled) {
  init({
    apiKey: env.SCOPECALL_API_KEY,
    endpoint: env.SCOPECALL_ENDPOINT,
    debug,
    output: env.SCOPECALL_OUTPUT,
    environment: env.SCOPECALL_ENVIRONMENT ?? "production",
    disabled,
  });
}
