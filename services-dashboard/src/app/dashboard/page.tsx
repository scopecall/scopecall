"use client";

import { useMemo, useState } from "react";
import { useOverview } from "@/lib/queries/use-overview";
import { useCostMetrics } from "@/lib/queries/use-metrics";
import { useErrorsByStatus } from "@/lib/queries/use-errors-by-status";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { StatCards } from "@/components/overview/stat-cards";
import { SDKHealthCard } from "@/components/overview/sdk-health-card";
import { FirstRunDashboard } from "@/components/overview/first-run";
import { useSDKHealth } from "@/lib/queries/use-sdk-health";
import { OverviewInsights } from "@/components/overview/insights-strip";
import { RegressionsPanel } from "@/components/overview/regressions-panel";
import { WasteInbox } from "@/components/overview/waste-inbox";
import { WorkflowTreemap } from "@/components/overview/workflow-treemap";
import { CostConfidenceCard } from "@/components/overview/cost-confidence-card";
import { TopMovers } from "@/components/metrics/top-movers";
import { VolumeChart } from "@/components/metrics/volume-chart";
import { CostChart } from "@/components/metrics/cost-chart";
import { LatencyChart } from "@/components/metrics/latency-chart";
import { StatusErrorsChart } from "@/components/metrics/status-errors-chart";
import { DateRangePicker, type DateRange } from "@/components/shared/date-range-picker";
import { useOrgId } from "@/lib/org-context";
import { cn } from "@/lib/utils";

type Granularity = "hour" | "day";

function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from, to };
}

function priorRange(r: DateRange): DateRange {
  const duration = r.to.getTime() - r.from.getTime();
  return { from: new Date(r.from.getTime() - duration), to: r.from };
}

// EmptyStateHint was the inline two-pre block here; superseded by
// `FirstRunDashboard` (components/overview/first-run.tsx) which takes over
// the entire Overview when the org has zero traces — full hero, 3-language
// tabs, copy buttons, and live polling. Removed here intentionally.

