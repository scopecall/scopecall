"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useBreakdown, type BreakdownDimension } from "@/lib/queries/use-breakdown";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useOrgId } from "@/lib/org-context";
import { NULL_SENTINEL } from "@/lib/format";
import { DateRangePicker, type DateRange } from "@/components/shared/date-range-picker";
import { EmptyStateRow } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Coins } from "lucide-react";

function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from, to };
}

const DIMENSIONS: { key: BreakdownDimension; label: string }[] = [
  { key: "model", label: "Model" },
  { key: "provider", label: "Provider" },
  { key: "feature", label: "Feature" },
  { key: "user", label: "User" },
  { key: "environment", label: "Environment" },
];

function money(n: number): string {
  const d = n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: d }).format(n);
}

function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

// Map each breakdown dim to its corresponding Traces filter query param.
const DIM_PARAM: Record<BreakdownDimension, string> = {
  model: "model",
  feature: "feature_name",
  provider: "provider",
  user: "user_id",
  environment: "environment",
};

// Build a /dashboard/traces URL pre-filtered to one or two dim values.
// Empty keys for nullable dims (feature/user) become NULL_SENTINEL → IS NULL
// on the backend. Empty keys for non-nullable dims (model/provider/environment)
// shouldn't happen, but we guard with null return.
//
// `range` is REQUIRED — without it the Traces page snaps to its default 24h
// window and the drill-in shows none of the cost-page's actual traffic.
function drillHref(
  dim: BreakdownDimension,
  key: string,
  range: { from: Date; to: Date },
  secondaryDim?: BreakdownDimension,
  key2?: string,
): string | null {
  const sp = new URLSearchParams();
  const add = (d: BreakdownDimension, v: string): boolean => {
    const isNone = v === "";
    if (isNone && d !== "feature" && d !== "user") return false;
    sp.set(DIM_PARAM[d], isNone ? NULL_SENTINEL : v);
    return true;
  };
  if (!add(dim, key)) return null;
  if (secondaryDim && key2 !== undefined) {
    if (!add(secondaryDim, key2)) return null;
  }
  // Preserve the cost-page's time range so the resulting Traces view shows
  // the same calls the breakdown was computed over. The Traces page parses
  // these via rangeFromSearchParams (see app/dashboard/traces/page.tsx).
  sp.set("from", range.from.toISOString());
  sp.set("to",   range.to.toISOString());
  return `/dashboard/traces?${sp.toString()}`;
}

