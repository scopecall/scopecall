"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText } from "lucide-react";
import { usePrompts } from "@/lib/queries/use-prompts";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useOrgId } from "@/lib/org-context";
import { DateRangePicker, type DateRange } from "@/components/shared/date-range-picker";
import { LoadingState } from "@/components/shared/loading-state";
import { EmptyStateRow } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { money, num } from "@/lib/format";
import { cn } from "@/lib/utils";

// 7-day default — same as Sessions. Prompt versions evolve at deploy cadence;
// 24h often shows just one version even on actively-iterating teams.
function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// Sentinel string the backend emits for untagged calls (prompt_version IS NULL
// in CH → coalesced to ''). We surface this as "(untagged)" in the table so
// the user sees what fraction of traffic isn't versioned yet.
const UNTAGGED = "";

function PromptsView() {
  useDocumentTitle("Prompts");
  const orgId = useOrgId();
  const router = useRouter();
  const [range, setRange] = useState(defaultRange);

  const { data, isLoading, error, refetch } = usePrompts(
    { orgId: orgId ?? "", from: range.from, to: range.to, limit: 200 },
    !!orgId,
  );
  useApiError(error, refetch);

  const rows = data?.rows ?? [];
  // Surface totals so the user can quickly see what fraction of cost belongs
  // to each version (the row's percentage is more meaningful than the
  // absolute number when comparing across windows).
  const totalCost = rows.reduce((acc, r) => acc + r.total_cost_usd, 0);
  const totalCalls = rows.reduce((acc, r) => acc + r.calls, 0);

  // Drill-in: clicking a row navigates to Traces filtered by prompt_version.
  // The Traces page reads this URL param via WithTraceFilters (server-side)
  // and applies it like any other dimension filter. For the untagged bucket
  // we pass __null__ — the same sentinel used by Cost → drill-in to
  // "(none)" rows for missing user_id / feature_name.
  function rowHref(version: string): string {
    const sp = new URLSearchParams();
    sp.set("from", range.from.toISOString());
    sp.set("to", range.to.toISOString());
    sp.set("prompt_version", version === UNTAGGED ? "__null__" : version);
    return `/dashboard/traces?${sp.toString()}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Prompts</h1>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            Cost / latency / error rate per prompt version — click any row to drill into its traces
          </span>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {/* Headline strip — only shown once data is in. Reproduces the same
          totals the rows aggregate to, so the reader can sanity-check
          "do these rows sum to the org total?" at a glance. */}
      {!isLoading && rows.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <div className="border border-border rounded-md p-3">
            <div className="text-xs text-muted-foreground">Versions</div>
            <div className="text-lg font-semibold tabular-nums">{rows.length}</div>
          </div>
          <div className="border border-border rounded-md p-3">
            <div className="text-xs text-muted-foreground">Total cost</div>
            <div className="text-lg font-semibold tabular-nums">{money(totalCost)}</div>
          </div>
          <div className="border border-border rounded-md p-3">
            <div className="text-xs text-muted-foreground">Total calls</div>
            <div className="text-lg font-semibold tabular-nums">{num(totalCalls)}</div>
          </div>
          <div className="border border-border rounded-md p-3">
            <div className="text-xs text-muted-foreground">Untagged share</div>
            <div className="text-lg font-semibold tabular-nums">
              {(() => {
                const untagged = rows.find((r) => r.version === UNTAGGED);
                if (!untagged || totalCalls === 0) return "0%";
                return `${Math.round((untagged.calls / totalCalls) * 100)}%`;
              })()}
            </div>
          </div>
        </div>
      )}

      <div className="border border-border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Version</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">Calls</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">Cost</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground hidden sm:table-cell">% of cost</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground hidden md:table-cell">p50</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground hidden md:table-cell">p95</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground hidden lg:table-cell">Errors</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden lg:table-cell">Last seen</th>
              <th className="px-3 py-2 text-right w-10"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {Array.from({ length: 9 }).map((_, j) => (
                    <td key={j} className="px-3 py-2.5"><Skeleton className="h-4 w-full" /></td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <EmptyStateRow
                colSpan={9}
                icon={FileText}
                title="No prompt versions in this window"
                description='Tag calls with sdk.trace(name, fn, { promptVersion: "v1" }) to start tracking KPI per version. Or set defaultPromptVersion in your SDK config to tag every call with a release identifier.'
              />
            ) : (
              rows.map((r) => {
                const pct = totalCost > 0 ? (r.total_cost_usd / totalCost) * 100 : 0;
                const isUntagged = r.version === UNTAGGED;
                return (
                  <tr
                    key={r.version || "__untagged__"}
                    onClick={() => router.push(rowHref(r.version))}
                    className={cn(
                      "border-b border-border last:border-0 cursor-pointer transition-colors hover:bg-muted/30",
                      // Subtle visual de-emphasis for the untagged bucket so
                      // the eye is drawn to the real prompt versions first.
                      isUntagged && "opacity-70",
                    )}
                  >
                    <td className="px-3 py-2.5">
                      {isUntagged ? (
                        <span className="italic text-muted-foreground">(untagged)</span>
                      ) : (
                        <span className="font-mono text-xs">{r.version}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{num(r.calls)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{money(r.total_cost_usd)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                      {pct.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                      {Math.round(r.p50_latency_ms)}ms
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                      {Math.round(r.p95_latency_ms)}ms
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums hidden lg:table-cell">
                      {r.error_rate > 0 ? (
                        <span className={cn(
                          // 5%+ error rate is a flag — same threshold the
                          // Overview SDK-health card uses for the SDK
                          // health badge.
                          r.error_rate >= 0.05 ? "text-red-400" : "text-amber-400",
                        )}>
                          {(r.error_rate * 100).toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0%</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">
                      <RelativeTime date={r.last_seen} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">
                      <ArrowRight className="h-3.5 w-3.5 inline" />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Onboarding hint when we have rows but no real (non-empty) versions —
          i.e. all traffic is untagged. This is the "you have data but haven't
          tagged it yet" state, which is the main onboarding failure mode for
          this feature. */}
      {!isLoading && rows.length > 0 && rows.every((r) => r.version === UNTAGGED) && (
        <div className="rounded-md border border-dashed border-border bg-card/40 p-3 text-xs text-muted-foreground">
          <span className="text-foreground font-medium">All calls are untagged.</span>{" "}
          To unlock per-version KPI attribution, pass{" "}
          <code className="text-foreground bg-muted px-1 rounded">promptVersion</code>{" "}
          when you call{" "}
          <code className="text-foreground bg-muted px-1 rounded">sdk.trace()</code>.
        </div>
      )}
    </div>
  );
}

export default function PromptsPage() {
  return (
    <Suspense fallback={<LoadingState variant="table" rows={6} />}>
      <PromptsView />
    </Suspense>
  );
}
