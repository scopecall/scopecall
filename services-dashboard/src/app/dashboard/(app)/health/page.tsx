"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, AlertTriangle, ArrowRight, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { money, num } from "@/lib/format";
import { useOrgId } from "@/lib/org-context";
import { useOverview } from "@/lib/queries/use-overview";
import { useLatencyMetrics } from "@/lib/queries/use-metrics";
import { useErrorsByStatus } from "@/lib/queries/use-errors-by-status";
import { useRegressions, type Regression } from "@/lib/queries/use-regressions";
import { useSDKHealth } from "@/lib/queries/use-sdk-health";
import { useBreakdown } from "@/lib/queries/use-breakdown";
import { AreaChart, Delta, Sparkline } from "../_components/viz";
import { globalScopeQuery, useTimeRange } from "../_lib/use-time-range";

/**
 * v2 Health — a real-data port of the Health design prototype (the "is it working" surface,
 * kept out of the money story). The prototype's mock-only pieces are mapped to
 * what the API can actually answer, with the substitutions called out honestly:
 *
 *  • Glance row → /overview (error rate, p99, avg latency, calls) with prior-
 *    window deltas. The prototype's "TTFT p50" card is dropped: there is no
 *    aggregate TTFT endpoint (ttft_ms exists per-span only), so avg latency
 *    takes its place rather than inventing a number.
 *  • "Latency by model" (p50/p95/p99/TTFT per model) is NOT backed — the latency
 *    endpoint returns an org-wide series with avg + p99 only, no grouping. It
 *    becomes "Latency over time": a p99 area chart plus avg + error sparklines.
 *  • Errors by status → /metrics/errors-by-status, summed across buckets.
 *  • "Failure modes" (classified from finish_reason) has no endpoint, so it
 *    becomes "Errors by model" from /breakdown(model).error_count — the same
 *    "where is it failing" question, answered from real data.
 *  • Adds a live ingest strip (/sdk/health) and a regressions panel
 *    (/regressions) — both genuinely health-shaped and absent from the mock.
 *
 * Every panel drills into Traces carrying the global scope, like the rest of v2.
 */

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

