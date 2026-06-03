import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import type { components } from "@/lib/api-types";
import { Activity, AlertTriangle, ArrowDown, ArrowUp, BarChart2, DollarSign, GitBranch, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Overview = components["schemas"]["OverviewResponse"];
type MetricPoint = components["schemas"]["MetricPoint"];

interface StatCardsProps {
  data: Overview | null;
  /** Prior-period overview, for delta computation. Optional; tiles render without delta if absent. */
  prior?: Overview | null;
  /** Per-hour metric points (any source returning MetricPoint[]). Drives the sparkline. */
  series?: MetricPoint[];
  isLoading: boolean;
  error: Error | null;
}

// "down-is-bad" / "up-is-bad" / "neutral" controls the delta colour. For cost,
// latency, error rate — a rising number is the bad direction. For calls and
// trace count — direction is informational, not graded.
type Direction = "up-is-bad" | "down-is-bad" | "neutral";

interface StatProps {
  icon: LucideIcon;
  title: string;
  value: string;
  delta?: { delta: number; pct: number; direction: Direction };
  spark?: number[];
  isLoading: boolean;
}

function fmt(n: number, opts?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat("en-US", opts).format(n);
}

// Pure-SVG sparkline — no chart lib needed for a 24px line, smaller bundle.
// Downsamples to MAX_POINTS via mean-bucketing so 30-day hourly data (720
// points) doesn't collapse into a chaotic squiggle in 80px of width.
const MAX_SPARK_POINTS = 40;

function downsample(data: number[], max: number): number[] {
  if (data.length <= max) return data;
  const bucketSize = Math.ceil(data.length / max);
  const out: number[] = [];
  for (let i = 0; i < data.length; i += bucketSize) {
    const slice = data.slice(i, i + bucketSize);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

function Sparkline({ data, color = "#5B54E8" }: { data: number[]; color?: string }) {
  if (data.length < 2) return null;
  const series = downsample(data, MAX_SPARK_POINTS);
  // viewBox coords — the SVG stretches to fill its container via preserveAspectRatio="none".
  // vector-effect="non-scaling-stroke" keeps the line weight visually consistent regardless of stretch.
  const w = 100;
  const h = 20;
  const max = Math.max(...series, 1);
  const min = Math.min(...series, 0);
  const range = max - min || 1;
  const points = series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block w-full h-5">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
        points={points}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Delta({ delta, pct, direction }: { delta: number; pct: number; direction: Direction }) {
  if (!Number.isFinite(pct)) return null;
  const up = delta > 0;
  const isBad =
    direction === "up-is-bad" ? up :
    direction === "down-is-bad" ? !up :
    false;
  const Arrow = up ? ArrowUp : ArrowDown;
  const color =
    direction === "neutral"
      ? "text-muted-foreground"
      : isBad
        ? "text-red-400"
        : "text-emerald-400";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[10px] tabular-nums font-medium", color)}>
      <Arrow className="h-2.5 w-2.5" />
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function Stat({ icon: Icon, title, value, delta, spark, isLoading }: StatProps) {
  return (
    <div className="p-3 rounded-lg border border-border bg-card overflow-hidden">
      {/* Row 1: icon + label + delta — meta info gets its own line */}
      <div className="flex items-center gap-2 mb-2">
        <div className="size-6 rounded bg-muted flex items-center justify-center shrink-0">
          <Icon className="size-3.5 text-muted-foreground" />
        </div>
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider truncate flex-1">
          {title}
        </p>
        {delta && !isLoading && <Delta {...delta} />}
      </div>
      {/* Row 2: value + sparkline — sparkline gets all remaining width, no fighting */}
      {isLoading ? (
        <Skeleton className="h-7 w-24" />
      ) : (
        <div className="flex items-end gap-2.5">
          <p className="text-xl font-semibold tabular-nums leading-tight shrink-0">{value}</p>
          {spark && spark.length > 1 && (
            <div className="opacity-60 flex-1 min-w-0 pb-0.5">
              <Sparkline data={spark} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Aggregate (hour, model) points into a flat per-hour series for one metric.
function seriesFor(points: MetricPoint[] | undefined, key: "call_count" | "total_cost_usd" | "avg_latency_ms" | "p99_latency_ms" | "error_rate"): number[] {
  if (!points || points.length === 0) return [];
  // Group by timestamp first (since data is per (hour, model))
  const byHour = new Map<string, { calls: number; cost: number; weightedAvgNum: number; p99: number; errors: number }>();
  for (const p of points) {
    if (!p.timestamp) continue;
    const e = byHour.get(p.timestamp) ?? { calls: 0, cost: 0, weightedAvgNum: 0, p99: 0, errors: 0 };
    e.calls += p.call_count ?? 0;
    e.cost += p.total_cost_usd ?? 0;
    e.weightedAvgNum += (p.avg_latency_ms ?? 0) * (p.call_count ?? 0);
    e.p99 = Math.max(e.p99, p.p99_latency_ms ?? 0);
    e.errors += p.error_count ?? 0;
    byHour.set(p.timestamp, e);
  }
  const sorted = Array.from(byHour.entries()).sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([, v]) => {
    switch (key) {
      case "call_count": return v.calls;
      case "total_cost_usd": return v.cost;
      case "avg_latency_ms": return v.calls > 0 ? v.weightedAvgNum / v.calls : 0;
      case "p99_latency_ms": return v.p99;
      case "error_rate": return v.calls > 0 ? (v.errors / v.calls) * 100 : 0;
    }
  });
}

function delta(curr: number | undefined, prior: number | undefined, direction: Direction) {
  if (curr == null || prior == null || !Number.isFinite(prior) || prior === 0) return undefined;
  const pct = ((curr - prior) / prior) * 100;
  // Suppress meaningless deltas. When prior is tiny (e.g. a fresh install
  // with one stray event from /setup) and current is normal, the percent
  // explodes into the hundreds of thousands — the user reported a
  // 138,877% cost delta on the Overview card after seeding. The math is
  // right but unreadable. >100× change in either direction (>9999%) is
  // almost always "noise vs new traffic", not signal. Hide the badge
  // entirely so the absolute number on the card stands alone.
  if (!Number.isFinite(pct) || Math.abs(pct) > 9999) return undefined;
  return { delta: curr - prior, pct, direction };
}

export function StatCards({ data, prior, series, isLoading, error }: StatCardsProps) {
  if (error && !isLoading) {
    return <ErrorState variant="inline" title="Couldn't load overview metrics" error={error} />;
  }

  const callsSpark = seriesFor(series, "call_count");
  const costSpark = seriesFor(series, "total_cost_usd");
  const avgLatSpark = seriesFor(series, "avg_latency_ms");
  const p99Spark = seriesFor(series, "p99_latency_ms");
  const errSpark = seriesFor(series, "error_rate");

  const stats: StatProps[] = [
    {
      icon: BarChart2,
      title: "Total Calls",
      value: data ? fmt(data.total_calls) : "—",
      delta: delta(data?.total_calls, prior?.total_calls, "neutral"),
      spark: callsSpark,
      isLoading,
    },
    {
      icon: DollarSign,
      title: "Total Cost",
      value: data ? fmt(data.total_cost_usd, { style: "currency", currency: "USD", maximumFractionDigits: 4 }) : "—",
      delta: delta(data?.total_cost_usd, prior?.total_cost_usd, "up-is-bad"),
      spark: costSpark,
      isLoading,
    },
    {
      icon: Activity,
      title: "Avg Latency",
      value: data ? `${fmt(data.avg_latency_ms, { maximumFractionDigits: 0 })}ms` : "—",
      delta: delta(data?.avg_latency_ms, prior?.avg_latency_ms, "up-is-bad"),
      spark: avgLatSpark,
      isLoading,
    },
    {
      icon: Zap,
      title: "P99 Latency",
      value: data ? `${fmt(data.p99_latency_ms, { maximumFractionDigits: 0 })}ms` : "—",
      delta: delta(data?.p99_latency_ms, prior?.p99_latency_ms, "up-is-bad"),
      spark: p99Spark,
      isLoading,
    },
    {
      icon: AlertTriangle,
      title: "Error Rate",
      value: data ? `${fmt(data.error_rate_pct, { maximumFractionDigits: 2 })}%` : "—",
      delta: delta(data?.error_rate_pct, prior?.error_rate_pct, "up-is-bad"),
      spark: errSpark,
      isLoading,
    },
    {
      icon: GitBranch,
      title: "Unique Traces",
      value: data ? fmt(data.unique_traces) : "—",
      delta: delta(data?.unique_traces, prior?.unique_traces, "neutral"),
      // No sparkline — unique_traces isn't in the per-hour rollup
      isLoading,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {stats.map((s) => (
        <Stat key={s.title} {...s} />
      ))}
    </div>
  );
}
