"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Coins,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { money, num } from "@/lib/format";
import { useOrgId } from "@/lib/org-context";
import { useOverview } from "@/lib/queries/use-overview";
import { useCostConfidence } from "@/lib/queries/use-cost-confidence";
import { useWasteInbox, type WasteItem, type WasteKind } from "@/lib/queries/use-waste-inbox";
import { useTopMovers } from "@/lib/queries/use-top-movers";
import { useWorkflowCostTree } from "@/lib/queries/use-workflow-cost-tree";
import {
  useCostMetrics,
  useErrorMetrics,
  useLatencyMetrics,
} from "@/lib/queries/use-metrics";
import { FirstRunDashboard } from "@/components/overview/first-run";
import { AreaChart, ConfidenceBar, CostBars, Delta, Sparkline, type TreeNode } from "./_components/viz";
import { globalScopeQuery, useTimeRange } from "./_lib/use-time-range";

// "workflow" is special: it's NOT a breakdown/top-movers dimension. Real
// workflow attribution comes from useWorkflowCostTree (trace_id ⇒ workflow-span
// join), and a tile drills into the dedicated workflow detail route rather than
// into Traces. The other dims come from useTopMovers and drill into Traces.
type MoversDim = "feature" | "model" | "provider" | "user";
type TreemapDim = "workflow" | MoversDim;
const TREEMAP_TABS: { dim: TreemapDim; label: string }[] = [
  { dim: "workflow", label: "Workflow" },
  { dim: "feature", label: "Feature" },
  { dim: "model", label: "Model" },
  { dim: "provider", label: "Provider" },
  { dim: "user", label: "User" },
];
function isMoversDim(d: TreemapDim): d is MoversDim {
  return d !== "workflow";
}
// Movers dimension → the Traces filter param a tile drills into.
const DIM_TRACE_PARAM: Record<MoversDim, string> = {
  feature: "feature",
  model: "model",
  provider: "provider",
  user: "user",
};

const COST_NOISE_FLOOR = 0.01; // matches insights-strip + handler/top_movers.go

