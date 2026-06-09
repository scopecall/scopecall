"use client";

import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  Compass,
  DollarSign,
  ExternalLink,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useOverview } from "@/lib/queries/use-overview";
import { useTopMovers } from "@/lib/queries/use-top-movers";
import { useAlertEvents } from "@/lib/queries/use-alerts";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  orgId: string;
  from: Date;
  to: Date;
  enabled: boolean;
}

type Severity = "info" | "watch" | "alert";
interface Insight {
  id: string;
  severity: Severity;
  headline: string;
  sublabel: string;
  href: string;
  icon: LucideIcon;
}

// Thresholds for what counts as "worth surfacing." Tuned conservatively so
// the strip stays empty on quiet days — if every visit shows 5 fake
// insights, the user stops trusting it. False negatives are cheaper than
// false positives here.
const COST_PCT_THRESHOLD = 20;       // %
const COST_ABS_THRESHOLD = 1.0;       // USD
const ERROR_RATE_THRESHOLD = 2.0;     // %
const ERROR_RATE_CRITICAL = 5.0;      // %
const P99_PCT_THRESHOLD = 50;         // %

export function OverviewInsights({ orgId, from, to, enabled }: Props) {
  // Prior window for delta calculations — mirror what StatCards uses.
  const duration = to.getTime() - from.getTime();
  const priorFrom = new Date(from.getTime() - duration);
  const priorTo = from;

  const current = useOverview({ orgId, from, to }, enabled);
  const prior = useOverview({ orgId, from: priorFrom, to: priorTo }, enabled);
  const moversByModel = useTopMovers({ orgId, from, to, groupBy: "model", limit: 5 }, enabled);
  const alerts = useAlertEvents(enabled);

  // Defensive: every input to deriveInsights coerced to a known-safe shape.
  // If a query is in error state, treat its data as missing rather than letting
  // an unexpected response shape blow up the render.
  const insights = deriveInsights({
    overview: current.data ?? null,
    prior: prior.data ?? null,
    moversByModel: Array.isArray(moversByModel.data?.rows) ? moversByModel.data!.rows : [],
    openEvents: Array.isArray(alerts.data)
      ? alerts.data.filter((e) => e && !e.resolved_at)
      : [],
    range: { from, to },
  });

  // Loading: don't render skeletons — the strip is a "bonus" surface; better
  // to silently appear when data is ready than show a bunch of grey rectangles.
  if (!current.data && !prior.data) return null;

  // No insights — show an encouraging quiet-state card so the strip doesn't
  // disappear and reappear (which felt like a flicker to me in testing).
  if (insights.length === 0) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-card/40">
        <Sparkles className="h-4 w-4 text-emerald-400 shrink-0" />
        <div className="text-xs flex-1">
          <span className="text-foreground font-medium">All quiet.</span>{" "}
          <span className="text-muted-foreground">
            Nothing notable in this window. Take a look at the{" "}
            <Link href="/dashboard/traces" className="text-brand hover:underline">Flow Map</Link>{" "}
            to understand your app&apos;s call patterns.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      {insights.map((ins) => (
        <InsightCard key={ins.id} insight={ins} />
      ))}
    </div>
  );
}

