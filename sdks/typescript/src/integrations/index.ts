/**
 * ScopeCall framework integrations (TypeScript).
 *
 * Parity with the Python SDK's `scopecall.integrations`. Each adapter is
 * thin, built on the SDK's manual span/record API, no-op when ScopeCall is
 * uninitialized, and never throws into the host framework.
 */

export { spanCallable, type SpanCallableOpts } from "./base.js";
export { ScopeCallCallbackHandler, instrument as instrumentLangchain } from "./langchain.js";
