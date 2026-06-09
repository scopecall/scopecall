"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowUpDown, Coins, FileText, Layers, RefreshCw, Users } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { money, num, NULL_SENTINEL } from "@/lib/format";
import { useOrgId } from "@/lib/org-context";
import { useApiError } from "@/hooks/use-api-error";
import { useOverview } from "@/lib/queries/use-overview";
import { useBreakdown, type BreakdownDimension } from "@/lib/queries/use-breakdown";
import { useCostConfidence } from "@/lib/queries/use-cost-confidence";
import { ConfidenceBar, Delta } from "../_components/viz";
import { globalScopeQuery, useTimeRange } from "../_lib/use-time-range";
import { CustomersView } from "./_views/customers-view";
import { PromptsView } from "./_views/prompts-view";

// Spend is the precise, table-first attribution surface: a cross-dimensional
// pivot over the five real breakdown dims. (Workflow is NOT a breakdown dim —
// workflow attribution lives in the Overview treemap → /workflows/[name] detail
// route, per the redesign brief.) The Δ-colored cost treemap is owned by the
// Overview's "Where the money goes"; here the share-of-cost bars carry the
// visual weight so we never fabricate a per-row delta the breakdown lacks.
const DIMENSIONS: { key: BreakdownDimension; label: string }[] = [
  { key: "model", label: "Model" },
  { key: "provider", label: "Provider" },
  { key: "feature", label: "Feature" },
  { key: "user", label: "User" },
  { key: "environment", label: "Environment" },
];

// Breakdown dim → the v2 Traces filter param a row drills into. Short names
// match the Overview's DIM_TRACE_PARAM and the #24 Traces filter contract
// (feature/model/provider/user/environment — NOT the classic's feature_name).
const DIM_TRACE_PARAM: Record<BreakdownDimension, string> = {
  model: "model",
  provider: "provider",
  feature: "feature",
  user: "user",
  customer: "customer",
  environment: "environment",
};

// Empty key is meaningful only for nullable dims (feature/user/customer) → IS NULL.
const NULLABLE: ReadonlySet<BreakdownDimension> = new Set(["feature", "user", "customer"]);

const COST_NOISE_FLOOR = 0.01; // matches Overview + handler/top_movers.go

// Spend is the cost command-center: one topline summary band, then three
// attribution lenses. Breakdown is the cross-dim pivot; Customers and Prompts
// fold in the surfaces the v2 IA promised ("Cost/Customers/Prompts collapse
// into Spend"). Each lens owns its own query so only the visible one fetches.
type SpendView = "breakdown" | "customers" | "prompts";

const SPEND_VIEWS: { key: SpendView; label: string; icon: typeof Layers }[] = [
  { key: "breakdown", label: "Breakdown", icon: Layers },
  { key: "customers", label: "Customers", icon: Users },
  { key: "prompts", label: "Prompts", icon: FileText },
];

type SortKey = "cost" | "calls" | "avg" | "errors";

