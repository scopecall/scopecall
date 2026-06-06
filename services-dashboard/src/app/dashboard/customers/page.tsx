"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  ArrowDown,
  Sparkles,
  RefreshCw,
  FlaskConical,
  Workflow,
  AlertTriangle,
} from "lucide-react";
import { useCustomerProfitability, type CustomerProfitabilityRow } from "@/lib/queries/use-customer-profitability";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useOrgId } from "@/lib/org-context";
import { DateRangePicker, type DateRange } from "@/components/shared/date-range-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function money(n: number): string {
  const abs = Math.abs(n);
  const d = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: d }).format(n);
}

function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from, to };
}

// Display name — accepts customer_acme, ACME-001, etc. — strips a leading
// "customer_" if present so the dense list reads cleaner. Falls back to the
// raw id when no prefix.
function displayName(id: string): string {
  return id.startsWith("customer_") ? id.slice("customer_".length) : id;
}

export default function CustomersPage() {
  useDocumentTitle("Customers");
  const orgId = useOrgId();
  const router = useRouter();
  const [range, setRange] = useState<DateRange>(defaultRange);
  const enabled = !!orgId;

  const { data, isLoading, error, refetch } = useCustomerProfitability(
    { orgId: orgId ?? "", from: range.from, to: range.to, limit: 50 },
    enabled,
  );
  useApiError(error, refetch);

  const grand = data?.grand_total_cost_usd ?? 0;
  const attributed = data?.attributed_cost_usd ?? 0;
  const unattributed = data?.unattributed_cost_usd ?? 0;
  const attribPct = grand > 0 ? (attributed / grand) * 100 : 0;
  const rows = data?.rows ?? [];

  // Top retry-cost offender — the "fix this first" signal at the top of the
  // page. We surface it as a banner only if it's a non-trivial fraction of
  // that customer's spend (>5%), otherwise it's noise.
  const retryOffender = rows
    .filter((r) => r.current_cost_usd > 0 && r.retry_cost_usd / r.current_cost_usd > 0.05)
    .sort((a, b) => b.retry_cost_usd - a.retry_cost_usd)[0];

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold">Customers</h1>
          <p className="text-xs text-muted-foreground">
            Cost-per-customer with retry waste, test traffic, and prior-period change
          </p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {/* ── Attribution coverage banner ──
          If attribution coverage is low, surface it prominently — the page is
          useless without customer_id wired through. Threshold at 50% chosen
          empirically; below that, the long-tail of "Unattributed" is the
          actual story and the per-customer ranking is misleading.
      */}
      {!isLoading && data && grand > 0 && attribPct < 50 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="p-3 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-300 mt-0.5 shrink-0" />
            <div className="text-xs">
              <span className="text-amber-200 font-medium">
                Only {attribPct.toFixed(0)}% of spend is attributed to a customer.
              </span>{" "}
              <span className="text-muted-foreground">
                Pass{" "}
                <code className="px-1 py-0.5 mx-0.5 rounded bg-muted text-foreground">customer_id</code>{" "}
                to{" "}
                <code className="px-1 py-0.5 mx-0.5 rounded bg-muted text-foreground">sdk.workflow()</code>{" "}
                so per-customer cost rolls up correctly. The remaining{" "}
                <span className="text-foreground tabular-nums">{money(unattributed)}</span>{" "}
                is invisible here.
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Summary tiles ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile
          label="Grand total"
          value={money(grand)}
          subtitle="all LLM cost in window"
          loading={isLoading}
        />
        <SummaryTile
          label="Attributed"
          value={money(attributed)}
          subtitle={
            grand > 0 ? `${attribPct.toFixed(0)}% of total — ${data?.attributed_customer_count ?? 0} customers` : undefined
          }
          tone={attribPct >= 80 ? "green" : attribPct >= 50 ? "neutral" : "amber"}
          loading={isLoading}
        />
        <SummaryTile
          label="Unattributed"
          value={money(unattributed)}
          subtitle="no customer_id"
          tone={unattributed > 0 ? "amber" : "neutral"}
          loading={isLoading}
        />
        <SummaryTile
          label="Top customer"
          value={rows[0] ? money(rows[0].current_cost_usd) : "—"}
          subtitle={
            rows[0]
              ? `${displayName(rows[0].customer_id)} — ${rows[0].pct_of_attributed.toFixed(0)}% of attributed`
              : undefined
          }
          tone={rows[0] && rows[0].pct_of_attributed > 60 ? "red" : "neutral"}
          loading={isLoading}
        />
      </div>

      {/* ── Retry offender banner — single most actionable signal ── */}
      {retryOffender && (
        <Card className="border-red-500/40 bg-red-500/5">
          <CardContent className="p-3 flex items-start gap-2">
            <RefreshCw className="h-4 w-4 text-red-300 mt-0.5 shrink-0" />
            <div className="text-xs">
              <span className="text-red-200 font-medium">
                {displayName(retryOffender.customer_id)}: {money(retryOffender.retry_cost_usd)} wasted on retries
              </span>{" "}
              <span className="text-muted-foreground">
                ({((retryOffender.retry_cost_usd / retryOffender.current_cost_usd) * 100).toFixed(0)}% of this customer&apos;s spend).
                Drill into their workflows to find the failing step.
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Per-customer table ── */}
      <Card>
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">By customer</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Sorted by current-window cost. Click a row to drill into that customer&apos;s traces.
          </p>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {isLoading ? (
            <div className="space-y-1.5 px-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              No customer-attributed traffic in this window.
              <div className="mt-2">
                Pass{" "}
                <code className="px-1 py-0.5 rounded bg-muted text-foreground">customer_id</code>{" "}
                to{" "}
                <code className="px-1 py-0.5 rounded bg-muted text-foreground">sdk.workflow()</code>{" "}
                to populate this page.
              </div>
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left font-normal px-4 py-2">Customer</th>
                  <th className="text-right font-normal px-2 py-2">Cost</th>
                  <th className="text-right font-normal px-2 py-2 hidden sm:table-cell">Δ vs prior</th>
                  <th className="text-right font-normal px-2 py-2">Share</th>
                  <th className="text-right font-normal px-2 py-2 hidden md:table-cell">Calls</th>
                  <th className="text-right font-normal px-2 py-2 hidden md:table-cell">Workflows</th>
                  <th className="text-right font-normal px-4 py-2">Waste</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <CustomerRow
                    key={r.customer_id}
                    row={r}
                    onClick={() => {
                      const qs = new URLSearchParams({
                        customer_id: r.customer_id,
                        from: range.from.toISOString(),
                        to: range.to.toISOString(),
                      });
                      router.push(`/dashboard/traces?${qs.toString()}`);
                    }}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Subcomponents
// ───────────────────────────────────────────────────────────────────────────

interface SummaryTileProps {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "neutral" | "red" | "amber" | "green";
  loading?: boolean;
}

function SummaryTile({ label, value, subtitle, tone = "neutral", loading }: SummaryTileProps) {
  const toneCls = {
    neutral: "text-foreground",
    red: "text-red-300",
    amber: "text-amber-300",
    green: "text-emerald-300",
  }[tone];
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        {loading ? (
          <Skeleton className="h-6 w-20 mt-1.5" />
        ) : (
          <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
        )}
        {subtitle && !loading && <div className={cn("text-[11px] mt-0.5", toneCls)}>{subtitle}</div>}
      </CardContent>
    </Card>
  );
}

function CustomerRow({ row, onClick }: { row: CustomerProfitabilityRow; onClick: () => void }) {
  const retryPct = row.current_cost_usd > 0 ? (row.retry_cost_usd / row.current_cost_usd) * 100 : 0;
  const testPct = row.current_cost_usd > 0 ? (row.test_cost_usd / row.current_cost_usd) * 100 : 0;
  const wasteHigh = retryPct > 5 || testPct > 1;

  return (
    <tr
      onClick={onClick}
      className="border-b border-border/40 hover:bg-muted/30 cursor-pointer transition-colors"
    >
      <td className="px-4 py-2 font-mono">
        <div className="flex items-center gap-2">
          <span className="truncate max-w-[200px]">{displayName(row.customer_id)}</span>
          {row.error_count > 0 && (
            <Badge
              variant="outline"
              className="text-[9px] py-0 px-1 h-4 border-red-500/40 text-red-300"
            >
              {row.error_count} err
            </Badge>
          )}
        </div>
      </td>
      <td className="px-2 py-2 text-right tabular-nums font-medium">{money(row.current_cost_usd)}</td>
      <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">
        {row.is_new ? (
          <span className="inline-flex items-center gap-0.5 text-purple-300">
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
      <td className="px-2 py-2 text-right tabular-nums">
        <div className="inline-flex items-center gap-2 w-full justify-end">
          <div className="hidden lg:block w-16 h-1.5 rounded bg-muted overflow-hidden">
            <div
              className="h-full bg-foreground/60"
              style={{ width: `${Math.min(row.pct_of_attributed, 100)}%` }}
            />
          </div>
          <span className="text-foreground">{row.pct_of_attributed.toFixed(0)}%</span>
        </div>
      </td>
      <td className="px-2 py-2 text-right tabular-nums hidden md:table-cell text-muted-foreground">
        {row.current_calls.toLocaleString()}
      </td>
      <td className="px-2 py-2 text-right tabular-nums hidden md:table-cell text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Workflow className="h-3 w-3" />
          {row.workflow_count}
        </span>
      </td>
      <td className="px-4 py-2 text-right">
        <div className="inline-flex items-center gap-1.5 justify-end flex-wrap">
          {retryPct > 0 && (
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] py-0 px-1 h-4 gap-0.5",
                retryPct > 5
                  ? "border-red-500/40 text-red-300"
                  : "border-border text-muted-foreground",
              )}
              title={`Retry cost: ${money(row.retry_cost_usd)}`}
            >
              <RefreshCw className="h-2 w-2" />
              {retryPct.toFixed(0)}%
            </Badge>
          )}
          {testPct > 0 && (
            <Badge
              variant="outline"
              className="text-[9px] py-0 px-1 h-4 gap-0.5 border-amber-500/40 text-amber-300"
              title={`Test traffic: ${money(row.test_cost_usd)}`}
            >
              <FlaskConical className="h-2 w-2" />
              {testPct.toFixed(0)}%
            </Badge>
          )}
          {!wasteHigh && retryPct === 0 && testPct === 0 && (
            <span className="text-[10px] text-muted-foreground">clean</span>
          )}
        </div>
      </td>
    </tr>
  );
}
