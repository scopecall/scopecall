import { AsyncLocalStorage } from "node:async_hooks";

export interface TraceContext {
  /**
   * Workflow identifier — shared across every span inside this workflow.
   * Top-level trace() generates a fresh traceId; nested trace() calls
   * INHERIT the parent's traceId so the whole workflow groups together
   * on the dashboard. Without this, "show me the workflow that produced
   * this trace" never assembles correctly. (Round-2 external review P0.)
   */
  traceId: string;
  /** This span's id. Unique per trace() invocation. */
  spanId: string;
  /**
   * The span_id of the trace() call that this span is a child of.
   * `null` only for the root trace() (no enclosing trace). Instrumented
   * LLM calls read this from the active TraceContext to populate the
   * LLMEvent's parent_span_id.
   */
  parentSpanId: string | null;
  name: string;
  /**
   * Operator-supplied prompt iteration identifier. Set via the opts arg
   * to trace() and propagated to every instrumented LLM call inside `fn`.
   * Powers the Prompts page: cost/latency/error rate per version.
   *
   * Inheritance: nested trace() calls inherit the parent's promptVersion
   * unless they explicitly pass their own. This matches the mental model
   * that a "prompt" is a unit of code — child spans inside the same
   * prompt belong to that prompt's version too. To clear it on a nested
   * span, pass `{ promptVersion: null }` explicitly.
   */
  promptVersion: string | null;
  /**
   * Container kind for the synthetic span emitted on block exit. One of
   * "workflow" | "agent" | "step". trace() defaults to "workflow" for
   * backward compat; workflow() / agent() / step() set it explicitly so
   * the dashboard can group cost by level. The Rust ingest enforces the
   * closed enum {llm, workflow, agent, step}.
   */
  kind: "workflow" | "agent" | "step";
  /**
   * B2B customer / tenant identifier. Distinct from user_id (end-user):
   * for B2B apps where one customer organization has many end-users,
   * customer_id is the field cost reports group by. Inherited from
   * parent trace; explicit `opts.customerId` overrides. (v0.3)
   */
  customerId: string | null;
}

/**
 * Optional knobs for trace(). Kept narrow on purpose — anything that
 * applies broadly belongs on the SDK config, not per-call. The promptVersion
 * argument is the load-bearing one for v0.1.1.
 */
export interface TraceOptions {
  /** Identifier for the prompt iteration this trace is running. */
  promptVersion?: string | null;
  /**
   * Container kind override. Used internally by sdk.workflow() / agent() /
   * step() to set the right kind. Callers of trace() directly normally
   * leave this unset (defaults to "workflow").
   */
  kind?: "workflow" | "agent" | "step";
  /**
   * B2B customer / tenant identifier. Typically set on the outermost
   * trace (e.g. inside a request handler) so nested spans inherit it.
   * Distinct from user_id (end-user). (v0.3)
   */
  customerId?: string | null;
}

export const storage = new AsyncLocalStorage<TraceContext>();

/**
 * Run `fn` within a new trace span.
 *
 * MUST be an async function so that synchronous throws inside `fn` are
 * automatically converted to rejected promises. Using
 * `Promise.resolve(storage.run(ctx, fn))` does NOT have this property.
 *
 * Nested trace() calls INHERIT the outer trace's traceId so the whole
 * workflow groups together. Each nested call gets its own spanId, with
 * parentSpanId set to the enclosing trace's spanId — building a tree.
 * Instrumented LLM calls inside read the active span's id and emit
 * LLMEvent.parent_span_id = ctx.spanId, putting the call under the
 * trace that wraps it.
 *
 * @param name  Human-readable span name (stored as `feature_name` if no
 *              default is set in config)
 * @param fn    Async callback receiving the TraceContext for this span
 * @param opts  Optional per-trace settings (e.g. promptVersion)
 */
export async function trace<T>(
  name: string,
  fn: (ctx: TraceContext) => Promise<T>,
  opts?: TraceOptions,
): Promise<T> {
  const parent = storage.getStore();
  // promptVersion precedence: explicit opts arg → parent's value → null.
  // We use the in-key check so passing `{ promptVersion: null }` is an
  // intentional "clear it" rather than "use parent's".
  const promptVersion: string | null =
    opts && "promptVersion" in opts
      ? (opts.promptVersion ?? null)
      : (parent?.promptVersion ?? null);
  // customerId precedence: explicit opts > parent trace > null. Same
  // inheritance shape as promptVersion above.
  const customerId: string | null =
    opts && "customerId" in opts
      ? (opts.customerId ?? null)
      : (parent?.customerId ?? null);
  const ctx: TraceContext = {
    // INHERIT traceId from the active trace when nested — without this,
    // nested traces split into separate traces on the dashboard and the
    // workflow story is gone. Only the outermost trace() generates a
    // fresh traceId.
    traceId: parent?.traceId ?? globalThis.crypto.randomUUID(),
    spanId: globalThis.crypto.randomUUID(),
    parentSpanId: parent?.spanId ?? null,
    name,
    promptVersion,
    kind: opts?.kind ?? "workflow",
    customerId,
  };
  return storage.run(ctx, () => fn(ctx));
}
