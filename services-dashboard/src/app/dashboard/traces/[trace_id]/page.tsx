"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useTraceTree } from "@/lib/queries/use-trace-tree";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useOrgId } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadingState } from "@/components/shared/loading-state";
import { TraceGantt } from "@/components/traces/trace-gantt";
import { StatusBadge } from "@/components/shared/status-badge";
import { RelativeTime } from "@/components/shared/relative-time";
import { CopyButton } from "@/components/shared/copy-button";
import { cn } from "@/lib/utils";
import { costBreakdown } from "@/lib/pricing";
import type { components } from "@/lib/api-types";

type Trace = components["schemas"]["Trace"];
type SpanNode = Trace & { children: SpanNode[] };

// Build a hierarchical tree from the flat span list using parent_span_id.
// Orphan spans (parent not in this trace) become roots — defensive against
// missing chains so the UI degrades to a flat list rather than dropping spans.
function buildTree(spans: Trace[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const s of spans) byId.set(s.span_id, { ...s, children: [] });
  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_span_id && byId.has(node.parent_span_id)) {
      byId.get(node.parent_span_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// Semantic label preference: feature_name (e.g. "agent-workflow", "checkout")
// reads more meaningfully than the raw model name for the tree, and falls
// back to model when feature is absent.
//
// Workflow spans (kind="workflow") never have a model — the synthetic span
// is emitted by sdk.trace() purely to give LLM-call children a real parent
// row. Label them with the trace name (stored as feature_name) and a
// small "workflow" affordance so the user knows the row is a container,
// not a provider call.
function spanLabel(s: Trace): string {
  if ((s as Trace & { kind?: string }).kind === "workflow") {
    return (s.feature_name ?? "") !== "" ? (s.feature_name as string) : "workflow";
  }
  return (s.feature_name ?? "") !== "" ? (s.feature_name as string) : s.model;
}

/** Workflow rows have no model, no tokens, no cost. Use this to gate UI
 *  fragments that only make sense for LLM-call rows (token strips, cost
 *  breakdowns, model badges). */
function isWorkflowSpan(s: Trace): boolean {
  return (s as Trace & { kind?: string }).kind === "workflow";
}

function money(n: number): string {
  const d = n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: d }).format(n);
}