function InsightCard({ insight }: { insight: Insight }) {
  const Icon = insight.icon;
  const tone =
    insight.severity === "alert" ? "border-red-500/40 bg-red-500/5 hover:bg-red-500/10"
    : insight.severity === "watch" ? "border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10"
    : "border-border bg-card hover:bg-muted/40";
  const iconColor =
    insight.severity === "alert" ? "text-red-400"
    : insight.severity === "watch" ? "text-amber-400"
    : "text-muted-foreground";

  return (
    <Link
      href={insight.href}
      className={cn(
        "flex flex-col gap-1 px-3 py-3 rounded-lg border transition-colors group",
        tone,
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4 shrink-0", iconColor)} />
        <p className="text-sm font-semibold text-foreground truncate flex-1">
          {insight.headline}
        </p>
        <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2">{insight.sublabel}</p>
    </Link>
  );
}

// deriveInsights ranks signals into 0–4 cards. Order matters — critical first,
// then biggest mover, then quality, then exploration nudges. Keeping this as
// a pure function (no hooks) makes the logic unit-testable later.
function deriveInsights({
  overview,
  prior,
  moversByModel,
  openEvents,
  range,
}: {
  overview: { total_cost_usd: number; total_calls: number; error_rate_pct: number; avg_latency_ms: number; p99_latency_ms: number } | null;
  prior: { total_cost_usd: number; total_calls: number; error_rate_pct: number; p99_latency_ms: number } | null;
  moversByModel: Array<{ key: string; current_cost_usd: number; prior_cost_usd: number; delta_cost_usd: number; pct_change: number; is_new?: boolean; current_calls: number; prior_calls: number; current_p99_ms: number; prior_p99_ms: number; delta_p99_ms: number }>;
  openEvents: Array<{ id: string; rule_name: string; message: string }>;
  range: { from: Date; to: Date };
}): Insight[] {
  const out: Insight[] = [];
  const qs = `from=${range.from.toISOString()}&to=${range.to.toISOString()}`;

  // ── 1. Open alerts (always top if any are firing) ──────────────────────
  if (openEvents.length > 0) {
    const first = openEvents[0];
    out.push({
      id: "alerts",
      severity: "alert",
      headline:
        openEvents.length === 1
          ? `${first.rule_name} is firing`
          : `${openEvents.length} alerts firing`,
      sublabel:
        openEvents.length === 1
          ? first.message
          : `${first.rule_name}${openEvents.length > 1 ? ` + ${openEvents.length - 1} more` : ""}`,
      href: "/dashboard/alerts",
      icon: AlertTriangle,
    });
  }

  // ── 2. Cost mover — biggest contributor when overall cost shifted ──────
  // Skip when prior is below a $0.01 noise floor — a couple of stray events
  // in the prior window with $0.0003 cost vs a normal $2 current produces
  // "Cost up 700000%" which is mathematically right and uselessly loud.
  // Matches the noiseFloor on handler/top_movers.go. Pure-zero prior is
  // already guarded by the `> 0` check.
  const COST_PRIOR_NOISE_FLOOR = 0.01;
  if (overview && prior && prior.total_cost_usd > COST_PRIOR_NOISE_FLOOR) {
    const delta = overview.total_cost_usd - prior.total_cost_usd;
    const pct = (delta / prior.total_cost_usd) * 100;
    if (Math.abs(pct) >= COST_PCT_THRESHOLD && Math.abs(delta) >= COST_ABS_THRESHOLD) {
      const direction = pct > 0 ? "up" : "down";
      // Find biggest model contributor among movers.
      const topMover = [...moversByModel].sort(
        (a, b) => Math.abs(b.delta_cost_usd) - Math.abs(a.delta_cost_usd),
      )[0];
      const sub = topMover && Math.abs(topMover.delta_cost_usd) >= COST_ABS_THRESHOLD
        ? `${topMover.key} drove ${money(Math.abs(topMover.delta_cost_usd))} of the change`
        : `${money(Math.abs(delta))} change vs prior period`;
      out.push({
        id: "cost",
        severity: pct > 0 ? "watch" : "info",
        headline: `Cost ${direction} ${Math.abs(pct).toFixed(0)}%`,
        sublabel: sub,
        href: `/dashboard/spend?${qs}`,
        icon: pct > 0 ? TrendingUp : TrendingDown,
      });
    }
  }

  // ── 3. Error rate — absolute threshold (right-now health) ──────────────
  if (overview && overview.error_rate_pct >= ERROR_RATE_THRESHOLD) {
    const isCritical = overview.error_rate_pct >= ERROR_RATE_CRITICAL;
    out.push({
      id: "errors",
      severity: isCritical ? "alert" : "watch",
      headline: `${overview.error_rate_pct.toFixed(1)}% error rate`,
      sublabel: isCritical
        ? "Well above healthy threshold — investigate which calls are failing."
        : "Above healthy threshold — worth a look at error traces.",
      href: `/dashboard/traces?status=error&${qs}`,
      icon: AlertCircle,
    });
  }

  // ── 4. P99 latency regression on a specific model ──────────────────────
  // Use top movers to find the model whose p99 jumped most. Only surface
  // when both the relative jump AND absolute latency are meaningful.
  const p99Mover = [...moversByModel]
    .filter((m) => m.prior_p99_ms > 0 && m.current_p99_ms >= 500)
    .map((m) => ({
      ...m,
      p99Pct: ((m.current_p99_ms - m.prior_p99_ms) / m.prior_p99_ms) * 100,
    }))
    .filter((m) => m.p99Pct >= P99_PCT_THRESHOLD)
    .sort((a, b) => b.p99Pct - a.p99Pct)[0];
  if (p99Mover) {
    out.push({
      id: "p99",
      severity: "watch",
      headline: `${p99Mover.key} p99 +${p99Mover.p99Pct.toFixed(0)}%`,
      sublabel: `Now ${Math.round(p99Mover.current_p99_ms)}ms (was ${Math.round(p99Mover.prior_p99_ms)}ms). Latency regression on this model.`,
      href: `/dashboard/traces?model=${encodeURIComponent(p99Mover.key)}&${qs}`,
      icon: Zap,
    });
  }

  // ── 5. New model appeared this window ─────────────────────────────────
  // Use the explicit `is_new` boolean. The old pct_change === -1 check
  // collided with real -1% deltas.
  const newModel = moversByModel.find((m) => m.is_new === true && m.current_calls >= 10);
  if (newModel && out.length < 4) {
    out.push({
      id: "new-model",
      severity: "info",
      headline: `New: ${newModel.key}`,
      sublabel: `${newModel.current_calls.toLocaleString()} calls · ${money(newModel.current_cost_usd)} — first activity in this window.`,
      href: `/dashboard/traces?model=${encodeURIComponent(newModel.key)}&${qs}`,
      icon: Compass,
    });
  }

  // ── 6. Big single-model cost concentration (info only if no other insights yet) ─────
  if (out.length === 0 && overview && overview.total_cost_usd >= 1 && moversByModel.length > 0) {
    const dominantModel = [...moversByModel].sort((a, b) => b.current_cost_usd - a.current_cost_usd)[0];
    const share = dominantModel.current_cost_usd / overview.total_cost_usd;
    if (share >= 0.5) {
      out.push({
        id: "concentration",
        severity: "info",
        headline: `${dominantModel.key} = ${(share * 100).toFixed(0)}% of cost`,
        sublabel: `${money(dominantModel.current_cost_usd)} of ${money(overview.total_cost_usd)} this window. Worth knowing for cost optimization.`,
        href: `/dashboard/spend?${qs}`,
        icon: DollarSign,
      });
    }
  }

  return out.slice(0, 4);
}
