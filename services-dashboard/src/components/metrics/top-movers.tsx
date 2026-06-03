"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useTopMovers } from "@/lib/queries/use-top-movers";
import type { BreakdownDimension } from "@/lib/queries/use-breakdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface TopMoversProps {
  orgId: string;
  from: Date;
  to: Date;
  groupBy: BreakdownDimension;
  enabled: boolean;
}

function money(n: number): string {
  const abs = Math.abs(n);
  const d = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: d }).format(n);
}

// Map dim → traces filter URL param (same as the Cost explorer drill-down).
function dimUrlParam(dim: BreakdownDimension, key: string): string | null {
  if (!key) return null;
  switch (dim) {
    case "model":       return `model=${encodeURIComponent(key)}`;
    case "feature":     return `feature_name=${encodeURIComponent(key)}`;
    case "provider":    return `provider=${encodeURIComponent(key)}`;
    case "user":        return `user_id=${encodeURIComponent(key)}`;
    case "environment": return `environment=${encodeURIComponent(key)}`;
  }
}

export function TopMovers({ orgId, from, to, groupBy, enabled }: TopMoversProps) {
  const { data, isLoading } = useTopMovers({ orgId, from, to, groupBy, limit: 10 }, enabled);
  const rows = data?.rows ?? [];

  // Split into rises and falls — most useful when shown separately. Already sorted
  // by abs(delta_cost) desc on the backend, so we just partition.
  const rises = rows.filter((r) => r.delta_cost_usd > 0).slice(0, 5);
  const falls = rows.filter((r) => r.delta_cost_usd < 0).slice(0, 5);

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium">
          Top movers <span className="text-muted-foreground font-normal">vs prior {humanize(data?.window_seconds)}</span>
        </CardTitle>
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
          by {groupBy}
        </span>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No comparable activity in the prior window.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <MoverList title="Biggest cost increases" rows={rises} direction="up" groupBy={groupBy} />
            <MoverList title="Biggest cost decreases" rows={falls} direction="down" groupBy={groupBy} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function humanize(seconds: number | undefined): string {
  if (!seconds) return "prior period";
  if (seconds <= 60 * 60) return "hour";
  if (seconds <= 24 * 3600) return "day";
  if (seconds <= 7 * 24 * 3600) return "week";
  return "period";
}

interface MoverListProps {
  title: string;
  rows: NonNullable<ReturnType<typeof useTopMovers>["data"]>["rows"];
  direction: "up" | "down";
  groupBy: BreakdownDimension;
}

function MoverList({ title, rows, direction, groupBy }: MoverListProps) {
  const Arrow = direction === "up" ? ArrowUp : ArrowDown;
  // Up in cost = bad (paying more). Down in cost = good (paying less).
  const arrowColor = direction === "up" ? "text-red-400" : "text-emerald-400";

  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
        {title}
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">None.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const param = dimUrlParam(groupBy, r.key);
            const href = param ? `/dashboard/traces?${param}` : null;
            // Use is_new boolean. Backend still emits pct_change=-1 as a
            // legacy sentinel for very old clients, but THIS code is shipped
            // alongside the backend that emits is_new, so the two paths are
            // always in sync. Insights strip uses the same check.
            const pctLabel =
              r.is_new
                ? "new"
                : Number.isFinite(r.pct_change)
                  ? `${r.pct_change >= 0 ? "+" : ""}${r.pct_change.toFixed(0)}%`
                  : "—";
            const inner = (
              <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-sm">
                <span className="font-mono text-xs truncate">{r.key || "(none)"}</span>
                <span className={cn("inline-flex items-center gap-1 tabular-nums font-medium", arrowColor)}>
                  <Arrow className="h-3 w-3" />
                  {money(r.delta_cost_usd)}
                  <span className="text-[10px] text-muted-foreground font-normal">
                    ({pctLabel})
                  </span>
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                  {r.current_calls.toLocaleString()} calls
                  {r.delta_p99_ms !== 0 && Math.abs(r.delta_p99_ms) > 50 && (
                    <span className={cn("ml-1.5", r.delta_p99_ms > 0 ? "text-amber-400" : "text-emerald-400")}>
                      p99 {r.delta_p99_ms > 0 ? "+" : ""}{Math.round(r.delta_p99_ms)}ms
                    </span>
                  )}
                </span>
              </div>
            );
            return (
              <li key={r.key || "__none__"}>
                {href ? (
                  <Link href={href} className="block hover:bg-muted/40 rounded px-1.5 -mx-1.5 py-0.5 transition-colors">
                    {inner}
                  </Link>
                ) : (
                  <div className="px-1.5 -mx-1.5 py-0.5">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
