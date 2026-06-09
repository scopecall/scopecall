"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Link2,
  Filter,
  RefreshCw,
  RotateCcw,
  Search as SearchIcon,
  X,
} from "lucide-react";
import { useTraces } from "@/lib/queries/use-traces";
import { useTraceTree } from "@/lib/queries/use-trace-tree";
import { useBreakdown } from "@/lib/queries/use-breakdown";
import { useSessions } from "@/lib/queries/use-sessions";
import { useApiError } from "@/hooks/use-api-error";
import { useOrgId } from "@/lib/org-context";
import { StatusBadge } from "@/components/shared/status-badge";
import { RelativeTime } from "@/components/shared/relative-time";
import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { money, num, NULL_SENTINEL } from "@/lib/format";
import type { components } from "@/lib/api-types";
import { Sankey, type FlowNode, type FlowLink } from "../_components/viz";
import { useFocusTrap } from "../_lib/use-focus-trap";
import { useTimeRange } from "../_lib/use-time-range";

/**
 * v2 Traces — a faithful port of the Traces design prototype (the redesign) wired to real
 * data. The prototype's three signature elements are preserved:
 *
 *  • list / Flow Map / Sessions tablist.
 *  • A left faceted filter rail (collapsible dimensions + per-value counts).
 *  • The list table with a semantic Name column, confidence dot, TTFT-aware
 *    latency, and a focus-trapped drill-down drawer.
 *
 * Real-data adaptations from the mock prototype, kept honest:
 *
 *  • Filters are single-select PER DIMENSION — the /traces endpoint takes one
 *    value per dim, not the prototype's client-side multi-select arrays. The
 *    rail keeps the prototype's look but selecting a second value replaces.
 *  • Facet counts (`calls`) come from /breakdown, which only groups by model /
 *    provider / feature / user / environment. Status is the fixed enum (no
 *    counts). workflow / agent / step have no facet endpoint, so they arrive
 *    only as drill-in chips (from Overview / Spend / workflow detail).
 *  • URL-first: filters live in the query string (SHORT v2 names — status,
 *    model, provider, feature, user, environment, workflow, agent, step, q) via
 *    router.replace, preserving the chrome-owned global scope keys (range/from/
 *    to/gran/env). Drill-ins land directly and any view is shareable.
 *  • Flow Map derives the prototype's workflow→model→outcome Sankey client-side
 *    from recent traffic in the window (cost-weighted). It shows ALL traffic —
 *    the left filters don't apply — matching the prototype.
 *  • Sessions uses /sessions, which returns per-session SUMMARIES (no member
 *    timeline), so it renders summary cards; clicking one drills the list to
 *    that session_id. It honors the User filter only (the endpoint's only dim).
 *  • The drawer fetches the real trace tree (/traces/tree) and renders a
 *    timestamp-derived waterfall + per-span Request/Response/Cost/Metadata. A
 *    retry banner surfaces when any span's attempt_number > 1.
 *
 * Not ported: the prototype's per-row Compare toggle + tray. Compare (mark
 * traces → tray → side-by-side page) was a classic-only feature; it retired
 * with the classic surface. A v2-native compare is a possible follow-up.
 */

type Trace = components["schemas"]["Trace"];
type Session = components["schemas"]["Session"];
type SpanNode = Trace & { children: SpanNode[] };

type StatusFilter = "success" | "error" | "timeout" | "rate_limited";
const STATUS_OPTIONS: StatusFilter[] = ["success", "error", "timeout", "rate_limited"];

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

// Latencies are sub-minute, so fmtMs (ms/s only) is fine for them. Session
// durations and intra-session offsets are computed from REAL data where a
// session_id can span the whole query window (hours → days), so they need a
// scaled formatter — otherwise "+591202.7s" overflows its column. fmtDur steps
// up through ms → s → m → h → d.
function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(0)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// Cost trust signal (cost_source) → dot color + human label, mirroring the
// prototype's verified / estimated / unknown confidence dots.
function confDot(src?: Trace["cost_source"]): string {
  if (src === "server_computed") return "bg-emerald-400";
  if (src === "sdk_fallback") return "bg-amber-400";
  return "bg-muted-foreground/50";
}
function confLabel(src?: Trace["cost_source"]): string {
  switch (src) {
    case "server_computed":
      return "Server-verified";
    case "sdk_fallback":
      return "Estimated (SDK fallback)";
    case "unknown_model":
      return "Unpriced — unknown model";
    case "container":
      return "Container default";
    default:
      return "Cost source unknown";
  }
}
function outcomeTone(status: string): "ok" | "warn" | "bad" {
  if (status === "success") return "ok";
  if (status === "rate_limited") return "warn";
  return "bad"; // error, timeout
}

function isWorkflowSpan(s: Trace): boolean {
  return s.kind === "workflow";
}
// Semantic label: feature_name reads more meaningfully than the raw model;
// workflow container spans carry the trace name in feature_name.
function spanLabel(s: Trace): string {
  const feat = (s.feature_name ?? "") as string;
  if (isWorkflowSpan(s)) return feat !== "" ? feat : "workflow";
  return feat !== "" ? feat : s.model;
}

// ── Retry attribution ──────────────────────────────────────────────────────────
// Humanize the closed retry_reason enum for the drawer banner + ATTEMPTS list.
function retryReasonLabel(r?: Trace["retry_reason"] | null): string {
  switch (r) {
    case "rate_limit":        return "rate limit";
    case "timeout":           return "timeout";
    case "server_error":      return "server error";
    case "transient_network": return "network";
    case "agent_decision":    return "agent decision";
    case "manual":            return "manual";
    default:                  return "retry";
  }
}

// Collapse retry attempts to one row per span_id, keeping the highest
// attempt_number (the final / representative attempt) in the original slot.
// The list + Sessions views render flat rows keyed by span_id, so without this
// an application-retried call shows up twice (and collides on its React key);
// the drawer keeps the full attempt history separately via attemptGroups().
function dedupeAttempts(rows: Trace[]): Trace[] {
  const slot = new Map<string, number>(); // span_id → index in `out`
  const out: Trace[] = [];
  for (const r of rows) {
    const idx = slot.get(r.span_id);
    if (idx === undefined) {
      slot.set(r.span_id, out.length);
      out.push(r);
    } else if ((r.attempt_number ?? 1) > (out[idx].attempt_number ?? 1)) {
      out[idx] = r; // higher attempt wins, keeps the earlier row's position
    }
  }
  return out;
}

// Group spans by span_id into their attempt history, each sorted by
// attempt_number ascending. A single-attempt span yields a 1-element list.
function attemptGroups(spans: Trace[]): Map<string, Trace[]> {
  const m = new Map<string, Trace[]>();
  for (const s of spans) {
    const g = m.get(s.span_id);
    if (g) g.push(s);
    else m.set(s.span_id, [s]);
  }
  for (const g of m.values()) {
    g.sort((a, b) => (a.attempt_number ?? 1) - (b.attempt_number ?? 1));
  }
  return m;
}

// ── Facet rail ────────────────────────────────────────────────────────────────
interface FacetOption {
  value: string;
  label: string;
  count?: number;
}

// Distinct options from a /breakdown response. Empty key → "(none)" only when
// the dimension is nullable (feature / user); otherwise dropped.
function bdOptions(
  data: { rows: components["schemas"]["BreakdownRow"][] } | undefined,
  nullable: boolean,
): FacetOption[] {
  const out: FacetOption[] = [];
  for (const r of data?.rows ?? []) {
    if (r.key === "") {
      if (nullable) out.push({ value: NULL_SENTINEL, label: "(none)", count: r.calls });
      continue;
    }
    out.push({ value: r.key, label: r.key, count: r.calls });
  }
  return out;
}

// Guarantee a drilled-in value shows as selected even when it fell outside the
// window's top-N breakdown (e.g. a model the current window barely used).
function withCurrent(opts: FacetOption[], current: string | undefined): FacetOption[] {
  if (!current || current === NULL_SENTINEL) return opts;
  if (opts.some((o) => o.value === current)) return opts;
  return [{ value: current, label: current }, ...opts];
}

