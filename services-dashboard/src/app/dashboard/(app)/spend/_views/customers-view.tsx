"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  FlaskConical,
  RefreshCw,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import {
  useCustomerProfitability,
  type CustomerProfitabilityRow,
} from "@/lib/queries/use-customer-profitability";
import { useApiError } from "@/hooks/use-api-error";
import { buttonVariants } from "@/components/ui/button";
import { money, num } from "@/lib/format";
import { cn } from "@/lib/utils";

// Customer profitability — the "who is costing us money, and is any of it
// waste?" lens. Ported from the classic /dashboard/customers page into the v2
// Spend surface (the layout's "Customers collapse into Spend" promise). Reads
// the same /api/v1/customer-profitability endpoint; restyled to the v2 card
// idiom and drills into v2 Traces via the ?customer= filter.

// Display name — strips a leading "customer_" so the dense list reads cleaner.
function displayName(id: string): string {
  return id.startsWith("customer_") ? id.slice("customer_".length) : id;
}

export function CustomersView({
  orgId,
  from,
  to,
  scope,
}: {
  orgId: string;
  from: Date;
  to: Date;
  /** Global scope query ("" or "?…") so the active window/env follow the drill. */
  scope: string;
}) {
  const router = useRouter();
  const enabled = !!orgId;
  const { data, isLoading, isError, error, refetch } = useCustomerProfitability(
    { orgId, from, to, limit: 50 },
    enabled,
  );
  useApiError(error, refetch);

  const grand = data?.grand_total_cost_usd ?? 0;
  const attributed = data?.attributed_cost_usd ?? 0;
  const unattributed = data?.unattributed_cost_usd ?? 0;
  const attribPct = grand > 0 ? (attributed / grand) * 100 : 0;
  const rows = data?.rows ?? [];

  // Top retry-cost offender — the single most actionable signal. Only surfaced
  // when retries are a non-trivial fraction (>5%) of that customer's spend.
  const retryOffender = rows
    .filter((r) => r.current_cost_usd > 0 && r.retry_cost_usd / r.current_cost_usd > 0.05)
    .sort((a, b) => b.retry_cost_usd - a.retry_cost_usd)[0];

  // Drill into v2 Traces scoped to this customer, carrying the global window/env.
  const drillHref = (customerId: string): string => {
    const sep = scope ? "&" : "?";
    return `/dashboard/traces${scope}${sep}customer=${encodeURIComponent(customerId)}`;
  };

  if (isError) {
    return (
      <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-8 text-center">
        <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-3" />
        <p className="text-sm text-foreground">Couldn&apos;t load customer profitability.</p>
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
      {/* ── Attribution coverage banner — the page is misleading below 50% ── */}
      {!isLoading && grand > 0 && attribPct < 50 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-300 mt-0.5 shrink-0" />
          <div className="text-xs leading-relaxed">
            <span className="text-amber-200 font-medium">
              Only {attribPct.toFixed(0)}% of spend is attributed to a customer.
            </span>{" "}
            <span className="text-muted-foreground">
              Pass{" "}
              <code className="px-1 py-0.5 mx-0.5 rounded bg-muted text-foreground">customer_id</code>{" "}
              to{" "}
              <code className="px-1 py-0.5 mx-0.5 rounded bg-muted text-foreground">sdk.workflow()</code>{" "}
              so per-customer cost rolls up correctly. The remaining{" "}
              <span className="text-foreground tabular-nums">{money(unattributed)}</span> is invisible
              here.
            </span>
          </div>
        </div>
      )}

      {/* ── Attribution stat tiles ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Coverage"
          value={grand > 0 ? `${attribPct.toFixed(0)}%` : "—"}
          subtitle={
            grand > 0
              ? `${data?.attributed_customer_count ?? 0} customers attributed`
              : "no cost in window"
          }
          tone={attribPct >= 80 ? "green" : attribPct >= 50 ? "neutral" : "amber"}
          loading={isLoading}
        />
        <StatTile
          label="Attributed"
          value={money(attributed)}
          subtitle="rolled up to a customer_id"
          loading={isLoading}
        />
        <StatTile
          label="Unattributed"
          value={money(unattributed)}
          subtitle="no customer_id"
          tone={unattributed > 0 ? "amber" : "neutral"}
          loading={isLoading}
        />
        <StatTile
          label="Top customer"
          value={rows[0] ? money(rows[0].current_cost_usd) : "—"}
          subtitle={
            rows[0]
              ? `${displayName(rows[0].customer_id)} · ${rows[0].pct_of_attributed.toFixed(0)}% of attributed`
              : undefined
          }
          tone={rows[0] && rows[0].pct_of_attributed > 60 ? "red" : "neutral"}
          loading={isLoading}
        />
      </div>

      {/* ── Retry offender banner ── */}
      {retryOffender && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 flex items-start gap-2">
          <RefreshCw className="h-4 w-4 text-red-300 mt-0.5 shrink-0" />
          <div className="text-xs leading-relaxed">
            <span className="text-red-200 font-medium">
              {displayName(retryOffender.customer_id)}: {money(retryOffender.retry_cost_usd)} wasted on
              retries
            </span>{" "}
            <span className="text-muted-foreground">
              ({((retryOffender.retry_cost_usd / retryOffender.current_cost_usd) * 100).toFixed(0)}% of
              this customer&apos;s spend). Drill in to find the failing step.
            </span>
          </div>
        </div>
      )}

      {/* ── Per-customer table ── */}
      <section className="rounded-xl ring-1 ring-foreground/10 bg-card overflow-hidden">
        <div className="px-4 pt-4 pb-3">
          <h2 className="text-sm font-semibold">By customer</h2>
          <p className="text-[11px] text-muted-foreground">
            Ranked by spend in this window. Click a row to see that customer&apos;s traces.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/20 text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Customer</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium hidden sm:table-cell">Δ vs prior</th>
                <th className="px-3 py-2 text-left font-medium w-[20%] hidden md:table-cell">
                  Share of attributed
                </th>
                <th className="px-3 py-2 text-right font-medium hidden lg:table-cell">Calls</th>
                <th className="px-3 py-2 text-right font-medium hidden lg:table-cell">Workflows</th>
                <th className="px-3 py-2 text-right font-medium">Waste</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-3 py-2.5">
                        <div className="h-4 w-full rounded bg-muted/30 animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center">
                    <Users className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-foreground">No customer-attributed traffic</p>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Pass{" "}
                      <code className="px-1 py-0.5 rounded bg-muted text-foreground">customer_id</code>{" "}
                      to{" "}
                      <code className="px-1 py-0.5 rounded bg-muted text-foreground">sdk.workflow()</code>{" "}
                      to populate this view.
                    </p>
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <CustomerRow key={r.customer_id} row={r} href={drillHref(r.customer_id)} router={router} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ── Local presentational components ─────────────────────────────────────────

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

function CustomerRow({
  row,
  href,
  router,
}: {
  row: CustomerProfitabilityRow;
  href: string;
  router: ReturnType<typeof useRouter>;
}) {
  const retryPct = row.current_cost_usd > 0 ? (row.retry_cost_usd / row.current_cost_usd) * 100 : 0;
  const testPct = row.current_cost_usd > 0 ? (row.test_cost_usd / row.current_cost_usd) * 100 : 0;
  const clean = retryPct === 0 && testPct === 0;

  return (
    <tr onClick={() => router.push(href)} className="border-b border-border last:border-0 row-interactive">
      <td className="px-3 py-2.5 font-mono text-xs">
        <div className="flex items-center gap-2">
          <Link
            href={href}
            onClick={(e) => e.stopPropagation()}
            aria-label={`View traces for ${displayName(row.customer_id)}`}
            className="truncate max-w-[200px] inline-flex items-center gap-1.5 rounded-sm hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {displayName(row.customer_id)}
            <span className="text-muted-foreground" aria-hidden>
              →
            </span>
          </Link>
          {row.error_count > 0 && (
            <span className="text-[9px] py-0 px-1 h-4 inline-flex items-center rounded border border-red-500/40 text-red-300">
              {row.error_count} err
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium">{money(row.current_cost_usd)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums hidden sm:table-cell">
        {row.is_new ? (
          <span className="inline-flex items-center gap-0.5 text-[#8B5CF6]">
            <Sparkles className="h-3 w-3" />
            new
          </span>
        ) : Math.abs(row.pct_change) < 1 ? (
          <span className="text-muted-foreground">≈0%</span>
        ) : row.pct_change > 0 ? (
          <span className="inline-flex items-center gap-0.5 text-red-300">
            <ArrowUp className="h-3 w-3" />
            {row.pct_change.toFixed(0)}%
          </span>
        ) : (
          <span className="inline-flex items-center gap-0.5 text-emerald-300">
            <ArrowDown className="h-3 w-3" />
            {Math.abs(row.pct_change).toFixed(0)}%
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 hidden md:table-cell">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-[#5B54E8]"
              style={{ width: `${Math.min(row.pct_of_attributed, 100)}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
            {row.pct_of_attributed.toFixed(0)}%
          </span>
        </div>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums hidden lg:table-cell text-muted-foreground">
        {num(row.current_calls)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums hidden lg:table-cell text-muted-foreground">
        <span className="inline-flex items-center gap-1 justify-end">
          <Workflow className="h-3 w-3" />
          {row.workflow_count}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right">
        <div className="inline-flex items-center gap-1.5 justify-end flex-wrap">
          {retryPct > 0 && (
            <span
              title={`Retry cost: ${money(row.retry_cost_usd)}`}
              className={cn(
                "text-[9px] py-0 px-1 h-4 inline-flex items-center gap-0.5 rounded border",
                retryPct > 5 ? "border-red-500/40 text-red-300" : "border-border text-muted-foreground",
              )}
            >
              <RefreshCw className="h-2 w-2" />
              {retryPct.toFixed(0)}%
            </span>
          )}
          {testPct > 0 && (
            <span
              title={`Test traffic: ${money(row.test_cost_usd)}`}
              className="text-[9px] py-0 px-1 h-4 inline-flex items-center gap-0.5 rounded border border-amber-500/40 text-amber-300"
            >
              <FlaskConical className="h-2 w-2" />
              {testPct.toFixed(0)}%
            </span>
          )}
          {clean && <span className="text-[10px] text-muted-foreground">clean</span>}
        </div>
      </td>
    </tr>
  );
}
