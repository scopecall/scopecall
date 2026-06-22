/**
 * Framework-agnostic building blocks shared by ScopeCall's TypeScript
 * adapters. Mirrors the Python SDK's `integrations._base`.
 *
 * `spanCallable` wraps an async function so each call runs inside a span
 * (agent by default). Adapters compose it; everything degrades to a
 * transparent passthrough when ScopeCall is uninitialized, and never throws
 * into the host framework.
 */

import { getActive, type ScopeCallSDK } from "../index.js";
import type { TraceContext } from "../context.js";

type Kind = "workflow" | "agent" | "step";

export interface SpanCallableOpts {
  name?: string;
  kind?: Kind;
  /** Resolve the SDK lazily; defaults to getActive(). */
  sdkGetter?: () => ScopeCallSDK | undefined;
}

/**
 * Wrap an async function so each invocation runs inside a ScopeCall span.
 * Passthrough when ScopeCall is uninitialized; an instrumentation error
 * never escapes into the wrapped function.
 */
export function spanCallable<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: SpanCallableOpts = {},
): (...args: A) => Promise<R> {
  const kind: Kind = opts.kind ?? "agent";
  const name = opts.name ?? fn.name ?? kind;
  return async (...args: A): Promise<R> => {
    let sdk: ScopeCallSDK | undefined;
    try {
      sdk = opts.sdkGetter ? opts.sdkGetter() : getActive();
    } catch {
      sdk = undefined;
    }
    if (!sdk) return fn(...args);
    const run = sdk[kind] as (
      n: string,
      f: (ctx: TraceContext) => Promise<R>,
      o?: unknown,
    ) => Promise<R>;
    // run() emits the span event and re-raises the inner fn's error, so host
    // semantics are unchanged — no extra try/catch needed here.
    return run(name, async () => fn(...args));
  };
}