export default function CostPage() {
  useDocumentTitle("Cost");
  const router = useRouter();
  const orgId = useOrgId();
  const [range, setRange] = useState(defaultRange);
  const [dimension, setDimension] = useState<BreakdownDimension>("model");
  // Optional secondary dim — when set, table renders as primary × secondary combos.
  const [secondary, setSecondary] = useState<BreakdownDimension | undefined>(undefined);
  const [sortBy, setSortBy] = useState<"cost" | "calls">("cost");

  const query = useBreakdown(
    {
      orgId: orgId ?? "",
      from: range.from,
      to: range.to,
      groupBy: dimension,
      secondaryGroupBy: secondary,
      limit: 100,
    },
    !!orgId,
  );
  useApiError(query.error, query.refetch);
  const { data, isLoading } = query;

  const rows = useMemo(() => {
    const r = data?.rows ?? [];
    if (sortBy === "calls") return [...r].sort((a, b) => b.calls - a.calls);
    return r; // API already returns cost-desc
  }, [data, sortBy]);

  const maxPct = useMemo(
    () => Math.max(1, ...rows.map((r) => r.pct_of_total)),
    [rows],
  );

  const dimLabel = DIMENSIONS.find((d) => d.key === dimension)!.label;
  const secondaryLabel = secondary ? DIMENSIONS.find((d) => d.key === secondary)!.label : "";

  return (
    <div className="space-y-4">
      {/* Header + range */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Cost</h1>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            Where your spend and calls go — grouped by dimension
          </span>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {/* Primary dimension toggle + cross-dim selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 rounded-lg border border-border p-1 w-fit">
          {DIMENSIONS.map((d) => (
            <button
              key={d.key}
              onClick={() => {
                setDimension(d.key);
                // Don't let secondary == primary
                if (secondary === d.key) setSecondary(undefined);
              }}
              className={cn(
                "px-3 py-1 text-sm rounded-md transition-colors",
                dimension === d.key
                  ? "bg-muted text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              {d.label}
            </button>
          ))}
        </div>

        {/* Cross-dim toggle — "×" symbol borrowed from pivot-table convention */}
        <span className="text-sm text-muted-foreground">×</span>
        <select
          value={secondary ?? ""}
          onChange={(e) => setSecondary((e.target.value || undefined) as BreakdownDimension | undefined)}
          className="rounded-md border border-input bg-background px-2.5 py-1 text-sm h-8 focus:outline-none focus:border-ring"
        >
          <option value="">none</option>
          {DIMENSIONS.filter((d) => d.key !== dimension).map((d) => (
            <option key={d.key} value={d.key}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* Summary */}
      <div className="flex items-center gap-6 text-sm">
        <span className="text-muted-foreground">
          Total cost{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {data ? money(data.total_cost_usd) : "—"}
          </span>
        </span>
        <span className="text-muted-foreground">
          Total calls{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {data ? num(data.total_calls) : "—"}
          </span>
        </span>
      </div>

      {/* Table */}
      <div className="border border-border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">{dimLabel}</th>
              {secondary && <th className="px-3 py-2 text-left font-medium text-muted-foreground">{secondaryLabel}</th>}
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                <button onClick={() => setSortBy("calls")} className={cn("hover:text-foreground transition-colors", sortBy === "calls" && "text-foreground")}>
                  Calls {sortBy === "calls" && "↓"}
                </button>
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                <button onClick={() => setSortBy("cost")} className={cn("hover:text-foreground transition-colors", sortBy === "cost" && "text-foreground")}>
                  Total cost {sortBy === "cost" && "↓"}
                </button>
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground hidden sm:table-cell">Avg / call</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground w-[28%] hidden md:table-cell">Share of cost</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">Errors</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {Array.from({ length: secondary ? 7 : 6 }).map((_, j) => (
                    <td key={j} className="px-3 py-2.5"><Skeleton className="h-4 w-full" /></td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <EmptyStateRow
                colSpan={secondary ? 7 : 6}
                icon={Coins}
                title="No cost data in this window"
                description="Try widening the date range, or pick a different dimension to group by."
              />
            ) : (
              rows.map((r) => {
                const href = drillHref(dimension, r.key, range, secondary, r.key2);
                const label = r.key === "" ? "(none)" : r.key;
                const label2 = (r.key2 ?? "") === "" ? "(none)" : r.key2;
                return (
                  <tr
                    key={`${r.key}|${r.key2 ?? ""}`}
                    onClick={href ? () => router.push(href) : undefined}
                    className={cn(
                      "border-b border-border last:border-0 transition-colors",
                      href ? "cursor-pointer hover:bg-muted/30" : "",
                    )}
                  >
                    <td className="px-3 py-2.5 font-mono text-xs">
                      <span className="flex items-center gap-1.5">
                        {label}
                        {!secondary && href && <span className="text-muted-foreground">→</span>}
                      </span>
                    </td>
                    {secondary && (
                      <td className="px-3 py-2.5 font-mono text-xs">
                        <span className="flex items-center gap-1.5">
                          {label2}
                          {href && <span className="text-muted-foreground">→</span>}
                        </span>
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-right tabular-nums">{num(r.calls)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{money(r.total_cost_usd)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground hidden sm:table-cell">{money(r.avg_cost_per_call)}</td>
                    <td className="px-3 py-2.5 hidden md:table-cell">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${(r.pct_of_total / maxPct) * 100}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums w-12 text-right">
                          {r.pct_of_total.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.error_count > 0 ? (
                        <span className="text-red-400">{num(r.error_count)}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        {secondary
          ? "Cross-dim view always scans raw calls (rollup lacks user/env). "
          : "Model, provider and feature read the pre-aggregated hourly rollup; user and environment scan raw calls. "}
        Click any row to see its calls.
      </p>
    </div>
  );
}