export default function V2OverviewPage() {
  const orgId = useOrgId();
  const { from, to, granularity, label } = useTimeRange();
  const router = useRouter();
  const sp = useSearchParams();
  const [treemapDim, setTreemapDim] = useState<TreemapDim>("workflow");
  const [showAllWaste, setShowAllWaste] = useState(false);

  const enabled = !!orgId;
  const oid = orgId ?? "";

  // The Workflow tab draws from useWorkflowCostTree; the rest from useTopMovers.
  // `moversDim` is a safe placeholder when the workflow tab is active (its query
  // is disabled), so useTopMovers always gets a valid breakdown dimension.
  const isWorkflowTab = !isMoversDim(treemapDim);
  const moversDim: MoversDim = isMoversDim(treemapDim) ? treemapDim : "feature";

  // Prior window for deltas — same convention as the live insights strip.
  const span = to.getTime() - from.getTime();
  const priorFrom = new Date(from.getTime() - span);
  const priorTo = from;

  const cur = useOverview({ orgId: oid, from, to }, enabled);
  const prev = useOverview({ orgId: oid, from: priorFrom, to: priorTo }, enabled);
  const conf = useCostConfidence({ orgId: oid, from, to }, enabled);
  const wasteQ = useWasteInbox({ orgId: oid, from, to }, enabled);
  const moversFeature = useTopMovers({ orgId: oid, from, to, groupBy: "feature", limit: 8 }, enabled);
  const moversTreemap = useTopMovers(
    { orgId: oid, from, to, groupBy: moversDim, limit: 14 },
    enabled && !isWorkflowTab,
  );
  const workflowTree = useWorkflowCostTree(
    { orgId: oid, from, to, limit: 14 },
    enabled && isWorkflowTab,
  );
  const costSeries = useCostMetrics({ orgId: oid, from, to, granularity }, enabled);
  const latSeries = useLatencyMetrics({ orgId: oid, from, to, granularity }, enabled);
  const errSeries = useErrorMetrics({ orgId: oid, from, to, granularity }, enabled);

  // ── Page-level gates (only the headline query blocks the whole page) ──────
  if (!orgId || cur.isLoading) return <OverviewSkeleton />;
  if (cur.isError) {
    return (
      <ErrorState
        message="Couldn't load overview metrics for this window."
        onRetry={() => cur.refetch()}
      />
    );
  }
  if (cur.data && cur.data.total_calls === 0) {
    return <FirstRunDashboard orgId={oid} onFirstCall={() => cur.refetch()} />;
  }

  // ── Derived headline numbers ──────────────────────────────────────────────
  const spend = cur.data?.total_cost_usd ?? 0;
  const priorSpend = prev.data?.total_cost_usd ?? 0;
  const hasPrior = priorSpend > COST_NOISE_FLOOR;
  const deltaAbs = spend - priorSpend;
  const deltaPct = hasPrior ? (deltaAbs / priorSpend) * 100 : 0;

  const errorRatePct = cur.data?.error_rate_pct ?? 0;
  const errorDeltaPp = errorRatePct - (prev.data?.error_rate_pct ?? 0);
  const p99Ms = cur.data?.p99_latency_ms ?? 0;
  const priorP99 = prev.data?.p99_latency_ms ?? 0;
  const p99Down = priorP99 > 0 && p99Ms < priorP99;
  const calls = cur.data?.total_calls ?? 0;

  // Cost-confidence: headline % + the verified/estimated/unknown bar split.
  const verifiedPct = conf.data?.verified_pct ?? null;
  const confBar = (() => {
    const cats = { verified: 0, estimated: 0, unknown: 0 };
    for (const s of conf.data?.sources ?? []) {
      if (s.source === "server_computed") cats.verified += s.pct_of_cost;
      else if (s.source === "sdk_fallback") cats.estimated += s.pct_of_cost;
      else cats.unknown += s.pct_of_cost; // unknown_model + container + future
    }
    return { verified: cats.verified / 100, estimated: cats.estimated / 100, unknown: cats.unknown / 100 };
  })();

  // Waste inbox. Items arrive ranked by savings; show the top few by default
  // and let the user reveal the rest (the backend already caps the list at 15).
  const wasteItems = wasteQ.data?.items ?? [];
  const wasteCeiling = wasteQ.data?.total_savings_usd ?? 0;
  const WASTE_TOP = 5;
  const visibleWaste = showAllWaste ? wasteItems : wasteItems.slice(0, WASTE_TOP);
  const hiddenWaste = wasteItems.length - visibleWaste.length;

  // Biggest driver + "what changed" both come from feature movers.
  const featRows = moversFeature.data?.rows ?? [];
  const driver = [...featRows].sort((a, b) => b.delta_cost_usd - a.delta_cost_usd)[0];
  const hasDriver = driver && driver.delta_cost_usd > COST_NOISE_FLOOR;
  const whatChanged = [...featRows]
    .filter((r) => Math.abs(r.delta_cost_usd) > COST_NOISE_FLOOR)
    .sort((a, b) => Math.abs(b.delta_cost_usd) - Math.abs(a.delta_cost_usd))
    .slice(0, 6);

  // Treemap nodes (size = current cost, color = Δ vs prior). The Workflow tab
  // sources real workflow rollups; other tabs source top-movers rows. Both map
  // to the same TreeNode shape; `value` carries the raw dimension value to drill
  // on (workflow name / movers key) — "" stays "" so we can skip drilling the
  // Unattributed bucket.
  const treeNodes: TreeNode[] = isWorkflowTab
    ? (workflowTree.data?.workflows ?? []).map((w) => ({
        name: w.name || "Unattributed",
        value: w.name,
        cost: w.current_cost_usd,
        pct: w.is_new ? 0 : w.pct_change,
        isNew: w.is_new,
        // The "" bucket has no workflow detail page to open — mark it
        // non-drillable and say why, instead of a dead → on the biggest row.
        note: w.name ? undefined : "no workflow span",
      }))
    : (moversTreemap.data?.rows ?? []).map((r) => ({
        name: r.key || "(unattributed)",
        value: r.key,
        cost: r.current_cost_usd,
        pct: r.is_new ? 0 : r.pct_change,
        isNew: r.is_new,
        note: r.key ? undefined : `no ${moversDim} on these calls`,
      }));
  const treeTotal = treeNodes.reduce((s, n) => s + n.cost, 0);
  const treemapLoading = isWorkflowTab ? workflowTree.isLoading : moversTreemap.isLoading;

  // Time series for the area chart + secondary sparks.
  const costPoints = costSeries.data?.points ?? [];
  const spendData = costPoints.map((p) => p.total_cost_usd ?? 0);
  const spendLabels = buildLabels(costPoints, granularity);
  const p99Data = (latSeries.data?.points ?? []).map((p) => p.p99_latency_ms ?? 0);
  const errData = (errSeries.data?.points ?? []).map((p) => p.error_count ?? 0);

  const drill = (param: string, value: string) => {
    const scope = globalScopeQuery(sp);
    const sep = scope ? "&" : "?";
    router.push(`/dashboard/traces${scope}${sep}${param}=${encodeURIComponent(value)}`);
  };

  // Workflow tiles open the dedicated workflow detail route, carrying scope.
  // The Unattributed bucket (name "") has no detail page, so it's a no-op.
  const drillWorkflow = (name: string) => {
    if (!name) return;
    router.push(`/dashboard/workflows/${encodeURIComponent(name)}${globalScopeQuery(sp)}`);
  };

  return (
    <div className="space-y-4">
      {/* ── ROW 1 · THE ANSWER ─────────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-xl ring-1 ring-foreground/10 bg-card">
        <div className="absolute inset-0 bg-gradient-to-br from-[#5B54E8]/[0.12] via-transparent to-transparent pointer-events-none" />
        <div className="absolute left-0 inset-y-0 w-1 bg-gradient-to-b from-[#2563EB] via-[#5B54E8] to-[#8B5CF6]" />
        <div className="relative p-5 pl-6">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
            The answer · {label}
          </p>
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-4xl font-semibold tabular-nums leading-none">{money(spend)}</span>
            {hasPrior && <Delta pct={deltaPct} direction="up-is-bad" />}
            <span className="text-sm text-muted-foreground">
              {hasPrior ? (
                <>
                  spent, {deltaAbs >= 0 ? "up" : "down"} {money(Math.abs(deltaAbs))} vs the prior period
                </>
              ) : (
                <>spent · no prior period to compare</>
              )}
            </span>
          </div>

          {hasDriver ? (
            <p className="mt-3 text-[15px] leading-relaxed max-w-3xl">
              Biggest driver:{" "}
              <button
                onClick={() => drill("feature", driver.key)}
                className="font-medium text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid"
              >
                {driver.key || "(unattributed)"}
              </button>{" "}
              <span className="text-red-400 font-medium tabular-nums">
                +{money(driver.delta_cost_usd)}
              </span>{" "}
              <span className="text-muted-foreground">— {driverReason(driver)}.</span>
            </p>
          ) : (
            <p className="mt-3 text-[15px] leading-relaxed max-w-3xl text-muted-foreground">
              No single feature dominated the change — spend held fairly steady across the board.
            </p>
          )}

          {verifiedPct != null && (
            <div className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-2 rounded-full bg-emerald-400" />
              <span className="text-foreground font-medium tabular-nums">{verifiedPct.toFixed(0)}%</span>{" "}
              of this spend is server-verified
            </div>
          )}

          <div className="mt-4 flex items-center gap-2 flex-wrap">
            {wasteCeiling > 0 && (
              <a href="#waste" className={cn(buttonVariants({ variant: "default", size: "sm" }))}>
                Fix the waste · up to {money(wasteCeiling)}
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            )}
            <a href="#changed" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              What changed
              <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </section>

      {/* ── ROW 2 · THREE DECISION TILES ───────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* SPEND */}
        <Tile label="Spend" accent="brand">
          <div className="flex items-end justify-between gap-2">
            <span className="text-2xl font-semibold tabular-nums leading-none">{money(spend)}</span>
            {hasPrior && <Delta pct={deltaPct} direction="up-is-bad" />}
          </div>
          {spendData.length > 1 && (
            <div className="mt-2 opacity-70">
              <Sparkline data={spendData} />
            </div>
          )}
          <div className="mt-3">
            <ConfidenceBar
              verified={confBar.verified}
              estimated={confBar.estimated}
              unknown={confBar.unknown}
              showLegend={false}
            />
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {verifiedPct != null ? (
                <>
                  <span className="text-emerald-400 font-medium tabular-nums">
                    {verifiedPct.toFixed(0)}%
                  </span>{" "}
                  verified spend
                </>
              ) : (
                "cost confidence unavailable"
              )}
            </p>
          </div>
        </Tile>

        {/* WASTE */}
        <Tile label="Reclaimable waste" accent="amber">
          <div className="flex items-end justify-between gap-2">
            <span className="text-2xl font-semibold tabular-nums leading-none text-amber-300">
              {wasteCeiling > 0 ? `up to ${money(wasteCeiling)}` : money(0)}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {wasteItems.length > 0
              ? `${wasteItems.length} findings · retries · wrong model · errors`
              : "No waste detected in this window"}
          </p>
          <a
            href="#waste"
            className="mt-4 inline-flex items-center gap-1 text-xs text-foreground hover:underline"
          >
            Review findings <ArrowRight className="h-3 w-3" />
          </a>
        </Tile>

        {/* ERROR RATE */}
        <Tile label="Error rate" accent="neutral">
          <div className="flex items-end justify-between gap-2">
            <span className="text-2xl font-semibold tabular-nums leading-none">
              {errorRatePct.toFixed(1)}%
            </span>
            {Math.abs(errorDeltaPp) >= 0.05 && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 text-[11px] tabular-nums font-medium",
                  errorDeltaPp > 0 ? "text-red-400" : "text-emerald-400",
                )}
              >
                {errorDeltaPp > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {errorDeltaPp > 0 ? "+" : ""}
                {errorDeltaPp.toFixed(1)}pp
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">across all calls</p>
          <div className="mt-3 flex items-center gap-4 text-xs">
            <span className="inline-flex items-center gap-1">
              <span className="text-muted-foreground">p99</span>
              <span className="font-medium tabular-nums">{(p99Ms / 1000).toFixed(1)}s</span>
              {p99Down && <TrendingDown className="h-3 w-3 text-emerald-400" />}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="text-muted-foreground">calls</span>
              <span className="font-medium tabular-nums">{num(calls)}</span>
            </span>
          </div>
        </Tile>
      </div>

      {/* ── ROW 3 · WHAT CHANGED + WASTE INBOX ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* What changed */}
        <section id="changed" className="rounded-xl ring-1 ring-foreground/10 bg-card">
          <div className="px-4 pt-4 pb-2">
            <h2 className="text-sm font-semibold">What changed</h2>
            <p className="text-[11px] text-muted-foreground">
              vs the prior period · biggest money moves first
            </p>
          </div>
          {moversFeature.isLoading ? (
            <RowsSkeleton />
          ) : whatChanged.length === 0 ? (
            <EmptyRow text="No notable cost moves in this window." />
          ) : (
            <ul className="px-2 pb-2">
              {whatChanged.map((c) => (
                <ChangeRow
                  key={c.key}
                  name={c.key || "(unattributed)"}
                  amount={Math.abs(c.delta_cost_usd)}
                  up={c.delta_cost_usd > 0}
                  isNew={c.is_new}
                  note={`${num(c.current_calls)} calls · was ${money(c.prior_cost_usd)}`}
                  onClick={() => drill("feature", c.key)}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Waste Inbox */}
        <section id="waste" className="rounded-xl ring-1 ring-foreground/10 bg-card">
          <div className="px-4 pt-4 pb-2 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-amber-400" /> Waste Inbox
                <span className="text-[10px] font-normal border border-border rounded px-1.5 py-0 h-4 inline-flex items-center">
                  {wasteItems.length}
                </span>
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Specific spend you could cut today, ranked by savings
              </p>
            </div>
            {wasteCeiling > 0 && (
              <div className="text-right shrink-0">
                <div className="text-sm font-semibold tabular-nums text-amber-300">
                  up to {money(wasteCeiling)}
                </div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  potential
                </div>
              </div>
            )}
          </div>
          {wasteQ.isLoading ? (
            <RowsSkeleton />
          ) : wasteItems.length === 0 ? (
            <EmptyRow text="Nothing wasteful detected — nice." />
          ) : (
            <ul className="px-2 pb-2 space-y-1">
              {visibleWaste.map((w, i) => (
                <WasteRow key={i} item={w} onOpenTraces={drill} scope={globalScopeQuery(sp)} />
              ))}
              {hiddenWaste > 0 && (
                <li>
                  <button
                    onClick={() => setShowAllWaste(true)}
                    className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground py-1.5 rounded row-interactive"
                  >
                    Show {hiddenWaste} more
                  </button>
                </li>
              )}
              {showAllWaste && wasteItems.length > WASTE_TOP && (
                <li>
                  <button
                    onClick={() => setShowAllWaste(false)}
                    className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground py-1.5 rounded row-interactive"
                  >
                    Show less
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>
      </div>

      {/* ── ROW 4 · WHERE THE MONEY GOES ───────────────────────────────────── */}
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card">
        <div className="px-4 pt-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold">Where the money goes</h2>
            <p className="text-[11px] text-muted-foreground">
              Ranked by cost · bar = share of total · ▲▼ = Δ vs prior ·{" "}
              {isWorkflowTab ? "click to open the workflow" : "click to drill into Traces"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div
              role="tablist"
              aria-label="Group spend by"
              className="inline-flex items-center border border-border rounded-md p-0.5"
            >
              {TREEMAP_TABS.map((t) => (
                <button
                  key={t.dim}
                  role="tab"
                  aria-selected={treemapDim === t.dim}
                  onClick={() => setTreemapDim(t.dim)}
                  className={cn(
                    "px-2.5 py-1 text-xs rounded transition-colors focus-ring",
                    treemapDim === t.dim
                      ? "bg-surface-active text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="text-right">
              <div className="text-sm font-medium tabular-nums">{money(treeTotal)}</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">total</div>
            </div>
          </div>
        </div>
        <div className="px-3 pb-3">
          {treemapLoading ? (
            <div className="flex flex-col gap-2 px-2.5 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-9 rounded-md bg-muted/30 animate-pulse" />
              ))}
            </div>
          ) : (
            <CostBars
              nodes={treeNodes}
              drillLabel={isWorkflowTab ? "Click to open this workflow" : "Click to drill into Traces"}
              canSelect={(n) => !!n.value}
              onSelect={(n) =>
                isWorkflowTab
                  ? drillWorkflow(n.value ?? n.name)
                  : drill(DIM_TRACE_PARAM[moversDim], n.value ?? n.name)
              }
            />
          )}
        </div>
        <div className="px-4 pb-4 flex items-center gap-4 text-[10px] text-muted-foreground flex-wrap">
          <LegendSwatch className="bg-emerald-500/40" label="cheaper" />
          <LegendSwatch className="bg-muted/60" label="≈ stable" />
          <LegendSwatch className="bg-amber-500/40" label="pricier" />
          <LegendSwatch className="bg-red-500/50" label="much pricier" />
          <LegendSwatch className="bg-purple-500/40" label="new" />
        </div>
      </section>

      {/* ── ROW 5 · SPEND OVER TIME ────────────────────────────────────────── */}
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card">
        <div className="px-4 pt-4 pb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Spend over time</h2>
          <span className="text-xs text-muted-foreground tabular-nums">
            {money(spend)} · {label.replace(/^Last /, "")}
          </span>
        </div>
        <div className="px-4 pb-3">
          {costSeries.isLoading ? (
            <div className="h-[140px] rounded-md bg-muted/30 animate-pulse" />
          ) : (
            <AreaChart data={spendData} labels={spendLabels} formatValue={money} />
          )}
        </div>
        <div className="px-4 pb-4 pt-3 border-t border-border grid grid-cols-2 gap-4">
          <SecondarySpark
            label="Errors"
            data={errData}
            color="#ef4444"
            value={`${errorRatePct.toFixed(1)}%`}
          />
          <SecondarySpark
            label="p99 latency"
            data={p99Data}
            color="#f59e0b"
            value={`${(p99Ms / 1000).toFixed(1)}s`}
          />
        </div>
        <div className="px-4 pb-4 -mt-2">
          <Link
            href={`/dashboard/health${globalScopeQuery(sp)}`}
            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            See latency &amp; errors in Health <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </section>
    </div>
  );
}

// ── Local presentational components ─────────────────────────────────────────

function Tile({
  label,
  accent,
  children,
}: {
  label: string;
  accent: "brand" | "amber" | "neutral";
  children: React.ReactNode;
}) {
  const bar =
    accent === "brand" ? "bg-[#5B54E8]" : accent === "amber" ? "bg-amber-400" : "bg-muted-foreground/40";
  return (
    <div className="relative overflow-hidden rounded-xl ring-1 ring-foreground/10 bg-card p-4">
      <div className={cn("absolute left-0 inset-y-0 w-0.5", bar)} />
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
        {label}
      </p>
      {children}
    </div>
  );
}

function iconFor(kind: WasteKind) {
  switch (kind) {
    case "retry_burner":
      return <RefreshCw className="h-3.5 w-3.5" />;
    case "model_misuse":
      return <Coins className="h-3.5 w-3.5" />;
    case "high_error_workflow":
      return <ShieldAlert className="h-3.5 w-3.5" />;
    default:
      return <AlertTriangle className="h-3.5 w-3.5" />;
  }
}

function severityCls(sev: WasteItem["severity"]): string {
  switch (sev) {
    case "high":
      return "border-red-500/40 bg-red-500/5 text-red-300";
    case "medium":
      return "border-amber-500/40 bg-amber-500/5 text-amber-300";
    default:
      return "border-border text-muted-foreground";
  }
}

function WasteRow({
  item,
  onOpenTraces,
  scope,
}: {
  item: WasteItem;
  onOpenTraces: (param: string, value: string) => void;
  scope: string;
}) {
  const [open, setOpen] = useState(false);
  // Drill target: prefer the most specific dimension present on the finding.
  // item.workflow is a workflow name → the workflow Traces filter, NOT feature
  // (feature_name is the per-call/step label, a different column).
  const drill = () => {
    if (item.workflow) onOpenTraces("workflow", item.workflow);
    else if (item.model) onOpenTraces("model", item.model);
  };
  const canDrill = !!(item.workflow || item.model);
  void scope; // scope is folded in by onOpenTraces via the page's drill()
  return (
    <li>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded row-interactive"
      >
        <span
          className={cn(
            "shrink-0 mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded border",
            severityCls(item.severity),
          )}
        >
          {iconFor(item.kind)}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs font-medium">{item.headline}</span>
            {item.severity === "high" && (
              <span className="text-[10px] py-0 px-1 h-4 inline-flex items-center rounded border border-red-500/40 text-red-300">
                high
              </span>
            )}
          </span>
          <span className="block text-[11px] text-muted-foreground mt-0.5">
            Save up to{" "}
            <span className="text-amber-300 font-medium tabular-nums">
              {money(item.potential_savings_usd)}
            </span>{" "}
            in this window
          </span>
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
        )}
      </button>
      {open && (
        <div className="ml-10 mr-2 mb-2 mt-0.5 p-2.5 rounded border border-border bg-muted/20 text-[11px] space-y-2">
          <p className="text-muted-foreground">{item.detail}</p>
          <p>
            <span className="text-foreground font-medium">What to do:</span>{" "}
            <span className="text-muted-foreground">{item.recommendation}</span>
          </p>
          {canDrill && (
            <button
              onClick={drill}
              className="text-[11px] text-foreground hover:underline inline-flex items-center gap-1"
            >
              Open in Traces <ArrowRight className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function ChangeRow({
  name,
  amount,
  up,
  isNew,
  note,
  onClick,
}: {
  name: string;
  amount: number;
  up: boolean;
  isNew?: boolean;
  note: string;
  onClick: () => void;
}) {
  const Icon = isNew ? AlertTriangle : up ? TrendingUp : TrendingDown;
  const iconColor = isNew ? "text-purple-300" : up ? "text-red-400" : "text-emerald-400";
  return (
    <li>
      <button
        onClick={onClick}
        className="w-full text-left flex items-center gap-3 px-2 py-2 rounded row-interactive group"
      >
        <Icon className={cn("h-4 w-4 shrink-0", iconColor)} />
        <span className="flex-1 min-w-0">
          <span className="text-xs font-medium">
            {name}
            {isNew && (
              <span className="ml-1.5 text-[10px] text-purple-300 border border-purple-400/40 rounded px-1 py-0">
                new
              </span>
            )}
          </span>
          <span className="block text-[11px] text-muted-foreground truncate">{note}</span>
        </span>
        <span
          className={cn("text-xs font-medium tabular-nums", up ? "text-red-300" : "text-emerald-300")}
        >
          {up ? "+" : "−"}
          {money(amount)}
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </button>
    </li>
  );
}

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

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2.5 rounded-sm", className)} />
      {label}
    </span>
  );
}

// Volume-vs-unit-cost attribution for the hero's driver line. Honest + derivable
// from top-movers fields — no guessing at root cause.
function driverReason(d: {
  is_new?: boolean;
  current_calls: number;
  prior_calls: number;
  current_p99_ms: number;
  prior_p99_ms: number;
}): string {
  if (d.is_new) return "new this window";
  const callGrowth = d.prior_calls > 0 ? (d.current_calls - d.prior_calls) / d.prior_calls : null;
  if (callGrowth != null && callGrowth > 0.15) {
    return `call volume up ${(callGrowth * 100).toFixed(0)}%`;
  }
  if (d.prior_p99_ms > 0 && (d.current_p99_ms - d.prior_p99_ms) / d.prior_p99_ms > 0.3) {
    return "latency regression";
  }
  return "higher cost per call";
}

// ── States ──────────────────────────────────────────────────────────────────

function OverviewSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-32 rounded-xl bg-muted/30 animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="h-28 rounded-xl bg-muted/30 animate-pulse" />
        <div className="h-28 rounded-xl bg-muted/30 animate-pulse" />
        <div className="h-28 rounded-xl bg-muted/30 animate-pulse" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="h-48 rounded-xl bg-muted/30 animate-pulse" />
        <div className="h-48 rounded-xl bg-muted/30 animate-pulse" />
      </div>
      <div className="h-80 rounded-xl bg-muted/30 animate-pulse" />
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

function EmptyRow({ text }: { text: string }) {
  return <p className="px-4 pb-5 pt-1 text-[11px] text-muted-foreground">{text}</p>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-8 text-center">
      <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-3" />
      <p className="text-sm text-foreground">{message}</p>
      <p className="text-[11px] text-muted-foreground mt-1">
        The API may be unreachable, or this org has no data for the window.
      </p>
      <button
        onClick={onRetry}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}
      >
        <RefreshCw className="h-3.5 w-3.5" /> Retry
      </button>
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