export default function V2SpendPage() {
  const orgId = useOrgId();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { from, to, label, env } = useTimeRange();

  // The active lens is URL-backed (?view=) so it's deep-linkable and shareable:
  // the retired /dashboard/customers and /dashboard/prompts URLs redirect
  // straight to their tab here, and browser back/forward steps between lenses.
  // Breakdown is the default and carries no param.
  const viewParam = sp.get("view");
  const view: SpendView = SPEND_VIEWS.some((v) => v.key === viewParam)
    ? (viewParam as SpendView)
    : "breakdown";
  const setView = (next: SpendView) => {
    const params = new URLSearchParams(sp.toString());
    if (next === "breakdown") params.delete("view");
    else params.set("view", next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const [dimension, setDimension] = useState<BreakdownDimension>("model");
  // Optional secondary dim — when set, rows are primary × secondary combos.
  const [secondary, setSecondary] = useState<BreakdownDimension | undefined>(undefined);
  const [sortBy, setSortBy] = useState<SortKey>("cost");

  const enabled = !!orgId;
  const oid = orgId ?? "";

  // Prior window for the headline delta — same convention as the Overview.
  const span = to.getTime() - from.getTime();
  const priorFrom = new Date(from.getTime() - span);
  const priorTo = from;

  const cur = useOverview({ orgId: oid, from, to }, enabled);
  const prev = useOverview({ orgId: oid, from: priorFrom, to: priorTo }, enabled);
  const conf = useCostConfidence({ orgId: oid, from, to, unknownLimit: 8 }, enabled);
  const breakdown = useBreakdown(
    { orgId: oid, from, to, groupBy: dimension, secondaryGroupBy: secondary, limit: 100 },
    enabled && view === "breakdown",
  );
  useApiError(breakdown.error, breakdown.refetch);

  // Gate the whole page on the *overview* query, whose key ignores
  // dim/secondary/sort — so changing breakdown controls never flashes the page
  // to skeleton; only the table body reskeletons.
  //
  // Gate on isPending (not isLoading): against a down backend, retry:1 leaves a
  // backoff gap where isLoading=false / isError=false / data=undefined, which
  // would otherwise leak a misleading "$0.00" frame before the error settles.
  // isPending stays true across the whole retry sequence until data or a final
  // error, so we hold the skeleton, then flip straight to ErrorState.
  if (!orgId || cur.isPending) return <SpendSkeleton />;
  if (cur.isError) {
    return (
      <ErrorState
        message="Couldn't load spend for this window."
        onRetry={() => cur.refetch()}
      />
    );
  }

  // ── Headline ────────────────────────────────────────────────────────────
  const spend = cur.data?.total_cost_usd ?? 0;
  const priorSpend = prev.data?.total_cost_usd ?? 0;
  const hasPrior = priorSpend > COST_NOISE_FLOOR;
  const deltaPct = hasPrior ? ((spend - priorSpend) / priorSpend) * 100 : 0;
  const calls = cur.data?.total_calls ?? 0;
  const avgPerCall = calls > 0 ? spend / calls : 0;

  // Cost-confidence bar split — same source→category mapping as the Overview.
  const verifiedPct = conf.data?.verified_pct ?? null;
  const confBar = (() => {
    const cats = { verified: 0, estimated: 0, unknown: 0 };
    for (const s of conf.data?.sources ?? []) {
      if (s.source === "server_computed") cats.verified += s.pct_of_cost;
      else if (s.source === "sdk_fallback") cats.estimated += s.pct_of_cost;
      else cats.unknown += s.pct_of_cost; // unknown_model + container + future
    }
    return {
      verified: cats.verified / 100,
      estimated: cats.estimated / 100,
      unknown: cats.unknown / 100,
    };
  })();
  const unknownModels = conf.data?.unknown_models ?? [];

  // ── Breakdown rows + client-side sort ─────────────────────────────────────
  const rows = breakdown.data?.rows ?? [];
  const sorted = [...rows].sort((a, b) => {
    switch (sortBy) {
      case "calls":
        return b.calls - a.calls;
      case "avg":
        return b.avg_cost_per_call - a.avg_cost_per_call;
      case "errors":
        return b.error_count - a.error_count;
      case "cost":
      default:
        return b.total_cost_usd - a.total_cost_usd; // API already cost-desc
    }
  });
  const maxPct = Math.max(1, ...sorted.map((r) => r.pct_of_total));
  const breakdownTotal = breakdown.data?.total_cost_usd ?? 0;
  const breakdownCalls = breakdown.data?.total_calls ?? 0;

  const dimLabel = DIMENSIONS.find((d) => d.key === dimension)!.label;
  const secondaryLabel = secondary ? DIMENSIONS.find((d) => d.key === secondary)!.label : "";
  const colCount = secondary ? 7 : 6;

  // Drill builder — classic cost-page semantics, adapted to v2 param names +
  // the active global scope (window/env follow the user into Traces). Empty
  // keys on nullable dims become NULL_SENTINEL; empty keys on non-nullable dims
  // can't be drilled (null → row not clickable).
  const scope = globalScopeQuery(sp);
  const drillHref = (key: string, key2?: string): string | null => {
    const parts: string[] = [];
    const add = (d: BreakdownDimension, v: string): boolean => {
      const isNone = v === "";
      if (isNone && !NULLABLE.has(d)) return false;
      parts.push(`${DIM_TRACE_PARAM[d]}=${encodeURIComponent(isNone ? NULL_SENTINEL : v)}`);
      return true;
    };
    if (!add(dimension, key)) return null;
    if (secondary && key2 !== undefined && !add(secondary, key2)) return null;
    const sep = scope ? "&" : "?";
    return `/dashboard/traces${scope}${sep}${parts.join("&")}`;
  };

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Spend</h1>
        <p className="text-xs text-muted-foreground">
          Cost, attribution &amp; confidence · {label}
        </p>
      </div>

      {/* ── Summary band ── */}
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card p-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Total spend
            </p>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-3xl font-semibold tabular-nums">{money(spend)}</span>
              {hasPrior && <Delta pct={deltaPct} direction="up-is-bad" />}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              {hasPrior ? <>vs {money(priorSpend)} prior period</> : <>no prior period to compare</>}
            </p>
          </div>

          <div>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
              Cost confidence
            </p>
            {conf.isLoading ? (
              <div className="h-7 w-full rounded bg-muted/30 animate-pulse" />
            ) : (
              <>
                <ConfidenceBar
                  verified={confBar.verified}
                  estimated={confBar.estimated}
                  unknown={confBar.unknown}
                />
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  {verifiedPct != null ? (
                    <>
                      <span className="text-emerald-400 font-medium tabular-nums">
                        {verifiedPct.toFixed(0)}%
                      </span>{" "}
                      server-verified
                    </>
                  ) : (
                    "cost confidence unavailable"
                  )}
                </p>
              </>
            )}
          </div>

          <div>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Volume
            </p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums">{num(calls)}</span>
              <span className="text-[11px] text-muted-foreground">calls</span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              <span className="text-foreground font-medium tabular-nums">{money(avgPerCall)}</span> avg / call
            </p>
          </div>
        </div>
      </section>

      {/* ── View switcher: the three cost-attribution lenses ── */}
      <div
        role="tablist"
        aria-label="Spend view"
        className="inline-flex items-center border border-border rounded-md p-0.5"
      >
        {SPEND_VIEWS.map((v) => (
          <button
            key={v.key}
            role="tab"
            aria-selected={view === v.key}
            onClick={() => setView(v.key)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition-colors focus-ring",
              view === v.key
                ? "bg-surface-active text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
            )}
          >
            <v.icon className="h-3.5 w-3.5" />
            {v.label}
          </button>
        ))}
      </div>

      {view === "customers" && <CustomersView orgId={oid} from={from} to={to} scope={scope} />}
      {view === "prompts" && <PromptsView orgId={oid} from={from} to={to} env={env} scope={scope} />}

      {view === "breakdown" && (
        <>
      {/* ── Breakdown controls ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider">Break down by</span>
        <div
          role="tablist"
          aria-label="Break down spend by"
          className="inline-flex items-center border border-border rounded-md p-0.5"
        >
          {DIMENSIONS.map((d) => (
            <button
              key={d.key}
              role="tab"
              aria-selected={dimension === d.key}
              onClick={() => {
                setDimension(d.key);
                if (secondary === d.key) setSecondary(undefined); // never primary == secondary
              }}
              className={cn(
                "px-2.5 py-1 text-xs rounded transition-colors focus-ring",
                dimension === d.key
                  ? "bg-surface-active text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
        {/* "×" — pivot-table cross-tab convention */}
        <span className="text-xs text-muted-foreground">×</span>
        <select
          value={secondary ?? ""}
          onChange={(e) => setSecondary((e.target.value || undefined) as BreakdownDimension | undefined)}
          aria-label="Cross-tabulate by a second dimension"
          className="rounded-md border border-input bg-background px-2.5 py-1 text-xs h-7 focus:outline-none focus:border-ring"
        >
          <option value="">none</option>
          {DIMENSIONS.filter((d) => d.key !== dimension).map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {/* ── Pivot table ── */}
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card overflow-hidden">
        <div className="px-4 pt-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold">
              By {dimLabel}
              {secondary ? ` × ${secondaryLabel}` : ""}
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {secondary
                ? "Cross-dim view scans raw calls. Click a row to see its traces."
                : "Ranked by spend in this window. Click a row to see its traces."}
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-medium tabular-nums">{money(breakdownTotal)}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider tabular-nums">
              {num(breakdownCalls)} calls
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/20 text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">{dimLabel}</th>
                {secondary && <th className="px-3 py-2 text-left font-medium">{secondaryLabel}</th>}
                <SortHeader label="Calls" sortKey="calls" active={sortBy} onSort={setSortBy} />
                <SortHeader label="Cost" sortKey="cost" active={sortBy} onSort={setSortBy} />
                <SortHeader
                  label="Avg / call"
                  sortKey="avg"
                  active={sortBy}
                  onSort={setSortBy}
                  className="hidden sm:table-cell"
                />
                <th className="px-3 py-2 text-left font-medium w-[26%] hidden md:table-cell">
                  Share of cost
                </th>
                <SortHeader label="Errors" sortKey="errors" active={sortBy} onSort={setSortBy} />
              </tr>
            </thead>
            <tbody>
              {breakdown.isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {Array.from({ length: colCount }).map((_, j) => (
                      <td key={j} className="px-3 py-2.5">
                        <div className="h-4 w-full rounded bg-muted/30 animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : breakdown.isError ? (
                <tr>
                  <td colSpan={colCount} className="px-3 py-10 text-center">
                    <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-2" />
                    <p className="text-sm text-foreground">Couldn&apos;t load this breakdown.</p>
                    <button
                      onClick={() => breakdown.refetch()}
                      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3")}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </button>
                  </td>
                </tr>
              ) : sorted.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-3 py-12 text-center">
                    <Coins className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-foreground">No cost data in this window</p>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Try widening the range, or pick a different dimension to group by.
                    </p>
                  </td>
                </tr>
              ) : (
                sorted.map((r) => {
                  const href = drillHref(r.key, r.key2);
                  const labelText = r.key === "" ? "(none)" : r.key;
                  const label2 = (r.key2 ?? "") === "" ? "(none)" : r.key2;
                  return (
                    <tr
                      key={`${r.key}|${r.key2 ?? ""}`}
                      onClick={href ? () => router.push(href) : undefined}
                      className={cn(
                        "border-b border-border last:border-0",
                        href ? "row-interactive" : "",
                      )}
                    >
                      <td className="px-3 py-2.5 font-mono text-xs">
                        {href ? (
                          <Link
                            href={href}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`View traces for ${labelText}`}
                            className="inline-flex items-center gap-1.5 rounded-sm hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {labelText}
                            <span className="text-muted-foreground" aria-hidden>
                              →
                            </span>
                          </Link>
                        ) : (
                          labelText
                        )}
                      </td>
                      {secondary && (
                        <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{label2}</td>
                      )}
                      <td className="px-3 py-2.5 text-right tabular-nums">{num(r.calls)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                        {money(r.total_cost_usd)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground hidden sm:table-cell">
                        {money(r.avg_cost_per_call)}
                      </td>
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-[#5B54E8]"
                              style={{ width: `${(r.pct_of_total / maxPct) * 100}%` }}
                            />
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
        <p className="px-4 py-3 border-t border-border text-[11px] text-muted-foreground">
          {secondary
            ? "Cross-dim view always scans raw calls (the rollup lacks user/environment)."
            : "Model, provider and feature read the pre-aggregated hourly rollup; user and environment scan raw calls."}
        </p>
      </section>

      {/* ── Fix your cost confidence — unknown-model punch list ── */}
      {unknownModels.length > 0 && (
        <section className="rounded-xl ring-1 ring-foreground/10 bg-card p-4">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> Fix your cost confidence
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5 mb-3">
            These models are missing from your pricing table, so their spend can&apos;t be
            server-verified. Add them in <span className="text-foreground">Settings → Pricing</span>.
          </p>
          <ul className="space-y-1">
            {unknownModels.map((m) => (
              <li
                key={`${m.provider}/${m.model}`}
                className="flex items-center justify-between gap-3 px-2 py-2 rounded border border-border bg-muted/20 text-xs"
              >
                <code className="text-foreground">{m.model || "(unnamed)"}</code>
                <span className="text-muted-foreground tabular-nums">
                  {m.provider || "unknown provider"} · {num(m.calls)} calls
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
        </>
      )}
    </div>
  );
}

// ── Local presentational components ─────────────────────────────────────────

function SortHeader({
  label,
  sortKey,
  active,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const isActive = active === sortKey;
  return (
    <th className={cn("px-3 py-2 text-right font-medium", className)}>
      <button
        onClick={() => onSort(sortKey)}
        aria-pressed={isActive}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground rounded-sm focus-ring",
          isActive && "text-foreground",
        )}
      >
        {label}
        {isActive ? (
          <span aria-hidden>↓</span>
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
        )}
      </button>
    </th>
  );
}

function SpendSkeleton() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="h-6 w-24 rounded bg-muted/30 animate-pulse" />
        <div className="h-3 w-72 rounded bg-muted/30 animate-pulse" />
      </div>
      <div className="h-28 rounded-xl bg-muted/30 animate-pulse" />
      <div className="h-8 w-96 max-w-full rounded bg-muted/30 animate-pulse" />
      <div className="h-96 rounded-xl bg-muted/30 animate-pulse" />
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
      <button
        onClick={onRetry}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}
      >
        <RefreshCw className="h-3.5 w-3.5" /> Retry
      </button>
    </div>
  );
}
