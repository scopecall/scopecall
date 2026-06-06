"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkflowCostTree, type WorkflowCostNode } from "@/lib/queries/use-workflow-cost-tree";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface Props {
  orgId: string;
  from: Date;
  to: Date;
  enabled: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Layout: recursive binary treemap
//
// Sorting workflows by cost desc, then at each step splitting the remaining
// list at the midpoint of cumulative cost. The half with greater cost-share
// gets a proportionally larger slice of the rectangle, on whichever axis is
// longer right now. This isn't the squarified algorithm — aspect ratios are
// "good enough" rather than minimal — but it's ~30 lines, deterministic,
// and easy to debug. With ≤20 workflows the tile shapes look fine.
// ───────────────────────────────────────────────────────────────────────────

interface Tile {
  node: WorkflowCostNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

function layout(items: WorkflowCostNode[], x: number, y: number, w: number, h: number): Tile[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ node: items[0], x, y, w, h }];

  const total = items.reduce((s, n) => s + n.current_cost_usd, 0);
  // Find the split point: smallest prefix whose cumulative cost reaches >=half.
  const target = total / 2;
  let acc = 0;
  let splitIdx = 0;
  for (let i = 0; i < items.length - 1; i++) {
    acc += items[i].current_cost_usd;
    if (acc >= target) {
      splitIdx = i + 1;
      break;
    }
  }
  if (splitIdx === 0) splitIdx = 1;

  const left = items.slice(0, splitIdx);
  const right = items.slice(splitIdx);
  const leftSum = left.reduce((s, n) => s + n.current_cost_usd, 0);
  const ratio = total > 0 ? leftSum / total : 0.5;

  // Split along the longer axis so children stay closer to square.
  if (w >= h) {
    const lw = w * ratio;
    return [
      ...layout(left, x, y, lw, h),
      ...layout(right, x + lw, y, w - lw, h),
    ];
  } else {
    const lh = h * ratio;
    return [
      ...layout(left, x, y, w, lh),
      ...layout(right, x, y + lh, w, h - lh),
    ];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Color: divergent scale on % change vs prior period.
//
//   < -15%   green-300  (this workflow got significantly cheaper)
//   -15..-5%  green-200
//   -5..5%   neutral / muted (≈stable)
//    5..20%  amber-300
//    20..50% orange-400
//   > 50%    red-500
//
// `is_new` (no prior baseline) gets a distinct purple tone so it can't be
// confused with "stable" zero-delta. Tailwind classes resolve from the
// existing palette so the component matches the rest of the dashboard.
// ───────────────────────────────────────────────────────────────────────────

function tileColor(node: WorkflowCostNode): { bg: string; ring: string } {
  if (node.is_new) return { bg: "fill-purple-500/30", ring: "stroke-purple-400/60" };
  const p = node.pct_change;
  if (p > 50) return { bg: "fill-red-500/40", ring: "stroke-red-400/60" };
  if (p > 20) return { bg: "fill-orange-500/35", ring: "stroke-orange-400/60" };
  if (p > 5) return { bg: "fill-amber-500/30", ring: "stroke-amber-400/60" };
  if (p < -15) return { bg: "fill-emerald-500/30", ring: "stroke-emerald-400/60" };
  if (p < -5) return { bg: "fill-emerald-500/20", ring: "stroke-emerald-400/40" };
  return { bg: "fill-muted/40", ring: "stroke-border" };
}

function money(n: number): string {
  const abs = Math.abs(n);
  const d = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: d }).format(n);
}

function pctLabel(node: WorkflowCostNode): string {
  if (node.is_new) return "new";
  const p = node.pct_change;
  if (Math.abs(p) < 1) return "≈0%";
  const sign = p > 0 ? "+" : "";
  return `${sign}${p.toFixed(0)}%`;
}

function displayName(n: WorkflowCostNode): string {
  return n.name || "Unattributed";
}