function fmtAgo(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export default function V2HealthPage() {
  const orgId = useOrgId();
  const { from, to, granularity, label } = useTimeRange();
  const router = useRouter();
  const sp = useSearchParams();

  const enabled = !!orgId;
  const oid = orgId ?? "";

  // Prior window for deltas — same convention as Overview.
  const span = to.getTime() - from.getTime();
  const priorFrom = new Date(from.getTime() - span);
  const priorTo = from;

  const cur = useOverview({ orgId: oid, from, to }, enabled);
  const prev = useOverview({ orgId: oid, from: priorFrom, to: priorTo }, enabled);
  const latSeries = useLatencyMetrics({ orgId: oid, from, to, granularity }, enabled);
  const errStatusQ = useErrorsByStatus({ orgId: oid, from, to, granularity }, enabled);
  const regsQ = useRegressions({ orgId: oid, from, to, limit: 12 }, enabled);
  const sdkQ = useSDKHealth(oid, enabled);
  const modelBd = useBreakdown({ orgId: oid, from, to, groupBy: "model", limit: 50 }, enabled);

  // Drill into Traces, merging the requested filters onto the global scope.
  const drillTraces = useCallback(
    (params: Record<string, string | undefined>) => {
      const scope = globalScopeQuery(sp);
      const next = new URLSearchParams(scope.startsWith("?") ? scope.slice(1) : scope);
      for (const [k, v] of Object.entries(params)) if (v) next.set(k, v);
      router.push(`/dashboard/traces?${next.toString()}`);
    },
    [router, sp],
  );

  // ── Page-level gate (only the headline query blocks) ──────────────────────
  // isPending (not isLoading): gate the skeleton until data actually exists, so
  // we never flash a misleading "$0 / 0%" with the query settled-but-dataless.
  // Same convention as Spend.
  if (!orgId || cur.isPending) return <HealthSkeleton />;
  if (cur.isError) {
    return <ErrorState message="Couldn't load health metrics for this window." onRetry={() => cur.refetch()} />;
  }
  if (cur.data && cur.data.total_calls === 0) {
    return <EmptyState scope={globalScopeQuery(sp)} />;
  }

  // ── Glance numbers + prior deltas ─────────────────────────────────────────
  const errorRatePct = cur.data?.error_rate_pct ?? 0;
  const errPp = errorRatePct - (prev.data?.error_rate_pct ?? 0);
  const p99Ms = cur.data?.p99_latency_ms ?? 0;
  const priorP99 = prev.data?.p99_latency_ms ?? 0;
  const p99Pct = priorP99 > 0 ? ((p99Ms - priorP99) / priorP99) * 100 : null;
  const avgMs = cur.data?.avg_latency_ms ?? 0;
  const priorAvg = prev.data?.avg_latency_ms ?? 0;
  const avgPct = priorAvg > 0 ? ((avgMs - priorAvg) / priorAvg) * 100 : null;
  const calls = cur.data?.total_calls ?? 0;

  // ── Latency series + secondary sparks ─────────────────────────────────────
  const latPoints = latSeries.data?.points ?? [];
  const p99Data = latPoints.map((p) => p.p99_latency_ms ?? 0);
  const avgData = latPoints.map((p) => p.avg_latency_ms ?? 0);
  const latLabels = buildLabels(latPoints, granularity);

  // ── Errors by status (summed across buckets) ──────────────────────────────
  const errPoints = errStatusQ.data?.points ?? [];
  const errTotals = errPoints.reduce(
    (a, p) => ({
      error: a.error + p.error,
      timeout: a.timeout + p.timeout,
      rate_limited: a.rate_limited + p.rate_limited,
    }),
    { error: 0, timeout: 0, rate_limited: 0 },
  );
  const errSeriesData = errPoints.map((p) => p.error + p.timeout + p.rate_limited);

  const statusRows: BarRow[] = (
    [
      { label: "error", count: errTotals.error, tone: "bad", onClick: () => drillTraces({ status: "error" }) },
      { label: "timeout", count: errTotals.timeout, tone: "bad", onClick: () => drillTraces({ status: "timeout" }) },
      {
        label: "rate_limited",
        count: errTotals.rate_limited,
        tone: "warn",
        onClick: () => drillTraces({ status: "rate_limited" }),
      },
    ] as BarRow[]
  ).filter((r) => r.count > 0);

  // ── Errors by model (honest stand-in for "failure modes") ─────────────────
  const modelErrRows: BarRow[] = (modelBd.data?.rows ?? [])
    .filter((r) => r.error_count > 0)
    .sort((a, b) => b.error_count - a.error_count)
    .slice(0, 8)
    .map((r) => ({
      label: r.key || "(none)",
      count: r.error_count,
      tone: "bad" as const,
      onClick: r.key ? () => drillTraces({ model: r.key, status: "error" }) : undefined,
    }));

  const barMax = Math.max(1, ...statusRows.map((r) => r.count), ...modelErrRows.map((r) => r.count));

  const regs = regsQ.data?.regressions ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Health</h1>
        <p className="text-[11px] text-muted-foreground">
          Latency and errors · {label} · the &quot;is it working&quot; surface, kept out of the money story
        </p>
      </div>

      {/* Live ingest strip */}
      <IngestStrip q={sdkQ} />

      {/* Glance row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Glance
          label="Error rate"
          value={`${errorRatePct.toFixed(1)}%`}
          sub={<PpDelta pp={errPp} />}
        />
        <Glance
          label="p99 latency"
          value={fmtMs(p99Ms)}
          sub={
            p99Pct != null ? (
              <>
                <Delta pct={p99Pct} direction="up-is-bad" /> vs prior
              </>
            ) : (
              "no prior period"
            )
          }
        />
        <Glance
          label="Avg latency"
          value={fmtMs(avgMs)}
          sub={
            avgPct != null ? (
              <>
                <Delta pct={avgPct} direction="up-is-bad" /> vs prior
              </>
            ) : (
              "no prior period"
            )
          }
        />
        <Glance label="Calls" value={num(calls)} sub={label.replace(/^Last /, "last ")} />
      </div>

      {/* Latency over time */}
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card">
        <div className="px-4 pt-4 pb-1 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold">Latency over time</h2>
            <p className="text-[11px] text-muted-foreground">
              p99 across all calls · {granularity === "hour" ? "hourly" : "daily"} buckets · per-model
              percentiles aren&apos;t available from the API
            </p>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">p99 {fmtMs(p99Ms)}</span>
        </div>
        <div className="px-4 pb-3">
          {latSeries.isLoading ? (
            <div className="h-[140px] rounded-md bg-muted/30 animate-pulse" />
          ) : (
            <AreaChart data={p99Data} labels={latLabels} color="#f59e0b" formatValue={fmtMs} />
          )}
        </div>
        <div className="px-4 pb-4 pt-3 border-t border-border grid grid-cols-2 gap-4">
          <SecondarySpark label="Avg latency" data={avgData} color="#5B54E8" value={fmtMs(avgMs)} />
          <SecondarySpark
            label="Errors"
            data={errSeriesData}
            color="#ef4444"
            value={`${errorRatePct.toFixed(1)}%`}
          />
        </div>
      </section>

      {/* What's degrading */}
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card">
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-amber-400" /> What&apos;s degrading
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Latency, error-rate, cost and volume regressions vs the prior period
          </p>
        </div>
        {regsQ.isLoading ? (
          <RowsSkeleton />
        ) : regsQ.isError ? (
          <div className="px-4 pb-5 pt-1">
            <p className="text-[11px] text-muted-foreground">Couldn&apos;t load regressions.</p>
            <Button variant="outline" size="sm" onClick={() => regsQ.refetch()} className="mt-2">
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : regs.length === 0 ? (
          <p className="px-4 pb-5 pt-1 text-[11px] text-muted-foreground">
            No regressions detected — metrics held steady vs the prior period.
          </p>
        ) : (
          <ul className="px-2 pb-2">
            {regs.map((r, i) => (
              <RegressionRow
                key={`${r.kind}-${r.feature}-${r.model}-${i}`}
                reg={r}
                onClick={() =>
                  drillTraces(r.feature ? { feature: r.feature } : r.model ? { model: r.model } : {})
                }
              />
            ))}
          </ul>
        )}
      </section>

      {/* Error breakdowns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BarList
          title="Errors by status"
          subtitle="What's failing, by provider response · click to open in Traces"
          rows={statusRows}
          max={barMax}
          loading={errStatusQ.isLoading}
          empty="No errors in this window — clean run."
        />
        <BarList
          title="Errors by model"
          subtitle="Where failures concentrate · click to open failing calls"
          rows={modelErrRows}
          max={barMax}
          loading={modelBd.isLoading}
          empty="No model produced an error in this window."
        />
      </div>

      <p className="pt-2 pb-6">
        <Link
          href={`/dashboard${globalScopeQuery(sp)}`}
          className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ArrowRight className="h-3 w-3 rotate-180" /> Back to the spend story
        </Link>
      </p>
    </div>
  );
}

// ── Glance ────────────────────────────────────────────────────────────────────
function Glance({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">{label}</p>
      <p className="text-2xl font-semibold tabular-nums leading-none">{value}</p>
      {sub && (
        <p className="text-[11px] mt-1.5 text-muted-foreground flex items-center gap-1 flex-wrap">{sub}</p>
      )}
    </div>
  );
}

// Percentage-point delta for the error-rate card (pp, not %).
function PpDelta({ pp }: { pp: number }) {
  if (Math.abs(pp) < 0.05) return <span className="text-muted-foreground">≈ flat vs prior</span>;
  const bad = pp > 0;
  const Icon = bad ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 tabular-nums font-medium",
        bad ? "text-red-400" : "text-emerald-400",
      )}
    >
      <Icon className="h-3 w-3" />
      {pp > 0 ? "+" : ""}
      {pp.toFixed(1)}pp vs prior
    </span>
  );
}

// ── Live ingest strip (SDK health) ─────────────────────────────────────────────
function IngestStrip({ q }: { q: ReturnType<typeof useSDKHealth> }) {
  if (q.isLoading || q.isError || !q.data) return null;
  const d = q.data;
  if (!d.has_calls) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px]">
        <span className="size-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
        <span className="text-amber-200 font-medium">Waiting for the first call</span>
        <span className="text-muted-foreground">— your SDK has not streamed anything yet.</span>
      </div>
    );
  }
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return (
    <div className="flex items-center gap-2 flex-wrap rounded-lg border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
      <span className="size-2 rounded-full bg-emerald-400 shrink-0" />
      <span className="text-foreground font-medium">Ingest live</span>
      <Dot /> last call {fmtAgo(d.seconds_since_last_call)}
      <Dot /> {num(d.calls_last_hour)} / hr
      <Dot /> {plural(d.distinct_models, "model")}
      <Dot /> {plural(d.distinct_providers, "provider")}
      <Dot /> {plural(d.distinct_environments, "env")}
    </div>
  );
}
function Dot() {
  return <span className="text-muted-foreground/40">·</span>;
}

// ── Regression row ──────────────────────────────────────────────────────────────
const REG_LABEL: Record<Regression["kind"], string> = {
  latency_p99: "p99 latency",
  error_rate: "error rate",
  cost: "cost",
  volume_drop: "volume drop",
};
function regValue(kind: Regression["kind"], v: number): string {
  switch (kind) {
    case "latency_p99":
      return fmtMs(v);
    case "cost":
      return money(v);
    case "error_rate":
      return `${(v <= 1 ? v * 100 : v).toFixed(1)}%`;
    case "volume_drop":
      return `${num(v)} calls`;
  }
}
function RegressionRow({ reg, onClick }: { reg: Regression; onClick: () => void }) {
  const critical = reg.severity === "critical";
  const identity = reg.feature || reg.model || "(unattributed)";
  const direction = reg.kind === "volume_drop" ? "down-is-bad" : "up-is-bad";
  return (
    <li>
      <button
        onClick={onClick}
        className="w-full text-left flex items-center gap-3 px-2 py-2 rounded row-interactive group"
      >
        <span
          className={cn("size-2 rounded-full shrink-0", critical ? "bg-red-400" : "bg-amber-400")}
          title={critical ? "critical" : "watch"}
        />
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs font-medium capitalize">{REG_LABEL[reg.kind]}</span>
            <span className="text-[11px] text-muted-foreground truncate">{identity}</span>
            {reg.model && reg.feature && (
              <span className="text-[10px] font-mono text-muted-foreground/70 truncate">{reg.model}</span>
            )}
          </span>
          <span className="block text-[11px] text-muted-foreground mt-0.5">
            {regValue(reg.kind, reg.current_value)} vs {regValue(reg.kind, reg.prior_value)} ·{" "}
            {num(reg.current_calls)} calls
          </span>
        </span>
        <Delta pct={reg.pct_change} direction={direction} />
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </button>
    </li>
  );
}

// ── Bar list ────────────────────────────────────────────────────────────────────
interface BarRow {
  label: string;
  count: number;
  tone: "bad" | "warn" | "neutral";
  onClick?: () => void;
}
function BarList({
  title,
  subtitle,
  rows,
  max,
  loading,
  empty,
}: {
  title: string;
  subtitle: string;
  rows: BarRow[];
  max: number;
  loading: boolean;
  empty: string;
}) {
  return (
    <section className="rounded-xl ring-1 ring-foreground/10 bg-card">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      {loading ? (
        <RowsSkeleton />
      ) : rows.length === 0 ? (
        <p className="px-4 pb-5 pt-1 text-[11px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="px-4 pb-4 space-y-2.5 mt-1">
          {rows.map((r) => {
            const bar =
              r.tone === "bad" ? "bg-red-500/70" : r.tone === "warn" ? "bg-amber-500/70" : "bg-muted-foreground/40";
            const body = (
              <>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className={cn("font-medium truncate", r.onClick && "group-hover:underline underline-offset-2")}>
                    {r.label}
                  </span>
                  <span className="tabular-nums text-muted-foreground shrink-0">{num(r.count)}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn("h-full rounded-full", bar)}
                    style={{ width: `${max > 0 ? (r.count / max) * 100 : 0}%` }}
                  />
                </div>
              </>
            );
            return (
              <li key={r.label}>
                {r.onClick ? (
                  <button
                    onClick={r.onClick}
                    className="w-full text-left group row-interactive rounded px-2 py-1.5 -mx-2"
                  >
                    {body}
                  </button>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Secondary sparkline (mirrors Overview) ─────────────────────────────────────
function SecondarySpark({
  label,
  data,
  color,
  value,
}: {
  label: string;
  data: number[];
  color: string;
  value: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="text-[11px] font-medium tabular-nums">{value}</span>
      </div>
      {data.length > 1 ? (
        <Sparkline data={data} color={color} />
      ) : (
        <div className="h-6 flex items-center text-[10px] text-muted-foreground">—</div>
      )}
    </div>
  );
}

// ── States ──────────────────────────────────────────────────────────────────────
function HealthSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-10 rounded-lg bg-muted/30 animate-pulse" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl bg-muted/30 animate-pulse" />
        ))}
      </div>
      <div className="h-64 rounded-xl bg-muted/30 animate-pulse" />
      <div className="h-40 rounded-xl bg-muted/30 animate-pulse" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="h-48 rounded-xl bg-muted/30 animate-pulse" />
        <div className="h-48 rounded-xl bg-muted/30 animate-pulse" />
      </div>
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="px-4 pb-4 space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-9 rounded bg-muted/30 animate-pulse" />
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-8 text-center">
      <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-3" />
      <p className="text-sm text-foreground">{message}</p>
      <p className="text-[11px] text-muted-foreground mt-1">
        The API may be unreachable, or this org has no data for the window.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-4">
        <RefreshCw className="h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}

function EmptyState({ scope }: { scope: string }) {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-10 text-center">
      <div className="size-9 rounded-full bg-muted/40 flex items-center justify-center mx-auto mb-3">
        <Activity className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">No calls in this window</p>
      <p className="text-[11px] text-muted-foreground mt-1 mb-4">
        Latency and error health appear here once your SDK streams calls.
      </p>
      <Link
        href={`/dashboard${scope}`}
        className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        Go to Overview <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

// One label per point. The AreaChart samples a few for its x-axis and reuses
// the full set for the hover readout, so we hand it every bucket's timestamp.
function buildLabels(points: { timestamp: string }[], granularity: "hour" | "day"): string[] {
  if (points.length === 0) return [];
  const fmt = (ts: string) => {
    const d = new Date(ts);
    return granularity === "hour"
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  };
  return points.map((p) => fmt(p.timestamp));
}
