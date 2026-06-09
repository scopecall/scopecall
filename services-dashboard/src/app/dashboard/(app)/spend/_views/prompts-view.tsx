"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, FileText, RefreshCw } from "lucide-react";
import { usePrompts } from "@/lib/queries/use-prompts";
import { useApiError } from "@/hooks/use-api-error";
import { RelativeTime } from "@/components/shared/relative-time";
import { buttonVariants } from "@/components/ui/button";
import { money, num, NULL_SENTINEL } from "@/lib/format";
import { cn } from "@/lib/utils";

// Per-prompt-version KPIs — cost / latency / error rate, one row per
// prompt_version. Ported from the classic /dashboard/prompts page into the v2
// Spend surface. Reads /api/v1/prompts; restyled to the v2 card idiom and
// drills into v2 Traces via the ?prompt_version= filter (added alongside this).

// Backend sentinel for untagged calls (prompt_version IS NULL → ''). Surfaced
// as "(untagged)" so users see what fraction of traffic isn't versioned yet.
const UNTAGGED = "";

export function PromptsView({
  orgId,
  from,
  to,
  env,
  scope,
}: {
  orgId: string;
  from: Date;
  to: Date;
  /** Global environment scope — filters versions to one env when set. */
  env: string | undefined;
  /** Global scope query ("" or "?…") so the active window/env follow the drill. */
  scope: string;
}) {
  const router = useRouter();
  const enabled = !!orgId;
  const { data, isLoading, isError, error, refetch } = usePrompts(
    { orgId, from, to, environment: env, limit: 200 },
    enabled,
  );
  useApiError(error, refetch);

  const rows = data?.rows ?? [];
  const totalCost = rows.reduce((acc, r) => acc + r.total_cost_usd, 0);
  const totalCalls = rows.reduce((acc, r) => acc + r.calls, 0);
  const taggedVersions = rows.filter((r) => r.version !== UNTAGGED).length;
  const untagged = rows.find((r) => r.version === UNTAGGED);
  const untaggedSharePct = untagged && totalCalls > 0 ? (untagged.calls / totalCalls) * 100 : 0;
  const costliest = rows.length ? [...rows].sort((a, b) => b.total_cost_usd - a.total_cost_usd)[0] : undefined;
  const worstError = rows
    .filter((r) => r.calls > 0 && r.error_rate > 0)
    .sort((a, b) => b.error_rate - a.error_rate)[0];
  const allUntagged = rows.length > 0 && rows.every((r) => r.version === UNTAGGED);

  const label = (version: string) => (version === UNTAGGED ? "(untagged)" : version);

  // Drill into v2 Traces filtered to this version, carrying the global window/env.
  const rowHref = (version: string): string => {
    const sep = scope ? "&" : "?";
    const v = version === UNTAGGED ? NULL_SENTINEL : version;
    return `/dashboard/traces${scope}${sep}prompt_version=${encodeURIComponent(v)}`;
  };

  if (isError) {
    return (
      <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-8 text-center">
        <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-3" />
        <p className="text-sm text-foreground">Couldn&apos;t load prompt versions.</p>
        <button
          onClick={() => refetch()}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Prompt-specific stat tiles ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Versions"
          value={isLoading ? "" : num(taggedVersions)}
          subtitle={taggedVersions === 0 ? "none tagged yet" : "tagged with promptVersion"}
          tone={taggedVersions === 0 ? "amber" : "neutral"}
          loading={isLoading}
        />
        <StatTile
          label="Untagged share"
          value={isLoading ? "" : `${untaggedSharePct.toFixed(0)}%`}
          subtitle="of calls untagged"
          tone={untaggedSharePct >= 20 ? "amber" : "neutral"}
          loading={isLoading}
        />
        <StatTile
          label="Costliest version"
          value={costliest ? money(costliest.total_cost_usd) : "—"}
          subtitle={costliest ? label(costliest.version) : undefined}
          loading={isLoading}
        />
        <StatTile
          label="Highest error rate"
          value={worstError ? `${(worstError.error_rate * 100).toFixed(1)}%` : "0%"}
          subtitle={worstError ? label(worstError.version) : "no errors in window"}
          tone={worstError && worstError.error_rate >= 0.05 ? "red" : worstError ? "amber" : "green"}
          loading={isLoading}
        />
      </div>

      {/* ── Per-version table ── */}
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card overflow-hidden">
        <div className="px-4 pt-4 pb-3">
          <h2 className="text-sm font-semibold">By prompt version</h2>
          <p className="text-[11px] text-muted-foreground">
            Cost, latency &amp; error rate per version. Click a row to see its traces.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/20 text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Version</th>
                <th className="px-3 py-2 text-right font-medium">Calls</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium hidden sm:table-cell">% of cost</th>
                <th className="px-3 py-2 text-right font-medium hidden md:table-cell">p50</th>
                <th className="px-3 py-2 text-right font-medium hidden md:table-cell">p95</th>
                <th className="px-3 py-2 text-right font-medium hidden lg:table-cell">Errors</th>
                <th className="px-3 py-2 text-left font-medium hidden lg:table-cell">Last seen</th>
                <th className="px-3 py-2 text-right w-10"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {Array.from({ length: 9 }).map((_, j) => (
                      <td key={j} className="px-3 py-2.5">
                        <div className="h-4 w-full rounded bg-muted/30 animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-12 text-center">
                    <FileText className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-foreground">No prompt versions in this window</p>
                    <p className="text-[11px] text-muted-foreground mt-1 max-w-md mx-auto">
                      Tag calls with{" "}
                      <code className="px-1 py-0.5 rounded bg-muted text-foreground">
                        sdk.trace(name, fn, {`{ promptVersion: "v1" }`})
                      </code>{" "}
                      — or set{" "}
                      <code className="px-1 py-0.5 rounded bg-muted text-foreground">defaultPromptVersion</code>{" "}
                      in your SDK config — to track KPIs per version.
                    </p>
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const pct = totalCost > 0 ? (r.total_cost_usd / totalCost) * 100 : 0;
                  const isUntagged = r.version === UNTAGGED;
                  const href = rowHref(r.version);
                  return (
                    <tr
                      key={r.version || "__untagged__"}
                      onClick={() => router.push(href)}
                      className={cn(
                        "border-b border-border last:border-0 row-interactive",
                        // De-emphasize the untagged bucket so the eye lands on
                        // real versions first.
                        isUntagged && "opacity-70",
                      )}
                    >
                      <td className="px-3 py-2.5">
                        <Link
                          href={href}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`View traces for ${label(r.version)}`}
                          className="rounded-sm hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          {isUntagged ? (
                            <span className="italic text-muted-foreground">(untagged)</span>
                          ) : (
                            <span className="font-mono text-xs">{r.version}</span>
                          )}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{num(r.calls)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                        {money(r.total_cost_usd)}
                      </td>
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
                          <span className={cn(r.error_rate >= 0.05 ? "text-red-400" : "text-amber-400")}>
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
      </section>

      {/* ── "All untagged" onboarding hint — the main first-run failure mode ── */}
      {!isLoading && allUntagged && (
        <div className="rounded-lg border border-dashed border-border bg-card/40 p-3 text-xs text-muted-foreground">
          <span className="text-foreground font-medium">All calls are untagged.</span> To unlock
          per-version KPIs, pass{" "}
          <code className="text-foreground bg-muted px-1 rounded">promptVersion</code> when you call{" "}
          <code className="text-foreground bg-muted px-1 rounded">sdk.trace()</code>.
        </div>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  subtitle,
  tone = "neutral",
  loading,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "neutral" | "red" | "amber" | "green";
  loading?: boolean;
}) {
  const toneCls = {
    neutral: "text-muted-foreground",
    red: "text-red-300",
    amber: "text-amber-300",
    green: "text-emerald-300",
  }[tone];
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {loading ? (
        <div className="h-6 w-20 mt-1.5 rounded bg-muted/30 animate-pulse" />
      ) : (
        <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      )}
      {subtitle && !loading && <div className={cn("text-[11px] mt-0.5", toneCls)}>{subtitle}</div>}
    </div>
  );
}