function FacetGroup({
  label,
  options,
  value,
  open,
  onToggleOpen,
  onSelect,
  hint,
}: {
  label: string;
  options: FacetOption[];
  value: string | undefined;
  open: boolean;
  onToggleOpen: () => void;
  onSelect: (v: string | undefined) => void;
  // Optional explainer shown under the options when open — used by the
  // environment facet to make its compose-with-global behavior legible.
  hint?: ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const FACET_CAP = 8;
  // Cap long facet lists so a high-cardinality dimension (e.g. hundreds of
  // users) doesn't make the rail scroll forever. Keep the active selection
  // visible even when it ranks below the cap, so a checked value never
  // silently disappears.
  let shown = showAll ? options : options.slice(0, FACET_CAP);
  if (!showAll && value && !shown.some((o) => o.value === value)) {
    const sel = options.find((o) => o.value === value);
    if (sel) shown = [...shown, sel];
  }
  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        onClick={onToggleOpen}
        className="w-full flex items-center justify-between py-1.5 text-xs capitalize text-muted-foreground hover:text-foreground rounded focus-ring"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5">
          {label}
          {value && (
            <span className="size-1.5 rounded-full bg-[#5B54E8]" aria-label="1 filter active" />
          )}
        </span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="pb-2 space-y-0.5">
          {options.length === 0 ? (
            <p className="px-1.5 py-1 text-[10px] text-muted-foreground/70">No values in window.</p>
          ) : (
            shown.map((o) => {
              const checked = value === o.value;
              return (
                <button
                  key={o.value}
                  onClick={() => onSelect(checked ? undefined : o.value)}
                  aria-pressed={checked}
                  className={cn(
                    "w-full flex items-center gap-2 px-1.5 py-1 rounded text-[11px] text-left row-interactive",
                    checked && "row-active",
                  )}
                >
                  <span
                    className={cn(
                      "size-3.5 rounded-[3px] border flex items-center justify-center shrink-0",
                      checked ? "bg-[#5B54E8] border-[#5B54E8]" : "border-border",
                    )}
                  >
                    {checked && <Check className="h-2.5 w-2.5 text-white" />}
                  </span>
                  <span
                    className={cn("truncate flex-1", checked ? "text-foreground" : "text-muted-foreground")}
                  >
                    {o.label}
                  </span>
                  {o.count != null && (
                    <span className="tabular-nums text-muted-foreground/50">{num(o.count)}</span>
                  )}
                </button>
              );
            })
          )}
          {options.length > FACET_CAP && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="w-full text-left px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground rounded focus-ring"
            >
              {showAll ? "Show fewer" : `Show all ${options.length}`}
            </button>
          )}
          {hint && (
            <p className="px-1.5 pt-1.5 text-[10px] leading-snug text-muted-foreground/80">{hint}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Removable active-filter chip (used for both facet filters and drill-ins).
// `note` adds a muted sub-label (e.g. an env override's "overrides production");
// `accent` tints the chip purple to mark a deliberate scope override vs. a plain
// filter.
function FilterChip({
  dim,
  value,
  onClear,
  note,
  accent,
}: {
  dim: string;
  value: string;
  onClear: () => void;
  note?: string;
  accent?: boolean;
}) {
  const display = value === NULL_SENTINEL ? "(none)" : value;
  return (
    <button
      onClick={onClear}
      className={cn(
        "inline-flex items-center gap-1 rounded-full pl-2 pr-1 py-0.5 border transition-colors max-w-[280px] focus-ring",
        accent
          ? "bg-[#5B54E8]/10 border-[#5B54E8]/30 hover:bg-[#5B54E8]/15"
          : "bg-surface-hover border-border hover:bg-surface-active",
      )}
    >
      <span className="text-muted-foreground capitalize shrink-0">{dim}</span>
      <span className="text-foreground truncate">{display}</span>
      {note && (
        <span className="text-[10px] text-muted-foreground/80 shrink-0 border-l border-border/60 pl-1">
          {note}
        </span>
      )}
      <X className="h-3 w-3 text-muted-foreground shrink-0" />
    </button>
  );
}

type View = "list" | "flow" | "sessions";

function TracesView() {
  const router = useRouter();
  const sp = useSearchParams();
  const orgId = useOrgId();
  const { from, to, env, label } = useTimeRange();

  const enabled = !!orgId;
  const oid = orgId ?? "";

  const [view, setView] = useState<View>("list");

  // ── Filter state — lazy-init from URL (SHORT v2 names), single-select ─────
  const [status, setStatus] = useState<string | undefined>(() => sp.get("status") ?? undefined);
  const [model, setModel] = useState<string | undefined>(() => sp.get("model") ?? undefined);
  const [provider, setProvider] = useState<string | undefined>(() => sp.get("provider") ?? undefined);
  const [feature, setFeature] = useState<string | undefined>(() => sp.get("feature") ?? undefined);
  const [user, setUser] = useState<string | undefined>(() => sp.get("user") ?? undefined);
  // B2B tenant (customer_id) — distinct from `user` (the end-user). Drilled into
  // from /dashboard/customers and the workflow-detail by-customer panel.
  const [customer, setCustomer] = useState<string | undefined>(() => sp.get("customer") ?? undefined);
  // Explicit environment drill (from Spend) overrides the ambient global env.
  const [environment, setEnvironment] = useState<string | undefined>(
    () => sp.get("environment") ?? undefined,
  );
  // Cost-hierarchy drill-ins (chip-only — no facet endpoint behind them).
  const [workflow, setWorkflow] = useState<string | undefined>(() => sp.get("workflow") ?? undefined);
  const [agent, setAgent] = useState<string | undefined>(() => sp.get("agent") ?? undefined);
  const [step, setStep] = useState<string | undefined>(() => sp.get("step") ?? undefined);
  // prompt_version drill (chip-only — no facet endpoint behind it). The Spend →
  // Prompts tab links every version row here; "__null__" targets the untagged
  // bucket. Backend + useTraces already plumb prompt_version; this surfaces it.
  const [promptVersion, setPromptVersion] = useState<string | undefined>(
    () => sp.get("prompt_version") ?? undefined,
  );

  // Free-text search (trace_id / span_id / session_id / user_id / text).
  const [searchInput, setSearchInput] = useState<string>(() => sp.get("q") ?? "");
  const [q, setQ] = useState<string | undefined>(() => sp.get("q") ?? undefined);
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim() === "" ? undefined : searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  const searchRef = useRef<HTMLInputElement>(null);

  // Pagination + drawer.
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  // `?trace=<id>` deep-links straight into the drawer — the Alerts page links
  // offending traces here, and the open drawer stays shareable on reload.
  const [openTraceId, setOpenTraceId] = useState<string | null>(() => sp.get("trace"));
  // True when the drawer was reached via a ?trace= deep-link (an Alerts
  // "offending trace" link, or a shared/reloaded URL). Such a trace can sit
  // anywhere in retention — possibly outside the current time window — so we
  // pass NO window to the tree query and let the backend self-probe the trace's
  // real timestamp (see query.TraceTree's zero-window probe path). In-page opens
  // from the list/sessions are guaranteed in-window, so they keep the tight
  // window hint; the first such click clears this flag.
  const [deepLinkOpen, setDeepLinkOpen] = useState<boolean>(() => !!sp.get("trace"));
  const openTraceFromPage = useCallback((id: string) => {
    setDeepLinkOpen(false);
    setOpenTraceId(id);
  }, []);
  const drawerRef = useRef<HTMLElement>(null);

  // Collapsible facet sections — open the ones that arrive with an active drill.
  const [openDims, setOpenDims] = useState<Set<string>>(() => {
    const s = new Set<string>(["status", "model"]);
    if (sp.get("model")) s.add("model");
    if (sp.get("provider")) s.add("provider");
    if (sp.get("feature")) s.add("feature");
    if (sp.get("user")) s.add("user");
    if (sp.get("customer")) s.add("customer");
    if (sp.get("environment")) s.add("environment");
    return s;
  });
  const toggleDim = (dim: string) =>
    setOpenDims((prev) => {
      const next = new Set(prev);
      if (next.has(dim)) next.delete(dim);
      else next.add(dim);
      return next;
    });

  // Effective environment: an explicit drill wins, else the ambient global env.
  const effectiveEnv = environment ?? env;

  // ── Facet options from /breakdown for this window ─────────────────────────
  const bd = { orgId: oid, from, to, limit: 50 } as const;
  const modelBd = useBreakdown({ ...bd, groupBy: "model" }, enabled);
  const providerBd = useBreakdown({ ...bd, groupBy: "provider" }, enabled);
  const featureBd = useBreakdown({ ...bd, groupBy: "feature" }, enabled);
  const userBd = useBreakdown({ ...bd, groupBy: "user" }, enabled);
  const customerBd = useBreakdown({ ...bd, groupBy: "customer" }, enabled);
  const envBd = useBreakdown({ ...bd, groupBy: "environment" }, enabled);

  // ── List query ────────────────────────────────────────────────────────────
  // Validate the URL-supplied status against the enum before it reaches the API.
  const statusParam = (STATUS_OPTIONS as string[]).includes(status ?? "")
    ? (status as StatusFilter)
    : undefined;
  const query = useTraces(
    {
      orgId: oid,
      from,
      to,
      cursor,
      status: statusParam,
      model,
      featureName: feature,
      provider,
      userId: user,
      customerId: customer,
      environment: effectiveEnv,
      workflow,
      agent,
      step,
      promptVersion,
      q,
    },
    enabled && view === "list",
  );
  const { data, isPending, isError } = query;
  useApiError(query.error, query.refetch);
  // Collapse application-retry pairs (same span_id, two timestamps) to the final
  // attempt so a retried call renders as one row, not two colliding on its key.
  const traces = useMemo(() => dedupeAttempts(data?.traces ?? []), [data]);

  // ── URL sync — preserve global scope, write only this page's filter keys ──
  useEffect(() => {
    const next = new URLSearchParams(sp.toString());
    const setOrDel = (k: string, v: string | undefined) => {
      if (v) next.set(k, v);
      else next.delete(k);
    };
    setOrDel("status", status);
    setOrDel("model", model);
    setOrDel("provider", provider);
    setOrDel("feature", feature);
    setOrDel("user", user);
    setOrDel("customer", customer);
    setOrDel("environment", environment);
    setOrDel("workflow", workflow);
    setOrDel("agent", agent);
    setOrDel("step", step);
    setOrDel("prompt_version", promptVersion);
    setOrDel("q", q);
    // Deep-link the open trace so an Alerts "view offending trace" link survives
    // reload and is shareable; closing the drawer clears it.
    setOrDel("trace", openTraceId ?? undefined);
    const nextStr = next.toString();
    if (nextStr !== sp.toString()) {
      router.replace(nextStr ? `/dashboard/traces?${nextStr}` : "/dashboard/traces", {
        scroll: false,
      });
    }
  }, [status, model, provider, feature, user, customer, environment, workflow, agent, step, promptVersion, q, openTraceId, sp, router]);

  // Reset pagination whenever the result set changes.
  useEffect(() => {
    setCursorStack([]);
    setCursor(undefined);
  }, [status, model, provider, feature, user, customer, effectiveEnv, workflow, agent, step, promptVersion, q, from, to]);

  // "/" focuses search unless already typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drawer: focus, Escape-to-close, body scroll lock.
  useEffect(() => {
    if (!openTraceId) return;
    drawerRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenTraceId(null);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [openTraceId]);
  useFocusTrap(!!openTraceId, drawerRef);

  const facetSetters: Record<string, (v: string | undefined) => void> = {
    status: setStatus,
    model: setModel,
    provider: setProvider,
    feature: setFeature,
    user: setUser,
    customer: setCustomer,
    environment: setEnvironment,
  };

  // Active chips — every set filter, in a stable order.
  const chips: {
    dim: string;
    value: string;
    clear: () => void;
    note?: string;
    accent?: boolean;
  }[] = [];
  const pushChip = (dim: string, value: string | undefined, clear: () => void) => {
    if (value) chips.push({ dim, value, clear });
  };
  pushChip("status", status, () => setStatus(undefined));
  pushChip("model", model, () => setModel(undefined));
  pushChip("provider", provider, () => setProvider(undefined));
  pushChip("feature", feature, () => setFeature(undefined));
  pushChip("user", user, () => setUser(undefined));
  pushChip("customer", customer, () => setCustomer(undefined));
  // Environment composes with the chrome's global env (effectiveEnv =
  // environment ?? env). When a local pick overrides a DIFFERENT global env,
  // say so on the chip and tint it — so the page never silently contradicts the
  // global scope pill. Clearing the chip falls back to the global scope.
  if (environment) {
    const overridesGlobal = !!env && env !== environment;
    chips.push({
      dim: "environment",
      value: environment,
      clear: () => setEnvironment(undefined),
      note: overridesGlobal ? `overrides ${env}` : env ? "= global" : undefined,
      accent: overridesGlobal,
    });
  }
  pushChip("workflow", workflow, () => setWorkflow(undefined));
  pushChip("agent", agent, () => setAgent(undefined));
  pushChip("step", step, () => setStep(undefined));
  pushChip("prompt", promptVersion, () => setPromptVersion(undefined));
  if (q) chips.push({ dim: "search", value: q, clear: () => { setQ(undefined); setSearchInput(""); } });

  const anyFilter = chips.length > 0;

  // On the Sessions tab every facet now reaches /sessions ("match → whole
  // session" semantics) except the cost-hierarchy drills (workflow/agent/step)
  // and customer — which /sessions can't honor — hide only those so no chip
  // reads as ignored.
  const visibleChips =
    view === "sessions"
      ? chips.filter(
          (c) =>
            c.dim !== "workflow" &&
            c.dim !== "agent" &&
            c.dim !== "step" &&
            c.dim !== "customer" &&
            c.dim !== "prompt",
        )
      : chips;
  function clearAll() {
    setStatus(undefined);
    setModel(undefined);
    setProvider(undefined);
    setFeature(undefined);
    setUser(undefined);
    setCustomer(undefined);
    setEnvironment(undefined);
    setWorkflow(undefined);
    setAgent(undefined);
    setStep(undefined);
    setPromptVersion(undefined);
    setQ(undefined);
    setSearchInput("");
  }

  function onNext() {
    if (!data?.next_cursor) return;
    setCursorStack((s) => [...s, cursor ?? ""]);
    setCursor(data.next_cursor ?? undefined);
  }
  function onPrev() {
    const prev = [...cursorStack];
    const last = prev.pop();
    setCursorStack(prev);
    setCursor(last ?? undefined);
  }

  return (
    <div className="space-y-4">
      {/* ── Header + tablist ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold">Traces</h1>
          <p className="text-[11px] text-muted-foreground">
            The raw truth · {label} · Flow Map and Sessions are views of the same data
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Trace view"
          className="inline-flex items-center border border-border rounded-md p-0.5"
        >
          {(["list", "flow", "sessions"] as View[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                "px-3 py-1 text-xs rounded transition-colors capitalize focus-ring",
                view === v
                  ? "bg-surface-active text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
              )}
            >
              {v === "flow" ? "Flow Map" : v}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-4">
        {/* ── Filter rail ── */}
        <aside className="hidden lg:block w-52 shrink-0">
          <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-3 sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto">
            <div className="relative mb-2">
              <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                placeholder="Search… ( / )"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") (e.target as HTMLInputElement).blur();
                }}
                className="w-full rounded-md border border-input bg-background pl-7 pr-2 text-[11px] h-7 focus:outline-none focus:border-ring"
              />
            </div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Filter className="h-3 w-3" /> Filters
              </p>
              {anyFilter && (
                <button
                  onClick={clearAll}
                  className="text-[10px] text-muted-foreground hover:text-foreground rounded focus-ring px-1 -mx-1"
                >
                  Clear
                </button>
              )}
            </div>
            <FacetGroup
              label="status"
              options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
              value={status}
              open={openDims.has("status")}
              onToggleOpen={() => toggleDim("status")}
              onSelect={setStatus}
            />
            <FacetGroup
              label="model"
              options={withCurrent(bdOptions(modelBd.data, false), model)}
              value={model}
              open={openDims.has("model")}
              onToggleOpen={() => toggleDim("model")}
              onSelect={setModel}
            />
            <FacetGroup
              label="provider"
              options={withCurrent(bdOptions(providerBd.data, false), provider)}
              value={provider}
              open={openDims.has("provider")}
              onToggleOpen={() => toggleDim("provider")}
              onSelect={setProvider}
            />
            <FacetGroup
              label="feature"
              options={withCurrent(bdOptions(featureBd.data, true), feature)}
              value={feature}
              open={openDims.has("feature")}
              onToggleOpen={() => toggleDim("feature")}
              onSelect={setFeature}
            />
            <FacetGroup
              label="user"
              options={withCurrent(bdOptions(userBd.data, true), user)}
              value={user}
              open={openDims.has("user")}
              onToggleOpen={() => toggleDim("user")}
              onSelect={setUser}
            />
            <FacetGroup
              label="customer"
              options={withCurrent(bdOptions(customerBd.data, true), customer)}
              value={customer}
              open={openDims.has("customer")}
              onToggleOpen={() => toggleDim("customer")}
              onSelect={setCustomer}
            />
            <FacetGroup
              label="environment"
              options={withCurrent(bdOptions(envBd.data, false), environment)}
              value={environment}
              open={openDims.has("environment")}
              onToggleOpen={() => toggleDim("environment")}
              onSelect={setEnvironment}
              hint={
                env ? (
                  environment && environment !== env ? (
                    <>
                      Overriding the global{" "}
                      <span className="font-medium text-foreground">{env}</span> scope — this page
                      only.
                    </>
                  ) : environment === env ? (
                    <>Same as the global scope.</>
                  ) : (
                    <>
                      Global scope is{" "}
                      <span className="font-medium text-foreground">{env}</span>. Pick one to narrow
                      just this page.
                    </>
                  )
                ) : undefined
              }
            />
          </div>
        </aside>

        {/* ── Content ── */}
        <div className="flex-1 min-w-0">
          {view !== "flow" && visibleChips.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap mb-3 text-[11px]">
              {visibleChips.map((c) => (
                <FilterChip
                  key={c.dim + c.value}
                  dim={c.dim}
                  value={c.value}
                  onClear={c.clear}
                  note={c.note}
                  accent={c.accent}
                />
              ))}
            </div>
          )}

          {view === "list" ? (
            <ListView
              traces={traces}
              isPending={isPending}
              isError={isError}
              anyFilter={anyFilter}
              onRetry={() => query.refetch()}
              onClear={clearAll}
              onOpen={openTraceFromPage}
              hasNext={!!data?.next_cursor}
              hasPrev={cursorStack.length > 0}
              onNext={onNext}
              onPrev={onPrev}
              onSetFacet={(dim, value) => facetSetters[dim]?.(value)}
            />
          ) : view === "flow" ? (
            <FlowView orgId={oid} from={from} to={to} enabled={enabled} hasFilters={anyFilter} />
          ) : (
            <SessionsView
              orgId={oid}
              from={from}
              to={to}
              enabled={enabled}
              userId={user && user !== NULL_SENTINEL ? user : undefined}
              model={model}
              provider={provider}
              status={statusParam}
              feature={feature}
              environment={effectiveEnv}
              search={q}
              hierarchyDrill={chips.some(
                (c) => c.dim === "workflow" || c.dim === "agent" || c.dim === "step",
              )}
              onOpenTrace={openTraceFromPage}
            />
          )}
        </div>
      </div>

      {/* ── Detail drawer ── */}
      <div
        className={cn("fixed inset-0 z-50", !openTraceId && "pointer-events-none")}
        aria-hidden={!openTraceId}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/50 transition-opacity duration-200",
            openTraceId ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setOpenTraceId(null)}
        />
        <aside
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Trace details"
          tabIndex={-1}
          className={cn(
            "absolute right-0 top-0 h-full w-full sm:max-w-[760px] bg-background border-l border-border shadow-2xl overflow-y-auto transition-transform duration-200 ease-out outline-none",
            openTraceId ? "translate-x-0" : "translate-x-full",
          )}
        >
          {openTraceId && (
            <TraceDrawerContent
              traceId={openTraceId}
              orgId={oid}
              enabled={enabled}
              // Deep-linked traces self-probe (no window); in-page opens keep
              // the tight window hint.
              from={deepLinkOpen ? undefined : from}
              to={deepLinkOpen ? undefined : to}
              onClose={() => setOpenTraceId(null)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ── List view ──────────────────────────────────────────────────────────────
function ListView({
  traces,
  isPending,
  isError,
  anyFilter,
  onRetry,
  onClear,
  onOpen,
  hasNext,
  hasPrev,
  onNext,
  onPrev,
  onSetFacet,
}: {
  traces: Trace[];
  isPending: boolean;
  isError: boolean;
  anyFilter: boolean;
  onRetry: () => void;
  onClear: () => void;
  onOpen: (id: string) => void;
  hasNext: boolean;
  hasPrev: boolean;
  onNext: () => void;
  onPrev: () => void;
  onSetFacet: (dim: string, value: string) => void;
}) {
  if (!isPending && !isError && traces.length === 0) {
    return <EmptyState anyFilter={anyFilter} onClear={onClear} />;
  }
  return (
    <>
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="text-left font-medium px-3 py-2">Time</th>
              <th className="text-left font-medium px-3 py-2">Name</th>
              <th className="text-left font-medium px-3 py-2 hidden sm:table-cell">Model</th>
              <th className="text-right font-medium px-3 py-2 hidden md:table-cell">Latency</th>
              <th className="text-right font-medium px-3 py-2 hidden md:table-cell">Cost</th>
              <th className="text-right font-medium px-3 py-2">Status</th>
              <th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {isPending ? (
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} className="border-b border-border/60 last:border-0">
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} className="px-3 py-2.5">
                      <div className="h-4 w-full rounded bg-muted/30 animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : isError ? (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center">
                  <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-2" />
                  <p className="text-sm text-foreground">Couldn&apos;t load traces.</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    The API may be unreachable, or this org has no data for the window.
                  </p>
                  <Button variant="outline" size="sm" onClick={onRetry} className="mt-3">
                    <RefreshCw className="h-3.5 w-3.5" /> Retry
                  </Button>
                </td>
              </tr>
            ) : (
              traces.map((t) => (
                <TraceRowView key={t.span_id} row={t} onOpen={() => onOpen(t.trace_id)} onSetFacet={onSetFacet} />
              ))
            )}
          </tbody>
        </table>
      </section>

      <div className="flex items-center justify-end gap-2 mt-3">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={!hasPrev}>
          <ChevronLeft className="h-4 w-4" />
          Prev
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!hasNext}>
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </>
  );
}

function TraceRowView({
  row,
  onOpen,
  onSetFacet,
}: {
  row: Trace;
  onOpen: () => void;
  onSetFacet: (dim: string, value: string) => void;
}) {
  const workflow = isWorkflowSpan(row);
  const unpriced = row.cost_source === "unknown_model";
  const feat = (row.feature_name ?? "") as string;

  // Breadcrumb path — workflow › agent › step › model. The container names are
  // resolved server-side (the API walks each call's parent_span_id chain up
  // through the persisted workflow/agent/step spans), so this is the call's
  // real ancestry, not a guess. We drop a leaf feature_name that merely repeats
  // an ancestor (a flat workflow trace sets the workflow name == feature_name,
  // and "billing-agent › billing-agent" is just noise); empty levels collapse,
  // so a standalone call still reads "feature_name › model".
  const ancestors = [row.workflow ?? "", row.agent ?? "", row.step ?? ""].filter(
    (s): s is string => !!s,
  );
  const leaf = feat && !ancestors.includes(feat) ? feat : "";
  const pathSegments = [...ancestors, leaf].filter(Boolean);
  const pathText = pathSegments.length ? `${pathSegments.join(" › ")} · ${row.model}` : row.model;

  // Secondary line under the name — the prototype's retry/error sub-row, but
  // sourced from REAL fields: a caller retry (attempt_number > 1, with its
  // retry_reason) or, failing that, the error_message on a non-success span.
  // Surfacing it in the row means an operator spots *why* a call struggled
  // without opening the drawer. Renders nothing when there's no such signal.
  const attempt = row.attempt_number ?? 1;
  let secondary: { icon: ReactNode; text: string; tone: string } | null = null;
  if (attempt > 1) {
    secondary = {
      icon: <RotateCcw className="h-3 w-3 shrink-0" />,
      text: `attempt ${attempt}${row.retry_reason ? ` · ${row.retry_reason}` : ""}`,
      tone: "text-amber-600 dark:text-amber-400",
    };
  } else if (row.status !== "success" && row.error_message) {
    secondary = {
      icon: <AlertTriangle className="h-3 w-3 shrink-0" />,
      text: row.error_message,
      tone: "text-red-600 dark:text-red-400",
    };
  }
  return (
    <tr
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Open trace ${workflow ? spanLabel(row) : pathText}`}
      className="group border-b border-border/60 last:border-0 hover:bg-surface-hover transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>td]:align-top"
    >
      <td className="px-3 py-2 tabular-nums text-muted-foreground whitespace-nowrap">
        <RelativeTime date={row.timestamp} />
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          {/* Path breadcrumb. Workflow container rows show their name (+ wf
              tag). LLM calls render their real ancestry — workflow › agent ›
              step › model — resolved server-side from the parent_span_id chain.
              Absent levels collapse, so a standalone call still reads
              feature_name › model. The path truncates as a unit; the model is a
              shrink-0 mono tail so it stays visible (and matches its own column). */}
          <span className="flex items-center gap-1.5 min-w-0">
            {workflow ? (
              <>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/50 rounded px-1 shrink-0">
                  wf
                </span>
                <span className="truncate text-foreground">{feat || "workflow"}</span>
              </>
            ) : pathSegments.length > 0 ? (
              <>
                <span className="truncate min-w-0">
                  {pathSegments.map((seg, i) => (
                    <span key={`${seg}-${i}`}>
                      {i > 0 && (
                        <span className="text-muted-foreground/40 px-1" aria-hidden>
                          ›
                        </span>
                      )}
                      <span className={i === pathSegments.length - 1 ? "text-foreground" : "text-muted-foreground"}>
                        {seg}
                      </span>
                    </span>
                  ))}
                </span>
                <span className="text-muted-foreground/40 shrink-0" aria-hidden>
                  ›
                </span>
                <span className="font-mono text-[11px] text-muted-foreground shrink-0">{row.model}</span>
              </>
            ) : (
              <span className="truncate text-foreground">{row.model}</span>
            )}
          </span>
          {secondary && (
            <span className={cn("inline-flex items-center gap-1 text-[10px] leading-tight", secondary.tone)}>
              {secondary.icon}
              <span className="truncate">{secondary.text}</span>
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 hidden sm:table-cell">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSetFacet("model", row.model);
          }}
          className="font-mono text-muted-foreground hover:text-foreground hover:underline underline-offset-2 rounded-sm focus-ring"
          title="Filter by this model"
        >
          {row.model}
        </button>
      </td>
      <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">
        {row.ttft_ms != null ? <span className="text-muted-foreground">{row.ttft_ms}ms · </span> : null}
        {fmtMs(row.latency_ms)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums hidden md:table-cell">
        {unpriced ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 justify-end">
            <span className={cn("size-1.5 rounded-full", confDot(row.cost_source))} title={confLabel(row.cost_source)} />
            {money(row.cost_usd)}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <StatusBadge status={row.status} />
      </td>
      {/* The row sets [&>td]:align-top so data columns hug the first line of a
          two-line Name cell. This affordance icon must stay vertically centered
          with the Status pill, so it overrides that with align-middle! (the
          row's `.tr > td` rule out-specifies a plain align-middle). text-center
          seats the glyph in its narrow column. */}
      <td className="px-1 text-center align-middle! text-muted-foreground/40 group-hover:text-foreground transition-colors">
        <ChevronRight className="h-3.5 w-3.5 inline" />
      </td>
    </tr>
  );
}

function EmptyState({ anyFilter, onClear }: { anyFilter: boolean; onClear: () => void }) {
  return (
    <section className="rounded-xl ring-1 ring-foreground/10 bg-card p-10 flex flex-col items-center justify-center text-center">
      <div className="size-9 rounded-full bg-muted/40 flex items-center justify-center mb-3">
        <Filter className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{anyFilter ? "No traces match these filters" : "No traces yet"}</p>
      <p className="text-[11px] text-muted-foreground mt-1 mb-4">
        {anyFilter
          ? "Try removing a filter or widening the window."
          : "Traces appear here as your SDK streams calls."}
      </p>
      {anyFilter && (
        <button
          onClick={onClear}
          className="text-[11px] px-3 py-1.5 rounded-md bg-[#5B54E8] text-white hover:bg-[#6b64f0] transition-colors focus-ring"
        >
          Clear all filters
        </button>
      )}
    </section>
  );
}

// ── Flow Map view (cost-flow Sankey, derived from recent traffic) ────────────
function FlowView({
  orgId,
  from,
  to,
  enabled,
  hasFilters,
}: {
  orgId: string;
  from: Date;
  to: Date;
  enabled: boolean;
  hasFilters: boolean;
}) {
  // Unfiltered, larger sample — the Flow Map charts ALL traffic in the window.
  const q = useTraces({ orgId, from, to, limit: 200 }, enabled);
  const rows = useMemo(() => q.data?.traces ?? [], [q.data]);

  const { nodes, links, total, sampled } = useMemo(() => buildFlow(rows), [rows]);

  return (
    <section className="rounded-xl ring-1 ring-foreground/10 bg-card p-4 space-y-3">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-medium">Cost flow</h2>
          <p className="text-[11px] text-muted-foreground">
            Where spend goes — workflow → model → outcome. Ribbon width = dollars.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm bg-emerald-400" />ok
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm bg-amber-500" />rate limited
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm bg-red-400" />error
          </span>
        </div>
      </div>
      {hasFilters && (
        <p className="flex items-center gap-1.5 text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/25 rounded-md px-2 py-1.5">
          <Filter className="h-3 w-3 shrink-0" />
          Flow Map shows all traffic — the filters at left don&apos;t apply to this view.
        </p>
      )}
      {q.isPending ? (
        <div className="h-[360px] rounded-lg bg-muted/20 animate-pulse" />
      ) : q.isError ? (
        <div className="py-12 text-center">
          <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-2" />
          <p className="text-sm">Couldn&apos;t load flow data.</p>
          <Button variant="outline" size="sm" onClick={() => q.refetch()} className="mt-3">
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </Button>
        </div>
      ) : nodes.length === 0 ? (
        <div className="py-12 text-center text-[11px] text-muted-foreground">
          No priced traffic to chart in this window.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span className="text-left">Workflow</span>
            <span className="text-center">Model</span>
            <span className="text-right">Outcome</span>
          </div>
          <Sankey nodes={nodes} links={links} />
          <p className="text-[11px] text-muted-foreground">
            {money(total)} across {num(sampled)} recent traces in this window.
          </p>
        </>
      )}
    </section>
  );
}

// Derive a workflow→model→outcome cost flow from raw trace rows. Aggregation
// uses nested maps (wf → model → cost, model → outcome → cost) so labels that
// themselves contain spaces or punctuation can never collide on a delimiter.
function buildFlow(rows: Trace[]): {
  nodes: FlowNode[];
  links: FlowLink[];
  total: number;
  sampled: number;
} {
  const wfModel = new Map<string, Map<string, number>>();
  const modelOut = new Map<string, Map<string, number>>();
  const wfCost = new Map<string, number>();
  const modelCost = new Map<string, number>();
  const outCost = new Map<string, number>();
  let total = 0;
  let sampled = 0;

  const bump = (m: Map<string, Map<string, number>>, a: string, b: string, v: number) => {
    let inner = m.get(a);
    if (!inner) m.set(a, (inner = new Map<string, number>()));
    inner.set(b, (inner.get(b) ?? 0) + v);
  };

  for (const r of rows) {
    const cost = r.cost_usd;
    if (!cost || cost <= 0 || isWorkflowSpan(r)) continue;
    const wf = r.feature_name && r.feature_name !== "" ? r.feature_name : "(unattributed)";
    const md = r.model || "(unknown)";
    const oc = r.status;
    total += cost;
    sampled += 1;
    bump(wfModel, wf, md, cost);
    bump(modelOut, md, oc, cost);
    wfCost.set(wf, (wfCost.get(wf) ?? 0) + cost);
    modelCost.set(md, (modelCost.get(md) ?? 0) + cost);
    outCost.set(oc, (outCost.get(oc) ?? 0) + cost);
  }

  if (sampled === 0) return { nodes: [], links: [], total: 0, sampled: 0 };

  // Keep the chart readable: top workflows / models by cost.
  const topWf = new Set([...wfCost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k));
  const topMd = new Set([...modelCost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k));

  const nodes: FlowNode[] = [];
  [...wfCost.entries()]
    .filter(([k]) => topWf.has(k))
    .sort((a, b) => b[1] - a[1])
    .forEach(([k]) => nodes.push({ id: `wf:${k}`, label: k, col: 0, kind: "workflow" }));
  [...modelCost.entries()]
    .filter(([k]) => topMd.has(k))
    .sort((a, b) => b[1] - a[1])
    .forEach(([k]) => nodes.push({ id: `md:${k}`, label: k, col: 1, kind: "model" }));
  [...outCost.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k]) =>
      nodes.push({
        id: `oc:${k}`,
        label: k === "rate_limited" ? "rate limited" : k,
        col: 2,
        kind: "outcome",
        tone: outcomeTone(k),
      }),
    );

  const links: FlowLink[] = [];
  for (const [wf, inner] of wfModel) {
    if (!topWf.has(wf)) continue;
    for (const [md, value] of inner) {
      if (!topMd.has(md)) continue;
      links.push({ source: `wf:${wf}`, target: `md:${md}`, value });
    }
  }
  for (const [md, inner] of modelOut) {
    if (!topMd.has(md)) continue;
    for (const [oc, value] of inner) {
      links.push({ source: `md:${md}`, target: `oc:${oc}`, value });
    }
  }

  return { nodes, links, total, sampled };
}

// ── Sessions view (rich cards: timeline strip + member calls) ────────────────
// The list of sessions comes from /sessions (authoritative summaries). Each
// card lazily fetches its own member calls — /traces exact-matches session_id
// via the `q` param — only once expanded, so the long tail of sessions never
// fans out into N+1 requests on mount. The first few auto-expand so the page
// lands as rich as the prototype.
const AUTO_EXPAND = 3;

function SessionsView({
  orgId,
  from,
  to,
  enabled,
  userId,
  model,
  provider,
  status,
  feature,
  environment,
  search,
  hierarchyDrill,
  onOpenTrace,
}: {
  orgId: string;
  from: Date;
  to: Date;
  enabled: boolean;
  userId?: string;
  model?: string;
  provider?: string;
  status?: "success" | "error" | "timeout" | "rate_limited";
  feature?: string;
  environment?: string;
  search?: string;
  hierarchyDrill: boolean;
  onOpenTrace: (traceId: string) => void;
}) {
  const q = useSessions(
    { orgId, from, to, userId, model, provider, status, featureName: feature, environment, limit: 50 },
    enabled,
  );
  // The /sessions endpoint can't search, so the free-text box filters the
  // fetched list (≤50) by session_id / user_id — the only ids it carries.
  const sessions = useMemo(() => {
    const all = q.data?.sessions ?? [];
    if (!search) return all;
    const needle = search.toLowerCase();
    return all.filter(
      (s) =>
        s.session_id.toLowerCase().includes(needle) ||
        (s.user_id ?? "").toLowerCase().includes(needle),
    );
  }, [q.data, search]);

  // Sessions render as full cards and this endpoint has no cursor pagination,
  // so reveal them in pages — a busy window shouldn't mount 50 tall cards at
  // once. The fetch is already capped at 50 server-side.
  const SESSIONS_PAGE = 20;
  const [visibleCount, setVisibleCount] = useState(SESSIONS_PAGE);

  if (q.isPending) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 rounded-xl bg-muted/20 animate-pulse" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-12 text-center">
        <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-2" />
        <p className="text-sm">Couldn&apos;t load sessions.</p>
        <Button variant="outline" size="sm" onClick={() => q.refetch()} className="mt-3">
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-10 text-center">
        <p className="text-sm font-medium">
          {search ? "No sessions match your search" : "No sessions in this window"}
        </p>
        <p className="text-[11px] text-muted-foreground mt-1">
          {search
            ? "Search matches session_id and user_id."
            : "Sessions group calls that share a session_id."}
        </p>
      </div>
    );
  }
  const visibleSessions = sessions.slice(0, visibleCount);
  const hiddenSessions = sessions.length - visibleSessions.length;
  return (
    <div className="space-y-3">
      {hierarchyDrill && (
        <p className="text-[11px] text-muted-foreground">
          Workflow, agent &amp; step drill-ins apply to List &amp; Flow Map — they don&apos;t scope
          Sessions.
        </p>
      )}
      {visibleSessions.map((s, i) => (
        <SessionCard
          key={s.session_id}
          session={s}
          orgId={orgId}
          from={from}
          to={to}
          enabled={enabled}
          defaultExpanded={i < AUTO_EXPAND}
          onOpenTrace={onOpenTrace}
        />
      ))}
      {hiddenSessions > 0 && (
        <button
          onClick={() => setVisibleCount((n) => n + SESSIONS_PAGE)}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-2 rounded-lg ring-1 ring-foreground/10 bg-card/40 hover:bg-card transition-colors focus-ring"
        >
          Show {Math.min(hiddenSessions, SESSIONS_PAGE)} more · {sessions.length} sessions in window
        </button>
      )}
      {hiddenSessions === 0 && visibleCount > SESSIONS_PAGE && (
        <button
          onClick={() => setVisibleCount(SESSIONS_PAGE)}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-2 rounded-lg ring-1 ring-foreground/10 bg-card/40 hover:bg-card transition-colors focus-ring"
        >
          Show fewer
        </button>
      )}
    </div>
  );
}

// Timeline-bar tint for a member call's outcome (mirrors the prototype).
function memberBarColor(status: string): string {
  if (status === "success") return "bg-emerald-500/70";
  if (status === "rate_limited") return "bg-amber-500/70";
  return "bg-red-500/70"; // error, timeout
}

// A short, honest breadcrumb for one member call — feature › model. (The
// prototype's mock carried a full workflow › step › model path; real rows
// expose feature_name + model, which is the truthful two-level analog.)
function memberPath(t: Trace): string[] {
  const parts: string[] = [];
  const feat = (t.feature_name ?? "") as string;
  if (feat) parts.push(feat);
  if (t.model && !isWorkflowSpan(t)) parts.push(t.model);
  if (parts.length === 0) parts.push(t.model || "call");
  return parts;
}

// Derive a human title from the session's calls: the workflow container span's
// name, else the most common feature, else the raw id (caller hides it then).
function deriveSessionTitle(members: Trace[], fallback: string): string {
  const wf = members.find((m) => isWorkflowSpan(m) && m.feature_name);
  if (wf?.feature_name) return wf.feature_name;
  const freq = new Map<string, number>();
  for (const m of members) {
    const f = (m.feature_name ?? "") as string;
    if (f) freq.set(f, (freq.get(f) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [f, n] of freq) {
    if (n > bestN) {
      best = f;
      bestN = n;
    }
  }
  return best ?? fallback;
}

function SessionCard({
  session,
  orgId,
  from,
  to,
  enabled,
  defaultExpanded,
  onOpenTrace,
}: {
  session: Session;
  orgId: string;
  from: Date;
  to: Date;
  enabled: boolean;
  defaultExpanded: boolean;
  onOpenTrace: (traceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Member calls — fetched only while expanded. `q` exact-matches session_id on
  // /traces; we re-filter client-side so a stray match can never leak in.
  const memberQ = useTraces(
    { orgId, from, to, q: session.session_id, limit: 50 },
    enabled && expanded,
  );
  const members = useMemo(() => {
    const rows = (memberQ.data?.traces ?? []).filter((r) => r.session_id === session.session_id);
    // One row per call: collapse retry pairs to the final attempt, then order
    // chronologically. (Without this, both attempts collide on key={span_id}.)
    return dedupeAttempts(rows).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }, [memberQ.data, session.session_id]);
  // Only LLM calls populate the timeline + rows; container spans inform the title.
  const calls = useMemo(() => members.filter((m) => (m.kind ?? "llm") === "llm"), [members]);
  const capped = (memberQ.data?.traces?.length ?? 0) >= 50;

  const title = useMemo(() => deriveSessionTitle(members, session.session_id), [members, session.session_id]);

  // t0 = the first call's start; member-row offsets are measured from it. The
  // strip below is a sequence view (not a wall-clock axis), so it needs no span.
  const t0 = calls.length ? Math.min(...calls.map((c) => Date.parse(c.timestamp))) : 0;
  const retries = members.reduce((n, m) => n + ((m.attempt_number ?? 1) > 1 ? 1 : 0), 0);

  return (
    <section className="rounded-xl ring-1 ring-foreground/10 bg-card overflow-hidden">
      {/* Header — toggles expand/collapse */}
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left row-interactive"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm">
            {expanded && title !== session.session_id && (
              <span className="font-medium truncate max-w-[220px]">{title}</span>
            )}
            <span className="font-mono text-[11px] text-muted-foreground truncate max-w-[220px]">
              {session.session_id}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{session.user_id ? session.user_id : "unattributed"}</span>
            <span>·</span>
            <RelativeTime date={session.first_at} />
            <span>·</span>
            <span>
              {num(session.call_count)} call{session.call_count > 1 ? "s" : ""}
            </span>
            <span>·</span>
            <span className="tabular-nums">{fmtDur(session.duration_ms)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {retries > 0 && (
            <span className="text-[10px] text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded">
              {retries} retry
            </span>
          )}
          {session.error_count > 0 && (
            <span className="text-[10px] text-red-300 bg-red-500/10 px-1.5 py-0.5 rounded">
              {session.error_count} error{session.error_count > 1 ? "s" : ""}
            </span>
          )}
          <span className="text-sm font-semibold tabular-nums">{money(session.total_cost_usd)}</span>
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground/50 transition-transform", expanded && "rotate-180")}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/60">
          {memberQ.isPending ? (
            <div className="p-4 space-y-2">
              <div className="h-7 rounded bg-muted/25 animate-pulse" />
              <div className="h-5 w-2/3 rounded bg-muted/20 animate-pulse" />
            </div>
          ) : memberQ.isError ? (
            <div className="p-4 text-[11px] text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              Couldn&apos;t load this session&apos;s calls.
              <button onClick={() => memberQ.refetch()} className="underline hover:text-foreground">
                Retry
              </button>
            </div>
          ) : calls.length === 0 ? (
            <div className="p-4 text-[11px] text-muted-foreground">
              No individual calls found for this session in the window.
            </div>
          ) : (
            <>
              {/* Timeline strip */}
              <div className="px-4 pt-3">
                {/* Call sequence — one box per call, left→right in run order.
                    Box WIDTH tracks the call's latency (flex-grow ∝ latency,
                    basis 0), so a session with one slow call looks distinct from
                    a flat run of quick ones — the equal-box version made every
                    session identical. flexbox lays boxes side-by-side so they can
                    NEVER overlap (the original bug); min-w keeps the quickest
                    calls visible. Color = status; exact timing/latency is in the
                    member list + hover tooltip. */}
                <div className="flex items-center gap-1 h-7 overflow-hidden">
                  {calls.map((c) => (
                    <button
                      key={c.span_id}
                      onClick={() => onOpenTrace(c.trace_id)}
                      title={`${memberPath(c).join(" › ")} · ${fmtMs(c.latency_ms)} · ${money(c.cost_usd)}`}
                      style={{ flexGrow: Math.max(c.latency_ms, 1), flexBasis: 0 }}
                      className={cn(
                        "h-7 min-w-[3px] rounded-sm opacity-90 hover:opacity-100 transition-opacity",
                        memberBarColor(c.status),
                      )}
                    />
                  ))}
                </div>
              </div>

              {/* Member calls */}
              <div className="p-2">
                {calls.map((c) => {
                  const offsetMs = Date.parse(c.timestamp) - t0;
                  const path = memberPath(c);
                  const unpriced = c.cost_source === "unknown_model";
                  return (
                    <button
                      key={c.span_id}
                      onClick={() => onOpenTrace(c.trace_id)}
                      className="w-full group flex items-center gap-2 px-2 py-1.5 rounded row-interactive text-xs text-left"
                    >
                      <span className="tabular-nums text-muted-foreground w-14 shrink-0">+{fmtDur(offsetMs)}</span>
                      <span className="flex items-center gap-1 min-w-0 flex-1 truncate">
                        {path.map((p, i) => (
                          <span key={i} className="inline-flex items-center gap-1">
                            {i > 0 && <span className="text-muted-foreground/50">›</span>}
                            <span className={i === path.length - 1 ? "text-foreground" : "text-muted-foreground"}>
                              {p}
                            </span>
                          </span>
                        ))}
                      </span>
                      <span className="tabular-nums text-muted-foreground shrink-0">{fmtMs(c.latency_ms)}</span>
                      <span className="tabular-nums w-16 text-right shrink-0">
                        {unpriced ? <span className="text-muted-foreground">—</span> : money(c.cost_usd)}
                      </span>
                      <span className="shrink-0">
                        <StatusBadge status={c.status} />
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-foreground shrink-0" />
                    </button>
                  );
                })}
                {capped && (
                  <p className="px-2 pt-1 text-[10px] text-muted-foreground/70">
                    Showing the first 50 calls — open a call for the full trace.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ── Drawer ───────────────────────────────────────────────────────────────────
function buildTree(spans: Trace[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const s of spans) byId.set(s.span_id, { ...s, children: [] });
  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_span_id && byId.has(node.parent_span_id)) {
      byId.get(node.parent_span_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
function flatten(nodes: SpanNode[], depth = 0, out: { node: SpanNode; depth: number }[] = []) {
  for (const n of nodes) {
    out.push({ node: n, depth });
    flatten(n.children, depth + 1, out);
  }
  return out;
}

function TraceDrawerContent({
  traceId,
  orgId,
  enabled,
  from,
  to,
  onClose,
}: {
  traceId: string;
  orgId: string;
  enabled: boolean;
  // Optional: omitted for deep-linked traces so the backend self-probes the
  // trace's real timestamp instead of constraining to the current window.
  from?: Date;
  to?: Date;
  onClose: () => void;
}) {
  const q = useTraceTree({ orgId, traceId, from, to }, enabled);
  const spans = useMemo(() => q.data?.spans ?? [], [q.data]);
  const tree = useMemo(() => buildTree(spans), [spans]);
  const flat = useMemo(() => flatten(tree), [tree]);

  const [selId, setSelId] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  useEffect(() => {
    if (!selId && flat.length > 0) setSelId(flat[0].node.span_id);
  }, [flat, selId]);
  // Attempt history per span_id. The selected span resolves to its FINAL
  // attempt (highest attempt_number) so the request/response/cost panels show
  // the representative call, not the earlier failed attempt sharing this span_id.
  const groups = useMemo(() => attemptGroups(spans), [spans]);
  const selGroup = selId ? groups.get(selId) : undefined;
  const selected =
    (selGroup && selGroup.length > 0 ? selGroup[selGroup.length - 1] : undefined) ??
    spans.find((s) => s.span_id === selId);
  const selectedAttempts = selGroup ?? [];
  const root = flat[0]?.node;

  const totalLatency = spans.reduce((m, s) => Math.max(m, s.latency_ms), 0);
  const totalCost = spans.reduce((a, s) => a + s.cost_usd, 0);
  const totalTokens = spans.reduce((a, s) => a + s.input_tokens + s.output_tokens, 0);

  // Trace-level retry rollup: every non-final attempt across all spans is a
  // retry. Count them, sum their (wasted) spend, and collect the reasons.
  let retries = 0;
  let wastedCost = 0;
  const reasonSet = new Set<NonNullable<Trace["retry_reason"]>>();
  for (const g of groups.values()) {
    if (g.length <= 1) continue;
    for (let i = 0; i < g.length - 1; i++) {
      retries += 1;
      wastedCost += g[i].cost_usd;
    }
    for (const a of g) if (a.retry_reason) reasonSet.add(a.retry_reason);
  }
  const retryReasons = Array.from(reasonSet);

  return (
    <>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium flex-wrap">
              <span className="truncate">{root ? spanLabel(root) : "Trace"}</span>
              {root && <StatusBadge status={root.status} />}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
              <span className="font-mono truncate max-w-[280px]">{traceId}</span>
              <CopyButton value={traceId} iconOnly />
              {root && (
                <>
                  <span>·</span>
                  <RelativeTime date={root.timestamp} />
                </>
              )}
              {root?.environment && (
                <>
                  <span>·</span>
                  <span>{root.environment}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={async () => {
                const url = new URL("/dashboard/traces", window.location.origin);
                url.searchParams.set("trace", traceId);
                if (selId) url.searchParams.set("span", selId);
                try {
                  await navigator.clipboard.writeText(url.toString());
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 1500);
                } catch {
                  /* clipboard blocked (insecure context) — silently ignore */
                }
              }}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground rounded-md px-1.5 py-1 hover:bg-surface-hover transition-colors focus-ring"
              title="Copy a shareable link to this trace"
            >
              {linkCopied ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">{linkCopied ? "Copied" : "Copy link"}</span>
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors focus-ring"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {q.isPending ? (
        <div className="p-4 space-y-3">
          <div className="h-16 rounded-lg bg-muted/30 animate-pulse" />
          <div className="h-40 rounded-lg bg-muted/30 animate-pulse" />
          <div className="h-56 rounded-lg bg-muted/30 animate-pulse" />
        </div>
      ) : q.isError || spans.length === 0 ? (
        <div className="p-8 text-center">
          <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-2" />
          <p className="text-sm text-foreground">
            {q.isError ? "Couldn't load this trace." : "No spans found for this trace."}
          </p>
          {q.isError && (
            <Button variant="outline" size="sm" onClick={() => q.refetch()} className="mt-3">
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          )}
        </div>
      ) : (
        <div className="p-4 space-y-5">
          {/* Metric strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border rounded-lg overflow-hidden">
            <Metric label="Latency" value={fmtMs(totalLatency)} />
            <Metric label="TTFT" value={selected?.ttft_ms != null ? `${selected.ttft_ms}ms` : "—"} />
            <Metric
              label="Cost"
              value={money(totalCost)}
              sub={selected ? confLabel(selected.cost_source) : undefined}
              dot={selected ? confDot(selected.cost_source) : undefined}
            />
            <Metric label="Tokens" value={num(totalTokens)} sub="in + out" />
          </div>

          {/* Retry banner — wasted spend + a jump to the Waste Inbox, which
              rolls up retry burn across every trace. */}
          {retries > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-3 text-[11px]">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <span className="font-medium text-amber-200">
                    Retried {retries}×
                  </span>
                  {wastedCost > 0 && (
                    <span className="text-amber-200/90"> · {money(wastedCost)} wasted</span>
                  )}
                  {retryReasons.length > 0 && (
                    <span className="text-muted-foreground">
                      {" — "}
                      {retryReasons.map(retryReasonLabel).join(", ")}
                    </span>
                  )}
                </div>
                <Link
                  href="/dashboard#waste"
                  className="inline-flex items-center gap-0.5 text-amber-200 hover:text-amber-100 underline underline-offset-2 shrink-0"
                >
                  View in Waste Inbox
                  <ChevronRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          )}

          {/* Timeline */}
          <Sec title="Timeline">
            <Waterfall flat={flat} selectedId={selId} onSelect={setSelId} />
          </Sec>

          {/* Attempts — per-attempt history for the selected (retried) span */}
          {selectedAttempts.length > 1 && <AttemptsSection attempts={selectedAttempts} />}

          {/* Selected span — request / response / cost / metadata */}
          {selected && <SpanSections span={selected} />}
        </div>
      )}
    </>
  );
}

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  dot,
}: {
  label: string;
  value: string;
  sub?: string;
  dot?: string;
}) {
  return (
    <div className="bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5 flex items-center gap-1.5">
        {dot && <span className={cn("size-1.5 rounded-full", dot)} />}
        {value}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

// Per-attempt history for one logical span (same span_id, distinct timestamps).
// Mirrors the prototype's ATTEMPTS list: each attempt's status, why it retried,
// a WASTED tag on every non-final attempt, plus its latency + (wasted) cost.
function AttemptsSection({ attempts }: { attempts: Trace[] }) {
  return (
    <Sec title="Attempts">
      <div className="rounded-md border border-border overflow-hidden text-[11px]">
        {attempts.map((a, i) => {
          const isFinal = i === attempts.length - 1;
          const wasted = !isFinal;
          // retry_reason lives on the SUCCESSOR attempt (it names why THIS one
          // was retried), so read it off the next attempt in the list.
          const reason = attempts[i + 1]?.retry_reason ?? null;
          return (
            <div
              key={`${a.span_id}-${a.attempt_number ?? i + 1}-${a.timestamp}`}
              className={cn(
                "flex items-center gap-2 px-3 py-2",
                i > 0 && "border-t border-border/60",
                wasted && "bg-red-500/[0.04]",
              )}
            >
              <span className="text-muted-foreground tabular-nums shrink-0">
                Attempt {a.attempt_number ?? i + 1}
              </span>
              <StatusBadge status={a.status} />
              {wasted ? (
                <span className="text-[10px] font-medium uppercase tracking-wider text-red-300/90">
                  Wasted
                </span>
              ) : (
                <span className="text-[10px] text-emerald-300/80">final</span>
              )}
              {reason && (
                <span className="text-muted-foreground truncate">· {retryReasonLabel(reason)}</span>
              )}
              <span className="ml-auto flex items-center gap-3 tabular-nums shrink-0">
                <span className="text-muted-foreground">{fmtMs(a.latency_ms)}</span>
                <span className={cn(wasted ? "text-red-300/90" : "text-foreground")}>
                  {money(a.cost_usd)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </Sec>
  );
}

// Bar tint by kind/status — mirrors the prototype's waterfall so a multi-span trace
// reads as a real distributed timeline rather than a wall of identical purple:
// failures red/amber, LLM calls brand-purple, tool steps cyan, agent + workflow
// containers neutral greys (the agent slightly brighter than its workflow).
function spanBarClass(s: Trace): string {
  if (s.status === "error" || s.status === "timeout") return "bg-red-500/70";
  if (s.status === "rate_limited") return "bg-amber-500/70";
  if (s.kind === "llm") return "bg-[#5B54E8]";
  if (s.kind === "step") return "bg-cyan-500/50";
  if (s.kind === "agent") return "bg-foreground/30";
  return "bg-foreground/15"; // workflow container + anything else
}

// Leading status/kind dot for each timeline row — the per-row colour anchor
// the prototype has and v2 lacked. A failed attempt is red/amber regardless of kind,
// otherwise the kind's own hue (llm purple, step cyan, containers muted).
function spanKindDot(s: Trace): string {
  if (s.status === "error" || s.status === "timeout") return "bg-red-400";
  if (s.status === "rate_limited") return "bg-amber-400";
  if (s.kind === "llm") return "bg-[#5B54E8]";
  if (s.kind === "step") return "bg-cyan-400/70";
  return "bg-muted-foreground/50"; // workflow / agent containers
}

// Real waterfall — bar position derives from each span's wall-clock timestamp
// relative to the earliest span; width from latency_ms.
function Waterfall({
  flat,
  selectedId,
  onSelect,
}: {
  flat: { node: SpanNode; depth: number }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t0 = Math.min(...flat.map((f) => Date.parse(f.node.timestamp)));
  const tEnd = Math.max(...flat.map((f) => Date.parse(f.node.timestamp) + f.node.latency_ms));
  const total = Math.max(tEnd - t0, 1);

  return (
    <div className="space-y-1">
      {flat.map(({ node, depth }) => {
        const left = ((Date.parse(node.timestamp) - t0) / total) * 100;
        const width = Math.max((node.latency_ms / total) * 100, 1);
        const isSel = node.span_id === selectedId;
        return (
          <button
            key={node.span_id}
            onClick={() => onSelect(node.span_id)}
            className={cn(
              "flex items-center gap-2 text-[11px] w-full rounded px-1 py-0.5 text-left row-interactive",
              isSel && "row-active",
            )}
          >
            <span className="w-[42%] shrink-0 truncate flex items-center gap-1.5" style={{ paddingLeft: depth * 12 }}>
              <span className={cn("size-1.5 rounded-full shrink-0", spanKindDot(node))} aria-hidden />
              <span className={cn("truncate", isWorkflowSpan(node) ? "text-muted-foreground" : "text-foreground")}>
                {spanLabel(node)}
              </span>
            </span>
            <span className="relative flex-1 h-3.5 rounded bg-muted/25">
              <span
                className={cn("absolute top-0 h-3.5 rounded", spanBarClass(node))}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={fmtMs(node.latency_ms)}
              />
            </span>
            <span className="w-12 text-right tabular-nums text-muted-foreground shrink-0">
              {fmtMs(node.latency_ms)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SpanSections({ span }: { span: Trace }) {
  const workflow = isWorkflowSpan(span);
  const hasSplit =
    typeof span.input_cost_usd === "number" &&
    typeof span.output_cost_usd === "number" &&
    (span.input_cost_usd > 0 || span.output_cost_usd > 0);

  const meta: Array<[string, ReactNode]> = [];
  if (!workflow) {
    meta.push(["model", <code key="m" className="font-mono">{span.model}</code>]);
    meta.push(["provider", span.provider]);
  }
  meta.push(["environment", span.environment]);
  if (span.feature_name) meta.push(["feature", span.feature_name]);
  if (span.user_id) meta.push(["user", span.user_id]);
  if (span.session_id) meta.push(["session", span.session_id]);
  if (span.sdk_version) meta.push(["sdk", span.sdk_version]);
  if (span.prompt_version) meta.push(["prompt_version", span.prompt_version]);
  meta.push(["span_id", span.span_id]);

  return (
    <>
      {span.error_message && (
        <div className="rounded-md border border-red-500/30 bg-red-500/[0.05] p-3 text-[11px] font-mono text-red-300 break-all">
          {span.error_message}
        </div>
      )}

      {span.input_text && (
        <Sec title="Request">
          <pre className="rounded-md border border-border bg-muted/20 p-2.5 text-[11px] font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
            {span.input_text}
          </pre>
        </Sec>
      )}

      {span.output_text && (
        <Sec title="Response">
          <pre
            className={cn(
              "rounded-md border p-2.5 text-[11px] font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto",
              span.error_message ? "border-red-500/30 bg-red-500/[0.05]" : "border-border bg-muted/20",
            )}
          >
            {span.output_text}
          </pre>
        </Sec>
      )}

      {!workflow && (
        <Sec title="Cost & tokens">
          <div className="rounded-md border border-border overflow-hidden text-[11px]">
            {hasSplit && (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
                  <span className="text-muted-foreground">Input · {num(span.input_tokens)} tok</span>
                  <span className="tabular-nums">{money(span.input_cost_usd as number)}</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
                  <span className="text-muted-foreground">Output · {num(span.output_tokens)} tok</span>
                  <span className="tabular-nums">{money(span.output_cost_usd as number)}</span>
                </div>
              </>
            )}
            <div className="flex items-center justify-between px-3 py-2 bg-muted/20 font-medium">
              <span>Total · {num(span.input_tokens + span.output_tokens)} tok</span>
              <span className="tabular-nums">{money(span.cost_usd)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-1.5">
            <span className={cn("size-1.5 rounded-full", confDot(span.cost_source))} />
            {confLabel(span.cost_source)}
            {span.pricing_version && <span>· pricing {span.pricing_version}</span>}
          </div>
        </Sec>
      )}

      <Sec title="Metadata">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
          {meta.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 min-w-0">
              <span className="text-muted-foreground shrink-0">{k}</span>
              <span className="font-mono text-foreground/90 truncate">{v}</span>
            </div>
          ))}
        </div>
      </Sec>
    </>
  );
}

export default function V2TracesPage() {
  return (
    <Suspense fallback={<div className="h-96 rounded-xl bg-muted/30 animate-pulse" />}>
      <TracesView />
    </Suspense>
  );
}