export function WorkflowTreemap({ orgId, from, to, enabled }: Props) {
  const router = useRouter();
  const { data, isLoading, error } = useWorkflowCostTree({ orgId, from, to, limit: 20 }, enabled);
  const [hover, setHover] = useState<WorkflowCostNode | null>(null);

  // Fixed viewBox keeps tile labels readable across container widths — the SVG
  // scales preserving aspect ratio via viewBox; layout math operates in
  // viewBox units, so the same numbers work whether the card is 400px or
  // 1200px wide on screen.
  const VB_W = 1000;
  const VB_H = 360;

  // Filter out zero-cost nodes (shouldn't happen with HAVING curr_cost>0 but
  // belt + suspenders) and sort desc — required for the binary split to be
  // sensible.
  const sorted = useMemo(() => {
    const rows = data?.workflows ?? [];
    return rows
      .filter((n) => n.current_cost_usd > 0)
      .sort((a, b) => b.current_cost_usd - a.current_cost_usd);
  }, [data]);

  const tiles = useMemo(() => layout(sorted, 0, 0, VB_W, VB_H), [sorted]);
  const total = data?.total_cost_usd ?? 0;

  function onTileClick(node: WorkflowCostNode) {
    // Drill into the workflow detail page — agent/step/customer/model
    // breakdowns plus retry-cost / test-traffic callouts. The page reads
    // ?from/?to off the URL so it lands on the same window the user saw.
    // When name=="" (Unattributed), skip — no useful detail page to load.
    if (!node.name) return;
    const qs = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    router.push(`/dashboard/workflows/${encodeURIComponent(node.name)}?${qs.toString()}`);
  }

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-center justify-between space-y-0">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-sm font-medium">
            Cost by workflow
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Tile size = cost · color = % change vs prior period · click to drill in
          </p>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium tabular-nums">{money(total)}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">total</div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {isLoading ? (
          <Skeleton className="h-[360px] w-full" />
        ) : error ? (
          <div className="h-[360px] flex items-center justify-center text-xs text-muted-foreground">
            Failed to load workflow cost rollup
          </div>
        ) : tiles.length === 0 ? (
          <div className="h-[360px] flex items-center justify-center text-xs text-muted-foreground">
            No workflow-tagged LLM calls in this window. Use{" "}
            <code className="px-1 py-0.5 mx-1 rounded bg-muted text-foreground">sdk.workflow(&quot;name&quot;)</code>{" "}
            to attribute cost.
          </div>
        ) : (
          <div className="relative">
            <svg
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              preserveAspectRatio="none"
              className="w-full h-[360px] block"
              onMouseLeave={() => setHover(null)}
            >
              {tiles.map((t, i) => {
                const color = tileColor(t.node);
                const isHover = hover === t.node;
                // Label thresholds — don't render text we can't read. The
                // viewBox is 1000×360, so a tile under ~80×40 won't fit a
                // workflow name; under ~140×60 we drop the secondary line.
                const showName = t.w > 80 && t.h > 40;
                const showCost = t.w > 140 && t.h > 60;
                const showPct = t.w > 100 && t.h > 50;
                const clickable = !!t.node.name;
                return (
                  <g
                    key={`${t.node.name}-${i}`}
                    onMouseEnter={() => setHover(t.node)}
                    onClick={() => onTileClick(t.node)}
                    className={cn(clickable && "cursor-pointer")}
                  >
                    <rect
                      x={t.x + 2}
                      y={t.y + 2}
                      width={Math.max(0, t.w - 4)}
                      height={Math.max(0, t.h - 4)}
                      className={cn(
                        color.bg,
                        color.ring,
                        "transition-opacity",
                        isHover ? "opacity-100" : "opacity-90",
                      )}
                      strokeWidth={1}
                    />
                    {showName && (
                      <text
                        x={t.x + 10}
                        y={t.y + 22}
                        className="fill-foreground text-[13px] font-medium"
                        style={{ pointerEvents: "none" }}
                      >
                        {displayName(t.node)}
                      </text>
                    )}
                    {showCost && (
                      <text
                        x={t.x + 10}
                        y={t.y + 40}
                        className="fill-muted-foreground text-[11px] tabular-nums"
                        style={{ pointerEvents: "none" }}
                      >
                        {money(t.node.current_cost_usd)}
                      </text>
                    )}
                    {showPct && (
                      <text
                        x={t.x + 10}
                        y={showCost ? t.y + 56 : t.y + 40}
                        className={cn(
                          "text-[10px] tabular-nums font-medium",
                          t.node.is_new
                            ? "fill-purple-300"
                            : t.node.pct_change > 20
                              ? "fill-red-300"
                              : t.node.pct_change > 5
                                ? "fill-amber-300"
                                : t.node.pct_change < -5
                                  ? "fill-emerald-300"
                                  : "fill-muted-foreground",
                        )}
                        style={{ pointerEvents: "none" }}
                      >
                        {pctLabel(t.node)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {hover && (
              <div className="absolute top-2 right-2 bg-popover border border-border rounded-md p-3 text-xs shadow-md min-w-[220px] pointer-events-none">
                <div className="font-medium text-foreground mb-1">{displayName(hover)}</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
                  <span>Cost</span>
                  <span className="text-right tabular-nums text-foreground">{money(hover.current_cost_usd)}</span>
                  <span>Prior</span>
                  <span className="text-right tabular-nums">{money(hover.prior_cost_usd)}</span>
                  <span>Δ</span>
                  <span
                    className={cn(
                      "text-right tabular-nums",
                      hover.is_new
                        ? "text-purple-300"
                        : hover.delta_cost_usd > 0
                          ? "text-red-300"
                          : hover.delta_cost_usd < 0
                            ? "text-emerald-300"
                            : "text-foreground",
                    )}
                  >
                    {hover.is_new ? "new" : `${hover.delta_cost_usd > 0 ? "+" : ""}${money(hover.delta_cost_usd)}`}
                  </span>
                  <span>Calls</span>
                  <span className="text-right tabular-nums text-foreground">{hover.current_calls.toLocaleString()}</span>
                  {hover.error_count > 0 && (
                    <>
                      <span>Errors</span>
                      <span className="text-right tabular-nums text-red-300">{hover.error_count.toLocaleString()}</span>
                    </>
                  )}
                  {hover.customer_count > 0 && (
                    <>
                      <span>Customers</span>
                      <span className="text-right tabular-nums text-foreground">{hover.customer_count}</span>
                    </>
                  )}
                  {hover.is_test_share > 0.01 && (
                    <>
                      <span>Test traffic</span>
                      <span className="text-right tabular-nums text-amber-300">
                        {(hover.is_test_share * 100).toFixed(0)}%
                      </span>
                    </>
                  )}
                </div>
                {hover.name && (
                  <div className="mt-2 pt-2 border-t border-border text-[10px] text-muted-foreground">
                    Click to drill into workflow
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
