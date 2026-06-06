"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, AlertTriangle, RefreshCw, FlaskConical, Database } from "lucide-react";
import { useWorkflowDetail, type WorkflowBreakdownRow } from "@/lib/queries/use-workflow-detail";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useOrgId } from "@/lib/org-context";
import { useApiError } from "@/hooks/use-api-error";
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

// Parse ?from=…&to=… off the URL so deep-links from the treemap land on the
// same time window the user saw. Falls back to last-24h if either bound is
// missing/invalid — same convention as the trace detail page.
function rangeFromUrl(sp: URLSearchParams): DateRange {
  const f = sp.get("from");
  const t = sp.get("to");
  if (!f || !t) return defaultRange();
  const from = new Date(f);
  const to = new Date(t);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return defaultRange();
  return { from, to };
}

export default function WorkflowDetailPage() {
  const params = useParams<{ name: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const workflow = decodeURIComponent(params.name ?? "");
  useDocumentTitle(workflow ? `Workflow: ${workflow}` : "Workflow");
  const orgId = useOrgId();
  const [range, setRange] = useState<DateRange>(() => rangeFromUrl(new URLSearchParams(sp.toString())));
  const enabled = !!orgId && !!workflow;

  const { data, isLoading, error, refetch } = useWorkflowDetail(
    { orgId: orgId ?? "", workflow, from: range.from, to: range.to },
    enabled,
  );
  useApiError(error, refetch);

  const summary = data?.summary;
  // Compute "% of total" denominators per breakdown so the bars are comparable.
  // We compute against the *visible* (top-20) rows' sum rather than the full
  // summary cost — when a workflow has dozens of agents, the long-tail rows
  // are filtered out by the LIMIT 20 in the query, and using the global sum
  // would make every bar look small. Top-20 sum gives a useful visual scale.
  const denom = (rows: WorkflowBreakdownRow[]) => rows.reduce((s, r) => s + r.cost_usd, 0) || 1;

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <Link
            href="/dashboard"
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 w-fit"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to Overview
          </Link>
          <h1 className="text-lg font-semibold font-mono">{workflow || "(unnamed workflow)"}</h1>
          <p className="text-xs text-muted-foreground">
            Cost attribution across agents, steps, customers, and models
          </p>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {/* ── Summary tiles ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile
          label="Total cost"
          value={summary ? money(summary.total_cost_usd) : "—"}
          subtitle={
            !summary
              ? undefined
              : summary.is_new
                ? "first appearance"
                : summary.pct_change > 0.5
                  ? `+${summary.pct_change.toFixed(0)}% vs prior`
                  : summary.pct_change < -0.5
                    ? `${summary.pct_change.toFixed(0)}% vs prior`
                    : "≈stable"
          }
          tone={
            !summary
              ? "neutral"
              : summary.is_new
                ? "purple"
                : summary.pct_change > 20
                  ? "red"
                  : summary.pct_change > 5
                    ? "amber"
                    : summary.pct_change < -5
                      ? "green"
                      : "neutral"
          }
          loading={isLoading}
        />
        <SummaryTile
          label="Calls"
          value={summary ? summary.total_calls.toLocaleString() : "—"}
          subtitle={summary && summary.error_count > 0 ? `${summary.error_count} errors` : undefined}
          tone={summary && summary.error_count > 0 ? "red" : "neutral"}
          loading={isLoading}
        />
        <SummaryTile
          label="Customers"
          value={summary ? summary.customer_count.toLocaleString() : "—"}
          subtitle="distinct customer_id"
          loading={isLoading}
        />
        <SummaryTile
          label="Retry cost"
          icon={<RefreshCw className="h-3 w-3" />}
          value={summary ? money(summary.retry_cost_usd) : "—"}
          subtitle={
            summary && summary.total_cost_usd > 0
              ? `${((summary.retry_cost_usd / summary.total_cost_usd) * 100).toFixed(0)}% of spend`
              : undefined
          }
          tone={summary && summary.retry_cost_usd / Math.max(summary.total_cost_usd, 1e-9) > 0.05 ? "red" : "neutral"}
          loading={isLoading}
        />
      </div>

      {/* ── Callout strip — only shown when at least one signal is non-zero ── */}
      {summary &&
        (summary.test_cost_usd > 0 || summary.cache_read_savings_usd > 0) && (
          <div className="flex flex-wrap gap-3">
            {summary.test_cost_usd > 0 && (
              <CalloutPill
                icon={<FlaskConical className="h-3 w-3" />}
                tone="amber"
                label="Test traffic in this workflow"
                value={money(summary.test_cost_usd)}
                hint={
                  summary.total_cost_usd > 0
                    ? `${((summary.test_cost_usd / summary.total_cost_usd) * 100).toFixed(0)}% — exclude from prod budget`
                    : undefined
                }
              />
            )}
            {summary.cache_read_savings_usd > 0 && (
              <CalloutPill
                icon={<Database className="h-3 w-3" />}
                tone="green"
                label="Cache savings"
                value={money(summary.cache_read_savings_usd)}
                hint="cost avoided via cache_read"
              />
            )}
          </div>
        )}

      {/* ── Breakdown grid ──
          Agent + Step side-by-side: that's the "where is the money" pair.
          Customer + Model below: secondary attribution lenses.
      */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <BreakdownPanel
          title="By agent"
          subtitle="cost attributed to each agent inside this workflow"
          rows={data?.by_agent ?? []}
          isLoading={isLoading}
          emptyLabel="No agent-tagged calls. Wrap with sdk.agent() to attribute."
          denom={data ? denom(data.by_agent) : 1}
          unknownLabel="(no agent)"
          onClickRow={(key) => {
            if (!key) return;
            const qs = new URLSearchParams({
              feature_name: workflow,
              from: range.from.toISOString(),
              to: range.to.toISOString(),
            });
            router.push(`/dashboard/traces?${qs.toString()}`);
          }}
        />
        <BreakdownPanel
          title="By step"
          subtitle="cost per step — usually the most actionable lens"
          rows={data?.by_step ?? []}
          isLoading={isLoading}
          emptyLabel="No step-tagged calls. Wrap with sdk.step() to attribute."
          denom={data ? denom(data.by_step) : 1}
          unknownLabel="(no step)"
        />
        <BreakdownPanel
          title="By customer"
          subtitle="who is consuming this workflow"
          rows={data?.by_customer ?? []}
          isLoading={isLoading}
          emptyLabel="No customer_id tagged. Pass customer_id to sdk.workflow() to attribute."
          denom={data ? denom(data.by_customer) : 1}
          unknownLabel="(no customer)"
        />
        <BreakdownPanel
          title="By model"
          subtitle="which models burn the most"
          rows={data?.by_model ?? []}
          isLoading={isLoading}
          emptyLabel="No model data."
          denom={data ? denom(data.by_model) : 1}
          unknownLabel="(unknown model)"
        />
      </div>

      {/* ── Cost-source mix — narrow strip below; the full Cost Confidence
              card on Overview surfaces this org-wide. ── */}
      <Card>
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">Cost confidence</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Where each dollar of attributed cost came from — server-priced is the trustworthy ground truth.
          </p>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {isLoading ? (
            <Skeleton className="h-7 w-full" />
          ) : (
            <CostSourceBar rows={data?.cost_source_mix ?? []} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Subcomponents — local to this page; nothing else needs them yet.
// ───────────────────────────────────────────────────────────────────────────

interface SummaryTileProps {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "neutral" | "red" | "amber" | "green" | "purple";
  icon?: React.ReactNode;
  loading?: boolean;
}

function SummaryTile({ label, value, subtitle, tone = "neutral", icon, loading }: SummaryTileProps) {
  const toneCls = {
    neutral: "text-foreground",
    red: "text-red-300",
    amber: "text-amber-300",
    green: "text-emerald-300",
    purple: "text-purple-300",
  }[tone];

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
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

interface CalloutPillProps {
  icon: React.ReactNode;
  tone: "red" | "amber" | "green" | "purple";
  label: string;
  value: string;
  hint?: string;
}

function CalloutPill({ icon, tone, label, value, hint }: CalloutPillProps) {
  const toneCls = {
    red: "border-red-500/40 bg-red-500/5 text-red-300",
    amber: "border-amber-500/40 bg-amber-500/5 text-amber-300",
    green: "border-emerald-500/40 bg-emerald-500/5 text-emerald-300",
    purple: "border-purple-500/40 bg-purple-500/5 text-purple-300",
  }[tone];
  return (
    <div className={cn("inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs", toneCls)}>
      {icon}
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
      {hint && <span className="text-muted-foreground text-[11px]">· {hint}</span>}
    </div>
  );
}

interface BreakdownPanelProps {
  title: string;
  subtitle?: string;
  rows: WorkflowBreakdownRow[];
  denom: number;
  isLoading: boolean;
  emptyLabel: string;
  unknownLabel: string;
  onClickRow?: (key: string) => void;
}

function BreakdownPanel({
  title,
  subtitle,
  rows,
  denom,
  isLoading,
  emptyLabel,
  unknownLabel,
  onClickRow,
}: BreakdownPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {isLoading ? (
          <div className="space-y-1.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4">{emptyLabel}</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r, i) => {
              const pct = (r.cost_usd / denom) * 100;
              const label = r.key || unknownLabel;
              return (
                <li
                  key={`${r.key}-${i}`}
                  className={cn(
                    "group relative h-6 flex items-center text-[11px] px-2 rounded overflow-hidden",
                    onClickRow && r.key && "cursor-pointer hover:bg-muted/30",
                  )}
                  onClick={() => onClickRow?.(r.key)}
                >
                  <div
                    className="absolute inset-y-0 left-0 bg-muted/50 group-hover:bg-muted/70 transition-colors"
                    style={{ width: `${Math.max(pct, 1.5)}%` }}
                  />
                  <span className="relative z-10 font-mono truncate">{label}</span>
                  <span className="relative z-10 ml-auto tabular-nums text-muted-foreground pr-1">
                    {r.calls.toLocaleString()} · {money(r.cost_usd)}
                  </span>
                  {r.error_count > 0 && (
                    <Badge
                      variant="outline"
                      className="relative z-10 ml-2 text-[9px] py-0 px-1 h-4 border-red-500/40 text-red-300"
                    >
                      <AlertTriangle className="h-2 w-2 mr-0.5" />
                      {r.error_count}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// Horizontal stacked bar showing what fraction of cost came from each
// cost_source value. server_computed = trustworthy; sdk_fallback / unknown_model
// = the dashboard is reading SDK-supplied numbers it can't verify.
function CostSourceBar({ rows }: { rows: WorkflowBreakdownRow[] }) {
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  if (total === 0) return <p className="text-xs text-muted-foreground">No data.</p>;
  const colorFor = (src: string): string => {
    switch (src) {
      case "server_computed":
        return "bg-emerald-500/60";
      case "sdk_fallback":
        return "bg-amber-500/60";
      case "unknown_model":
        return "bg-red-500/60";
      case "container":
        return "bg-muted";
      default:
        return "bg-muted";
    }
  };
  const labelFor = (src: string): string => {
    switch (src) {
      case "server_computed":
        return "Server-priced";
      case "sdk_fallback":
        return "SDK fallback";
      case "unknown_model":
        return "Unknown model";
      case "container":
        return "Container span";
      default:
        return src || "unknown";
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full rounded overflow-hidden border border-border">
        {rows.map((r) => {
          const pct = (r.cost_usd / total) * 100;
          return (
            <div
              key={r.key}
              className={cn("h-full", colorFor(r.key))}
              style={{ width: `${pct}%` }}
              title={`${labelFor(r.key)}: ${money(r.cost_usd)} (${pct.toFixed(0)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        {rows.map((r) => {
          const pct = (r.cost_usd / total) * 100;
          return (
            <div key={r.key} className="inline-flex items-center gap-1.5">
              <span className={cn("inline-block w-2 h-2 rounded-sm", colorFor(r.key))} />
              <span>{labelFor(r.key)}</span>
              <span className="tabular-nums text-foreground">{pct.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
