"use client";

import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Database,
  FlaskConical,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { money, num } from "@/lib/format";
import { buttonVariants } from "@/components/ui/button";
import { useOrgId } from "@/lib/org-context";
import { useApiError } from "@/hooks/use-api-error";
import {
  useWorkflowDetail,
  type WorkflowBreakdownRow,
} from "@/lib/queries/use-workflow-detail";
import { Delta } from "../../_components/viz";
import { globalScopeQuery, useTimeRange } from "../../_lib/use-time-range";

// Dedicated workflow detail surface (v2). Ported from the classic
// /dashboard/workflows/[name] page, but: the time window comes from the global
// scope pill (useTimeRange) instead of a local date picker, and rows drill into
// /dashboard/traces carrying the active scope. Reached from the Overview
// "Where the money goes" treemap (Workflow tab).
export default function V2WorkflowDetailPage() {
  const params = useParams<{ name: string }>();
  const sp = useSearchParams();
  const orgId = useOrgId();
  const { from, to, label } = useTimeRange();

  const workflow = decodeURIComponent(params.name ?? "");
  const enabled = !!orgId && !!workflow;

  const { data, isLoading, isError, error, refetch } = useWorkflowDetail(
    { orgId: orgId ?? "", workflow, from, to },
    enabled,
  );
  useApiError(error, refetch);

  const summary = data?.summary;
  const loading = isLoading || !orgId;
  const scope = globalScopeQuery(sp);

  // % of total per breakdown computed against the visible rows' sum (top-N),
  // so bars stay comparable even when the long tail is LIMIT-capped server-side.
  const denom = (rows: WorkflowBreakdownRow[]) =>
    rows.reduce((s, r) => s + r.cost_usd, 0) || 1;

  // Drill to v2 Traces filtered by (workflow, agent) or (workflow, step),
  // carrying the active global scope so the window matches what's on screen.
  const tracesHref = (extra: Record<string, string>) => {
    const qs = new URLSearchParams(extra);
    const sep = scope ? "&" : "?";
    return `/dashboard/traces${scope}${sep}${qs.toString()}`;
  };

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex flex-col gap-1">
        <Link
          href={`/dashboard${scope}`}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 w-fit"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to Overview
        </Link>
        <h1 className="text-lg font-semibold font-mono">
          {workflow || "(unnamed workflow)"}
        </h1>
        <p className="text-xs text-muted-foreground">
          Cost attribution across agents, steps, customers, and models · {label}
        </p>
      </div>

      {isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : (
        <>
          {/* ── Summary tiles ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryTile
              label="Total cost"
              loading={loading}
              value={summary ? money(summary.total_cost_usd) : "—"}
              footer={
                !summary ? undefined : summary.is_new ? (
                  <span className="text-purple-300">first appearance</span>
                ) : Math.abs(summary.pct_change) < 1 ? (
                  <span className="text-muted-foreground">≈ stable vs prior</span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Delta pct={summary.pct_change} direction="up-is-bad" />
                    <span className="text-muted-foreground">vs prior</span>
                  </span>
                )
              }
            />
            <SummaryTile
              label="Calls"
              loading={loading}
              value={summary ? num(summary.total_calls) : "—"}
              footer={
                summary && summary.error_count > 0 ? (
                  <span className="text-red-300">{num(summary.error_count)} errors</span>
                ) : undefined
              }
            />
            <SummaryTile
              label="Customers"
              loading={loading}
              value={summary ? num(summary.customer_count) : "—"}
              footer={<span className="text-muted-foreground">distinct customer_id</span>}
            />
            <SummaryTile
              label="Retry cost"
              icon={<RefreshCw className="h-3 w-3" />}
              loading={loading}
              value={summary ? money(summary.retry_cost_usd) : "—"}
              footer={
                summary && summary.total_cost_usd > 0 ? (
                  <span
                    className={cn(
                      summary.retry_cost_usd / summary.total_cost_usd > 0.05
                        ? "text-red-300"
                        : "text-muted-foreground",
                    )}
                  >
                    {((summary.retry_cost_usd / summary.total_cost_usd) * 100).toFixed(0)}% of spend
                  </span>
                ) : undefined
              }
            />
          </div>

          {/* ── Callout strip — only when a signal is non-zero ── */}
          {summary && (summary.test_cost_usd > 0 || summary.cache_read_savings_usd > 0) && (
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

          {/* ── Breakdown grid — agent + step are the actionable pair (drillable);
                  customer + model are secondary lenses. ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <BreakdownPanel
              title="By agent"
              subtitle="cost attributed to each agent inside this workflow"
              rows={data?.by_agent ?? []}
              loading={loading}
              emptyLabel="No agent-tagged calls. Wrap with sdk.agent() to attribute."
              denom={data ? denom(data.by_agent) : 1}
              unknownLabel="(no agent)"
              hrefFor={(key) => tracesHref({ workflow, agent: key })}
            />
            <BreakdownPanel
              title="By step"
              subtitle="cost per step — usually the most actionable lens"
              rows={data?.by_step ?? []}
              loading={loading}
              emptyLabel="No step-tagged calls. Wrap with sdk.step() to attribute."
              denom={data ? denom(data.by_step) : 1}
              unknownLabel="(no step)"
              hrefFor={(key) => tracesHref({ workflow, step: key })}
            />
            <BreakdownPanel
              title="By customer"
              subtitle="who is consuming this workflow"
              rows={data?.by_customer ?? []}
              loading={loading}
              emptyLabel="No customer_id tagged. Pass customer_id to sdk.workflow() to attribute."
              denom={data ? denom(data.by_customer) : 1}
              unknownLabel="(no customer)"
            />
            <BreakdownPanel
              title="By model"
              subtitle="which models burn the most"
              rows={data?.by_model ?? []}
              loading={loading}
              emptyLabel="No model data."
              denom={data ? denom(data.by_model) : 1}
              unknownLabel="(unknown model)"
            />
          </div>

          {/* ── Cost confidence (cost_source mix for this workflow) ── */}
          <section className="rounded-xl ring-1 ring-foreground/10 bg-card">
            <div className="px-4 pt-4 pb-2">
              <h2 className="text-sm font-medium">Cost confidence</h2>
              <p className="text-[11px] text-muted-foreground">
                Where each dollar of attributed cost came from — server-priced is the trustworthy ground truth.
              </p>
            </div>
            <div className="px-4 pb-4">
              {loading ? (
                <div className="h-7 w-full rounded bg-muted/30 animate-pulse" />
              ) : (
                <CostSourceBar rows={data?.cost_source_mix ?? []} />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ── Local presentational components ─────────────────────────────────────────

function SummaryTile({
  label,
  value,
  footer,
  icon,
  loading,
}: {
  label: string;
  value: string;
  footer?: React.ReactNode;
  icon?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      {loading ? (
        <div className="mt-1.5 h-6 w-20 rounded bg-muted/30 animate-pulse" />
      ) : (
        <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      )}
      {footer && !loading && <div className="text-[11px] mt-0.5">{footer}</div>}
    </div>
  );
}

function CalloutPill({
  icon,
  tone,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  tone: "amber" | "green";
  label: string;
  value: string;
  hint?: string;
}) {
  const toneCls = {
    amber: "border-amber-500/40 bg-amber-500/5 text-amber-300",
    green: "border-emerald-500/40 bg-emerald-500/5 text-emerald-300",
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

function BreakdownPanel({
  title,
  subtitle,
  rows,
  denom,
  loading,
  emptyLabel,
  unknownLabel,
  hrefFor,
}: {
  title: string;
  subtitle?: string;
  rows: WorkflowBreakdownRow[];
  denom: number;
  loading: boolean;
  emptyLabel: string;
  unknownLabel: string;
  hrefFor?: (key: string) => string;
}) {
  const rowCls =
    "group relative h-6 flex items-center text-[11px] px-2 rounded overflow-hidden";
  return (
    <section className="rounded-xl ring-1 ring-foreground/10 bg-card">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="px-4 pb-4">
        {loading ? (
          <div className="space-y-1.5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-6 w-full rounded bg-muted/30 animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4">{emptyLabel}</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r, i) => {
              const pct = (r.cost_usd / denom) * 100;
              const labelText = r.key || unknownLabel;
              const href = hrefFor && r.key ? hrefFor(r.key) : null;
              const inner = (
                <>
                  <div
                    className="absolute inset-y-0 left-0 bg-primary/15 rounded-sm"
                    style={{ width: `${Math.max(pct, 1.5)}%` }}
                  />
                  <span className="relative z-10 font-mono truncate">{labelText}</span>
                  <span className="relative z-10 ml-auto tabular-nums text-muted-foreground pr-1">
                    {num(r.calls)} · {money(r.cost_usd)}
                  </span>
                  {r.error_count > 0 && (
                    <span className="relative z-10 ml-2 inline-flex items-center gap-0.5 text-[10px] py-0 px-1 h-4 rounded border border-red-500/40 text-red-300">
                      <AlertTriangle className="h-2 w-2" />
                      {num(r.error_count)}
                    </span>
                  )}
                </>
              );
              return (
                <li key={`${r.key}-${i}`}>
                  {href ? (
                    <Link href={href} className={cn(rowCls, "row-interactive pr-0.5")}>
                      {inner}
                      <ChevronRight className="relative z-10 ml-1 h-3 w-3 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100 transition-opacity" />
                    </Link>
                  ) : (
                    <div className={rowCls}>{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

// Horizontal stacked bar showing what fraction of cost came from each
// cost_source. server_computed = trustworthy; sdk_fallback / unknown_model =
// numbers the dashboard is reading from the SDK and can't verify.
function CostSourceBar({ rows }: { rows: WorkflowBreakdownRow[] }) {
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  if (total === 0) return <p className="text-xs text-muted-foreground">No data.</p>;
  const colorFor = (src: string): string => {
    const map: Record<string, string> = {
      server_computed: "bg-emerald-500/60",
      sdk_fallback: "bg-amber-500/60",
      unknown_model: "bg-red-500/60",
      container: "bg-muted",
    };
    return map[src] ?? "bg-muted";
  };
  const labelFor = (src: string): string => {
    const map: Record<string, string> = {
      server_computed: "Server-priced",
      sdk_fallback: "SDK fallback",
      unknown_model: "Unknown model",
      container: "Container span",
    };
    return map[src] ?? src ?? "unknown";
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

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10 bg-card p-8 text-center">
      <AlertTriangle className="h-5 w-5 text-amber-400 mx-auto mb-3" />
      <p className="text-sm text-foreground">Couldn&apos;t load this workflow for the selected window.</p>
      <p className="text-[11px] text-muted-foreground mt-1">
        The API may be unreachable, or this workflow has no data for the window.
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