interface TreeNodeProps {
  node: SpanNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function TreeNode({ node, depth, selectedId, onSelect }: TreeNodeProps) {
  const isSelected = selectedId === node.span_id;
  const isWorkflow = isWorkflowSpan(node);
  const totalTokens = node.input_tokens + node.output_tokens;
  return (
    <>
      <button
        onClick={() => onSelect(node.span_id)}
        className={cn(
          "flex flex-col gap-0.5 w-full pr-3 py-2 transition-colors text-left",
          isSelected ? "bg-muted text-foreground" : "text-foreground hover:bg-muted/60",
        )}
        style={{ paddingLeft: `${depth * 14 + 12}px` }}
      >
        {/* Line 1: span name + the right-aligned headline number.
            For LLM rows that's cost; for workflow rows cost is $0 and
            uninformative — show duration there instead so the column
            scans as "workflow block took 4.2s" not "workflow $0.00".
            Round-5 review: workflow rows were rendering like broken
            LLM calls. */}
        <span className="flex items-center gap-2 w-full">
          <span className="flex-1 truncate text-sm">
            {spanLabel(node)}
            {isWorkflow && (
              <span className="ml-1.5 text-[9px] uppercase tracking-wider text-muted-foreground border border-border rounded px-1 py-px align-middle">
                workflow
              </span>
            )}
          </span>
          <span className="text-xs tabular-nums shrink-0 font-medium">
            {isWorkflow
              ? `${(node.latency_ms / 1000).toFixed(node.latency_ms < 1000 ? 2 : 1)}s`
              : money(node.cost_usd)}
          </span>
        </span>
        {/* Line 2: meta. For LLM: latency + tokens. For workflow: just
            "block · status" — model/tokens are always empty/zero and would
            mislead. */}
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {isWorkflow
            ? <>trace block · {node.status}</>
            : <>{node.latency_ms}ms · {node.input_tokens.toLocaleString()} → {node.output_tokens.toLocaleString()} ({totalTokens.toLocaleString()})</>}
        </span>
      </button>
      {node.children.map((child) => (
        <TreeNode
          key={child.span_id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

// CostField: cost value with a hover popover showing input/output breakdown.
// Mirrors Langfuse's pattern — total displayed inline, mouseover reveals the
// split. Prefers the backend-stored input_cost_usd / output_cost_usd (computed
// at ingest from real pricing); falls back to lib/pricing.ts's recomputation
// only when the API didn't populate the fields (e.g. older data, models not
// yet in the pricing table).
function CostField({ span }: { span: Trace }) {
  const hasStored =
    typeof span.input_cost_usd === "number" &&
    typeof span.output_cost_usd === "number" &&
    (span.input_cost_usd > 0 || span.output_cost_usd > 0);
  const b = hasStored
    ? {
        inputCost: span.input_cost_usd as number,
        outputCost: span.output_cost_usd as number,
        totalCost: span.cost_usd,
        exact: true as const,
      }
    : costBreakdown(span.model, span.input_tokens, span.output_tokens, span.cost_usd);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex items-center cursor-help underline decoration-dotted decoration-muted-foreground underline-offset-4 outline-none"
          >
            {money(span.cost_usd)}
          </span>
        }
      />
      <TooltipContent
        side="right"
        className="bg-popover text-popover-foreground border border-border shadow-lg p-3 inline-block max-w-none items-stretch"
      >
        <div className="space-y-2 min-w-[200px]">
          <div className="text-sm font-semibold">Cost breakdown</div>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">Input cost</span>
              <span className="tabular-nums font-medium">{money(b.inputCost)}</span>
            </div>
            <div className="flex justify-between gap-6">
              <span className="text-muted-foreground">Output cost</span>
              <span className="tabular-nums font-medium">{money(b.outputCost)}</span>
            </div>
            <div className="flex justify-between gap-6 pt-1.5 border-t border-border">
              <span>Total cost</span>
              <span className="tabular-nums font-medium">{money(b.totalCost)}</span>
            </div>
            {!b.exact && (
              <p className="text-[10px] text-muted-foreground italic pt-1">
                Approximate split — pricing not on file for <span className="font-mono">{span.model}</span>.
              </p>
            )}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 py-2 border-b border-border last:border-0">
      <dt className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider self-start pt-0.5">
        {label}
      </dt>
      <dd className="text-sm break-all">{value}</dd>
    </div>
  );
}

function SpanDetail({ span }: { span: Trace | undefined }) {
  if (!span) {
    return <p className="text-sm text-muted-foreground p-4">Select a span from the tree.</p>;
  }
  // Workflow spans don't have model / provider / tokens / cost — those
  // fields are server-zeroed. Rendering them with $0.00 / "0 → 0" makes
  // the row look like a broken LLM call. Branch the field set so workflow
  // detail shows only the fields that have meaning for it: ids, latency
  // (= block duration), feature, environment, sdk version. (Round-5
  // review — workflow span UI cleanup.)
  const isWorkflow = isWorkflowSpan(span);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-sm">{spanLabel(span)}</span>
        {isWorkflow && (
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground border border-border rounded px-1.5 py-0.5">
            workflow span
          </span>
        )}
        <StatusBadge status={span.status} />
        <span className="text-xs text-muted-foreground">
          <RelativeTime date={span.timestamp} />
        </span>
      </div>

      <dl className="border border-border rounded-md px-4 bg-card">
        <Field label="Span ID" value={<CopyButton value={span.span_id} />} />
        <Field label="Trace ID" value={<CopyButton value={span.trace_id} />} />
        {span.parent_span_id && (
          <Field label="Parent" value={<CopyButton value={span.parent_span_id} />} />
        )}
        {!isWorkflow && (
          <>
            <Field
              label="Model"
              value={<code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{span.model}</code>}
            />
            <Field label="Provider" value={span.provider} />
          </>
        )}
        <Field
          label={isWorkflow ? "Duration" : "Latency"}
          value={isWorkflow ? `${(span.latency_ms / 1000).toFixed(2)}s` : `${span.latency_ms}ms`}
        />
        {!isWorkflow && span.ttft_ms != null && <Field label="TTFT" value={`${span.ttft_ms}ms`} />}
        {!isWorkflow && (
          <>
            <Field
              label="Tokens"
              value={
                <span className="tabular-nums">
                  {span.input_tokens.toLocaleString()} →{" "}
                  {span.output_tokens.toLocaleString()}{" "}
                  <span className="text-muted-foreground">
                    (Σ {(span.input_tokens + span.output_tokens).toLocaleString()})
                  </span>
                </span>
              }
            />
            <Field label="Cost" value={<CostField span={span} />} />
          </>
        )}
        <Field label="Environment" value={span.environment} />
        {span.feature_name && <Field label="Feature" value={span.feature_name} />}
        {span.user_id && <Field label="User" value={<CopyButton value={span.user_id} />} />}
        {span.session_id && <Field label="Session" value={<CopyButton value={span.session_id} />} />}
        {span.sdk_version && <Field label="SDK" value={span.sdk_version} />}
        {span.error_message && (
          <Field
            label="Error"
            value={<span className="text-red-400 font-mono text-xs">{span.error_message}</span>}
          />
        )}
      </dl>

      {(span.input_text || span.output_text) && (
        <div className="space-y-3">
          {span.input_text && (
            <div>
              <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Input
              </h3>
              <pre className="bg-card border border-border rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-72">
                {span.input_text}
              </pre>
            </div>
          )}
          {span.output_text && (
            <div>
              <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Output
              </h3>
              <pre className="bg-card border border-border rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-72">
                {span.output_text}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TraceTreeView() {
  const params = useParams() as { trace_id: string };
  const searchParams = useSearchParams();
  const router = useRouter();
  const orgId = useOrgId();
  useDocumentTitle(`Trace ${params.trace_id}`);

  // Parse from/to off the URL so the trace-tree query can bound its
  // ClickHouse scan instead of probing min/max(timestamp) on a 90-day
  // partition. The Traces list now writes these into the detail link
  // (services-dashboard/src/app/dashboard/traces/page.tsx detailHref).
  // Date.parse → NaN guard: invalid timestamps silently drop the hint
  // (better than throwing — preserves direct-link shareability for old
  // URLs that lack the params). Round-4 review P1.
  const rangeHint = (() => {
    const fromStr = searchParams.get("from");
    const toStr = searchParams.get("to");
    if (!fromStr || !toStr) return { from: undefined, to: undefined };
    const fromMs = Date.parse(fromStr);
    const toMs = Date.parse(toStr);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
      return { from: undefined, to: undefined };
    }
    return { from: new Date(fromMs), to: new Date(toMs) };
  })();

  const query = useTraceTree(
    {
      orgId: orgId ?? "",
      traceId: params.trace_id,
      from: rangeHint.from,
      to: rangeHint.to,
    },
    !!orgId,
  );
  useApiError(query.error, query.refetch);
  const { data, isLoading, error } = query;

  const spans = useMemo(() => data?.spans ?? [], [data]);
  const tree = useMemo(() => buildTree(spans), [spans]);

  // Initial selection: ?span= from URL, else first root span.
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("span"));
  // View toggle: hierarchy (tree) or timeline (gantt). Gantt is the better
  // mental model for agent traces with parallel tool calls — exposes where
  // wall-clock time actually goes vs sequential vs concurrent.
  type ViewMode = "tree" | "gantt";
  const [viewMode, setViewMode] = useState<ViewMode>(
    (searchParams.get("view") as ViewMode | null) ?? "tree",
  );
  useEffect(() => {
    if (selectedId == null && tree.length > 0) {
      setSelectedId(tree[0].span_id);
    }
  }, [tree, selectedId]);

  // Keep the URL in sync with the selected span so a copied URL deep-links
  // to the same view a teammate sees. router.replace avoids history clutter.
  useEffect(() => {
    if (!selectedId) return;
    const current = searchParams.get("span");
    if (current === selectedId) return;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("span", selectedId);
    router.replace(`?${sp.toString()}`, { scroll: false });
  }, [selectedId, searchParams, router]);

  const selected = spans.find((s) => s.span_id === selectedId);

  // Trace-level rollups. Latency takes the max of any span (effectively wall-clock
  // for sequential traces; an undercount for parallel sub-spans, but a reasonable
  // first-cut without parent-relative timing).
  const totalLatency = spans.reduce((m, s) => Math.max(m, s.latency_ms), 0);
  const totalCost = spans.reduce((sum, s) => sum + s.cost_usd, 0);
  const totalTokens = spans.reduce((sum, s) => sum + s.input_tokens + s.output_tokens, 0);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-[380px_1fr] gap-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (error || !data || spans.length === 0) {
    return (
      <div className="space-y-4">
        {/* router.back() preserves the Traces list's filter + range state
            via the browser's history stack — drilling Cost → Traces filter
            → trace detail and clicking Back lands you exactly where you
            were. router.push("/dashboard/traces") would have dropped that
            context (Round-2 review P1). */}
        <Button variant="ghost" size="sm" onClick={() => router.back()} className="gap-1">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <p className="text-sm text-red-500">{error?.message ?? "Trace not found"}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* router.back() preserves the Traces list's filter + range state
            via the browser's history stack — drilling Cost → Traces filter
            → trace detail and clicking Back lands you exactly where you
            were. router.push("/dashboard/traces") would have dropped that
            context (Round-2 review P1). */}
        <Button variant="ghost" size="sm" onClick={() => router.back()} className="gap-1">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        {/* Header shows the full trace_id (it's the primary identity on this
            page); the copy button is icon-only here so it doesn't render a
            truncated duplicate next to the full one. */}
        <span className="font-mono text-xs text-muted-foreground">{params.trace_id}</span>
        <CopyButton value={params.trace_id} iconOnly />
      </div>

      {/* Rollups + view toggle */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
        <span>{spans.length} span{spans.length !== 1 ? "s" : ""}</span>
        <span className="text-muted-foreground/40">·</span>
        <span><span className="text-foreground tabular-nums font-medium">{totalLatency}ms</span> max latency</span>
        <span className="text-muted-foreground/40">·</span>
        <span><span className="text-foreground tabular-nums font-medium">{money(totalCost)}</span> total cost</span>
        <span className="text-muted-foreground/40">·</span>
        <span><span className="text-foreground tabular-nums font-medium">{totalTokens.toLocaleString()}</span> tokens</span>
        {/* Tree | Gantt toggle */}
        <div className="ml-auto inline-flex items-center border border-border rounded-md p-0.5">
          <button
            onClick={() => setViewMode("tree")}
            className={cn(
              "px-2.5 py-1 text-xs rounded transition-colors",
              viewMode === "tree" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Tree
          </button>
          <button
            onClick={() => setViewMode("gantt")}
            className={cn(
              "px-2.5 py-1 text-xs rounded transition-colors",
              viewMode === "gantt" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Gantt
          </button>
        </div>
      </div>

      {viewMode === "tree" ? (
        /* Two-pane: tree on the left, detail on the right */
        <div className="grid grid-cols-1 md:grid-cols-[380px_1fr] gap-4 min-h-[500px]">
          <div className="border border-border rounded-md bg-card overflow-y-auto py-1">
            {tree.map((root) => (
              <TreeNode
                key={root.span_id}
                node={root}
                depth={0}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ))}
          </div>
          <div className="overflow-y-auto">
            <SpanDetail span={selected} />
          </div>
        </div>
      ) : (
        /* Full-width gantt + detail below (more horizontal room for the timeline) */
        <div className="space-y-4">
          <TraceGantt spans={spans} selectedId={selectedId} onSelect={setSelectedId} />
          <SpanDetail span={selected} />
        </div>
      )}
    </div>
  );
}

export default function TraceTreePage() {
  return (
    <Suspense fallback={<LoadingState variant="panel" />}>
      <TraceTreeView />
    </Suspense>
  );
}