export default function OverviewPage() {
  useDocumentTitle("Overview");
  const orgId = useOrgId();
  const [range, setRange] = useState(defaultRange);
  const [granularity, setGranularity] = useState<Granularity>("hour");
  const prior = useMemo(() => priorRange(range), [range]);
  const enabled = !!orgId;

  // When switching to Daily, auto-expand to 7d so there's enough buckets to be
  // useful (a 24h window with daily granularity = 1 bar = not informative).
  function changeGranularity(g: Granularity) {
    setGranularity(g);
    if (g === "day") {
      const to = new Date();
      const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
      setRange({ from, to });
    } else {
      // Snap back to last 24h on Hourly. Users can adjust the date picker after.
      const to = new Date();
      const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
      setRange({ from, to });
    }
  }

  const current = useOverview({ orgId: orgId ?? "", from: range.from, to: range.to }, enabled);
  const priorQ = useOverview({ orgId: orgId ?? "", from: prior.from, to: prior.to }, enabled);
  const metrics = useCostMetrics({ orgId: orgId ?? "", from: range.from, to: range.to, granularity }, enabled);
  const errors = useErrorsByStatus({ orgId: orgId ?? "", from: range.from, to: range.to, granularity }, enabled);

  useApiError(current.error ?? metrics.error ?? errors.error, current.refetch);

  // First-run takeover. Driven by SDK health — `has_calls=false` means the
  // org has never sent a call (in the last 7 days). NOT by `total_calls===0`
  // in the dashboard's current window, which would deadlock the user on the
  // install screen when their SDK is working but their latest call is
  // outside the active range (3-day-old data + "last 24h" range = stuck).
  const sdkHealth = useSDKHealth(orgId ?? "", enabled);
  const isFirstRun =
    enabled && !sdkHealth.isLoading && sdkHealth.data?.has_calls === false;
  if (isFirstRun) {
    return (
      <div className="space-y-4 max-w-3xl mx-auto">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold">Overview</h1>
          <p className="text-xs text-muted-foreground">
            AI cost across workflows, agents, and customers
          </p>
        </div>
        <FirstRunDashboard
          orgId={orgId ?? ""}
          // refetch the SDK health query when the first call is detected;
          // when has_calls flips true, the takeover condition flips false
          // and the real dashboard renders.
          onFirstCall={sdkHealth.refetch}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Overview</h1>
            <span className="text-xs text-muted-foreground hidden sm:inline">
              Click any chart bar to drill in · Click a legend item to hide/show that series
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            AI cost across workflows, agents, and customers
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Granularity segmented control. Switching to Daily auto-widens to 7d. */}
          <div className="inline-flex items-center border border-border rounded-md p-0.5">
            <button
              onClick={() => changeGranularity("hour")}
              className={cn(
                "px-2.5 py-1 text-xs rounded transition-colors",
                granularity === "hour"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Hourly
            </button>
            <button
              onClick={() => changeGranularity("day")}
              className={cn(
                "px-2.5 py-1 text-xs rounded transition-colors",
                granularity === "day"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Daily
            </button>
          </div>
          <DateRangePicker value={range} onChange={setRange} granularity={granularity} />
        </div>
      </div>

      {/* SDK health — the "is my data flowing?" anchor card. Sits above
          KPI tiles so a user installing the SDK sees their first call land
          before they read anything else. */}
      <SDKHealthCard orgId={orgId ?? ""} />

      {/* "What should I look at" — 0-4 ranked insight cards. Picks the
          starting workflow for the user instead of dumping six pages of
          pages on them. Empty/quiet state nudges to Flow Map. */}
      <OverviewInsights
        orgId={orgId ?? ""}
        from={range.from}
        to={range.to}
        enabled={enabled}
      />

      {/* Auto-detected regressions — surfaces "this metric just got worse"
          without the user configuring rules. Hidden when nothing notable. */}
      <RegressionsPanel
        orgId={orgId ?? ""}
        from={range.from}
        to={range.to}
        enabled={enabled}
      />

      {/* Waste Inbox — deterministic-rule findings ranked by dollar impact.
          Hides itself when there's nothing to report (same convention as
          RegressionsPanel) so a clean org doesn't see noise. */}
      <WasteInbox
        orgId={orgId ?? ""}
        from={range.from}
        to={range.to}
        enabled={enabled}
      />

      <StatCards
        data={current.data ?? null}
        prior={priorQ.data ?? null}
        series={metrics.data?.points ?? []}
        isLoading={current.isLoading}
        error={current.error}
      />

      {/* Workflow cost treemap — the "where is the money going?" anchor for
          v0.3 cost attribution. Tile area is proportional to cost in the
          current window; color is the delta vs the equivalent prior window.
          Click a tile to drill into Traces filtered by that workflow's
          feature_name. Empty state nudges users to wrap calls in
          sdk.workflow() so cost gets attributed. */}
      <WorkflowTreemap
        orgId={orgId ?? ""}
        from={range.from}
        to={range.to}
        enabled={enabled}
      />

      {/* Cost confidence — sits directly below the treemap because the
          natural question after seeing the workflow cost breakdown is
          "can I trust these numbers?". Hides itself on empty windows. */}
      <CostConfidenceCard
        orgId={orgId ?? ""}
        from={range.from}
        to={range.to}
        enabled={enabled}
      />

      <TopMovers
        orgId={orgId ?? ""}
        from={range.from}
        to={range.to}
        groupBy="model"
        enabled={enabled}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <VolumeChart data={metrics.data?.points ?? []} isLoading={metrics.isLoading} error={metrics.error} granularity={granularity} />
        <CostChart data={metrics.data?.points ?? []} isLoading={metrics.isLoading} error={metrics.error} granularity={granularity} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LatencyChart data={metrics.data?.points ?? []} isLoading={metrics.isLoading} error={metrics.error} granularity={granularity} />
        <StatusErrorsChart data={errors.data?.points ?? []} isLoading={errors.isLoading} error={errors.error} granularity={granularity} />
      </div>
    </div>
  );
}
