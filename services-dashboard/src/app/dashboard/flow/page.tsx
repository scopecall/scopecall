"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  useFlowGraph,
  useNodeExpand,
  type GraphNode,
  type GraphEdge,
  type ExpandedCall,
} from "@/lib/queries/use-graph";
import { useOrgId } from "@/lib/org-context";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { DateRangePicker, type DateRange } from "@/components/shared/date-range-picker";
import { ErrorState } from "@/components/shared/error-state";
import { FlowNode, type FlowNodeData } from "@/components/flow/flow-node";
import { CallNode, type CallNodeData } from "@/components/flow/call-node";
import { money } from "@/lib/format";
import { Share2, ArrowRight, ExternalLink, ArrowLeft, Focus } from "lucide-react";

const nodeTypes = { op: FlowNode, call: CallNode };

function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from, to };
}

// --- size / position helpers ---------------------------------------------

// Map call count to node radius. sqrt so a 10× volume node isn't 10× wider
// (which would crowd everything else off the canvas).
function nodeRadius(calls: number, maxCalls: number): number {
  if (maxCalls <= 0) return 28;
  const ratio = Math.sqrt(calls / maxCalls);
  return Math.max(24, Math.min(54, 24 + ratio * 30));
}

function edgeWidth(pct: number): number {
  // pct is share of from's outbound traffic. 100% = chunky line, 1% = hair.
  return Math.max(0.8, Math.min(6, pct * 8));
}

// Layout via Dagre — hierarchical LR is the right default for LLM pipelines
// (input flows through stages to output). Spacings are tuned by eye on the
// mockup; bump nodesep if labels start clipping.
function layoutGraph(
  rawNodes: { id: string; size: number; data: FlowNodeData }[],
  rawEdges: { source: string; target: string }[],
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 56, ranksep: 110, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of rawNodes) {
    g.setNode(n.id, { width: n.size, height: n.size });
  }
  for (const e of rawEdges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return rawNodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: "op",
      position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 },
      data: n.data,
      draggable: true,
    };
  });
}

// Format a node id `op|model` back into a pretty inline display string.
function fmtId(id: string): string {
  const [op, model] = id.split("|");
  return op === model ? op : `${op} · ${model}`;
}

// Layout for the call-level (expanded) view. Each call gets a smaller box
// than the aggregate view; focus calls are larger than context. The edge
// set is derived from parent_span_id within the visible call set.
function layoutCallNodes(calls: ExpandedCall[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 70, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  const spanSet = new Set(calls.map((c) => c.span_id));
  for (const c of calls) {
    const s = c.is_focus ? 56 : 40;
    g.setNode(c.span_id, { width: s, height: s });
  }
  for (const c of calls) {
    if (c.parent_span_id && spanSet.has(c.parent_span_id)) {
      g.setEdge(c.parent_span_id, c.span_id);
    }
  }
  dagre.layout(g);

  return calls.map((c) => {
    const pos = g.node(c.span_id);
    const s = c.is_focus ? 56 : 40;
    const cData: CallNodeData = {
      spanId: c.span_id,
      shortId: c.span_id.slice(-6),
      status: c.status,
      latencyMs: c.latency_ms,
      costUsd: c.cost_usd,
      op: c.op === c.model ? c.op : `${c.op} · ${c.model}`,
      isFocus: c.is_focus,
    };
    return {
      id: c.span_id,
      type: "call",
      position: { x: pos.x - s / 2, y: pos.y - s / 2 },
      data: cData,
      draggable: true,
    };
  });
}

export default function FlowMapPage() {
  useDocumentTitle("Flow Map");
  const router = useRouter();
  const orgId = useOrgId();
  const [range, setRange] = useState(defaultRange);
  const enabled = !!orgId;

  const { data, isLoading, error, refetch } = useFlowGraph(
    { orgId: orgId ?? "", from: range.from, to: range.to, limit: 20 },
    enabled,
  );
  useApiError(error, refetch);

  // --- focus mode --------------------------------------------------------
  // focusId is the aggregate node ID the user double-clicked. When set, we
  // fetch its call-level breakdown and swap the canvas to render individual
  // calls (the "look inside this node" mode). The "Back" button clears it.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Find the aggregate node we're focused on (for op + model lookup).
  const focusedNode = useMemo(
    () => (focusId && data ? data.nodes.find((n) => n.id === focusId) ?? null : null),
    [focusId, data],
  );

  // Fetch call-level data when focused.
  const expandQuery = useNodeExpand(
    focusedNode
      ? {
          orgId: orgId ?? "",
          op: focusedNode.op,
          model: focusedNode.model,
          from: range.from,
          to: range.to,
          limit: 50,
        }
      : null,
    !!focusedNode && enabled,
  );
  useApiError(expandQuery.error, expandQuery.refetch);

  // --- transform API rows → React Flow nodes/edges -----------------------
  // Two paths: aggregate (no focus) and call-level (focus + expand data loaded).
  const { nodes, edges, nodeMap, edgeBySource } = useMemo(() => {
    // ── Call-level (expanded) mode ────────────────────────────────────────
    if (focusedNode && expandQuery.data) {
      const calls = expandQuery.data.calls;
      const spanSet = new Set(calls.map((c) => c.span_id));

      const reactNodes: Node[] = layoutCallNodes(calls);

      const reactEdges: Edge[] = [];
      for (const c of calls) {
        if (c.parent_span_id && spanSet.has(c.parent_span_id)) {
          reactEdges.push({
            id: `${c.parent_span_id}->${c.span_id}`,
            source: c.parent_span_id,
            target: c.span_id,
            type: "smoothstep",
            style: {
              stroke: c.status === "error" ? "#ef4444" : "#4a4a4a",
              strokeWidth: 1.5,
            },
          });
        }
      }
      // Empty maps — side panel in expanded mode shows call details from
      // expandQuery.data directly, not aggregate metadata.
      return {
        nodes: reactNodes,
        edges: reactEdges,
        nodeMap: new Map<string, GraphNode>(),
        edgeBySource: new Map<string, GraphEdge[]>(),
      };
    }

    // ── Aggregate (default) mode ──────────────────────────────────────────
    if (!data || data.nodes.length === 0) {
      return {
        nodes: [] as Node[],
        edges: [] as Edge[],
        nodeMap: new Map<string, GraphNode>(),
        edgeBySource: new Map<string, GraphEdge[]>(),
      };
    }
    const maxCalls = Math.max(...data.nodes.map((n) => n.calls), 1);

    const rawNodes = data.nodes.map((n) => {
      const r = nodeRadius(n.calls, maxCalls);
      const isWorkflow = n.kind === "workflow";
      const fnData: FlowNodeData = {
        label: n.op,
        // Workflow nodes have no model — don't render an empty chip under
        // the label. LLM nodes show the model when it differs from op.
        sublabel: isWorkflow
          ? undefined
          : (n.op === n.model ? undefined : n.model),
        errorRate: n.error_rate,
        radius: r,
        kind: isWorkflow ? "workflow" : "llm",
      };
      return { id: n.id, size: r * 2, data: fnData };
    });

    const layouted = layoutGraph(
      rawNodes,
      data.edges.map((e) => ({ source: e.from, target: e.to })),
    );

    const reactEdges: Edge[] = data.edges.map((e, i) => {
      const isSelfLoop = e.from === e.to;
      return {
        id: `e${i}`,
        source: e.from,
        target: e.to,
        type: isSelfLoop ? "default" : "smoothstep",
        animated: e.pct >= 0.5,
        label: `${(e.pct * 100).toFixed(0)}%`,
        labelStyle: { fill: "#888", fontSize: 10 },
        labelBgStyle: { fill: "#1c1c1c", fillOpacity: 0.85 },
        labelBgPadding: [3, 2],
        style: { stroke: "#4a4a4a", strokeWidth: edgeWidth(e.pct) },
      };
    });

    const nm = new Map(data.nodes.map((n) => [n.id, n]));
    const esBy = new Map<string, GraphEdge[]>();
    for (const e of data.edges) {
      if (!esBy.has(e.from)) esBy.set(e.from, []);
      esBy.get(e.from)!.push(e);
    }
    return { nodes: layouted, edges: reactEdges, nodeMap: nm, edgeBySource: esBy };
  }, [data, focusedNode, expandQuery.data]);

  // --- handlers ----------------------------------------------------------
  const onNodeClick: NodeMouseHandler = useCallback((_, n) => {
    setSelectedId(n.id);
  }, []);
  const onNodeDoubleClick: NodeMouseHandler = useCallback((_, n) => {
    // Only aggregate nodes are expandable. Calls (already inside a node) just
    // get selected; double-clicking one shouldn't recursively drill.
    if (focusedNode) return;
    setFocusId(n.id);
    setSelectedId(null);
  }, [focusedNode]);
  const onPaneClick = useCallback(() => setSelectedId(null), []);
  const exitFocus = useCallback(() => {
    setFocusId(null);
    setSelectedId(null);
  }, []);

  // Lookup helpers for the side panel.
  const selectedCall = useMemo<ExpandedCall | null>(() => {
    if (!focusedNode || !selectedId || !expandQuery.data) return null;
    return expandQuery.data.calls.find((c) => c.span_id === selectedId) ?? null;
  }, [focusedNode, selectedId, expandQuery.data]);

  const selectedNode = selectedId ? nodeMap.get(selectedId) ?? null : null;
  const selectedOut = (selectedId && edgeBySource.get(selectedId)) || [];
  const selectedIn = useMemo(() => {
    if (!selectedId || !data) return [] as GraphEdge[];
    return data.edges.filter((e) => e.to === selectedId);
  }, [selectedId, data]);

  // Drill into Traces filtered to (model + feature). Wires through the
  // existing query params Traces already understands.
  function drillToTraces(node: GraphNode) {
    const qs = new URLSearchParams({
      model: node.model,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    });
    // feature_name (NOT "feature") — must match the param Traces reads.
    // Sixth-pass review caught this: Flow Map and Regressions both used
    // "feature" but Traces parses "feature_name", so the drill-in
    // silently dropped the filter and returned the wrong dataset.
    if (node.op !== node.model) qs.set("feature_name", node.op);
    router.push(`/dashboard/traces?${qs}`);
  }

  const reactFlowProps: ReactFlowProps = {
    nodes: nodes.map((n) => ({ ...n, selected: n.id === selectedId })),
    edges,
    nodeTypes,
    onNodeClick,
    onNodeDoubleClick,
    onPaneClick,
    fitView: true,
    fitViewOptions: { padding: 0.15 },
    minZoom: 0.3,
    maxZoom: 2.5,
    proOptions: { hideAttribution: true },
    // Re-fit on focus changes so the focused subgraph centers nicely.
    // The key reset forces React Flow to re-mount when focusId changes.
    // (Cheaper than wiring a fitView callback through useReactFlow.)
  };

  // Call counts visible in the expanded view, for the header context line.
  const focusCallCount = expandQuery.data?.calls.filter((c) => c.is_focus).length ?? 0;
  const focusContextCount = expandQuery.data?.calls.filter((c) => !c.is_focus).length ?? 0;

  // On mobile we subtract extra height for the fixed bottom nav (~5rem) so the
  // canvas doesn't cover it. Use dvh to dodge iOS Safari's URL-bar height jitter.
  // On md+ the bottom nav doesn't exist, so 100vh-4rem (top header) is correct.
  return (
    <div className="h-[calc(100dvh-4rem-5rem)] md:h-[calc(100vh-4rem)] flex flex-col -m-4">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          {focusedNode ? (
            <>
              <button
                onClick={exitFocus}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-muted hover:bg-muted/80 text-xs font-medium transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to full graph
              </button>
              <Focus className="h-4 w-4 text-brand shrink-0" />
              <h1 className="text-base font-semibold truncate">
                Focused on <span className="text-brand">{focusedNode.op}</span>
              </h1>
              <span className="text-xs text-muted-foreground hidden md:inline">
                · {focusCallCount} call{focusCallCount === 1 ? "" : "s"}
                {focusContextCount > 0 && ` + ${focusContextCount} context`}
              </span>
            </>
          ) : (
            <>
              <Share2 className="h-4 w-4 text-muted-foreground" />
              <h1 className="text-lg font-semibold">Flow Map</h1>
              <span className="text-xs text-muted-foreground hidden sm:inline">
                Single-click to inspect · Double-click a node to look inside it
              </span>
            </>
          )}
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {/* ── Main split: canvas + right panel ────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Canvas */}
        <div className="flex-1 relative bg-muted/20">
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              Loading flow graph…
            </div>
          ) : error ? (
            <div className="absolute inset-0 flex items-center justify-center px-6">
              <ErrorState title="Couldn't load the flow graph" error={error} onRetry={refetch} />
            </div>
          ) : focusedNode && expandQuery.isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              Loading calls inside {focusedNode.op}…
            </div>
          ) : focusedNode && expandQuery.error ? (
            <div className="absolute inset-0 flex items-center justify-center px-6">
              <ErrorState title={`Couldn't expand "${focusedNode.op}"`} error={expandQuery.error} onRetry={() => expandQuery.refetch()} />
            </div>
          ) : focusedNode && expandQuery.data && expandQuery.data.calls.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
              No calls of {focusedNode.op} in this window.
            </div>
          ) : !data || data.nodes.length === 0 ? (
            <EmptyState />
          ) : !focusedNode && data.nodes.length < 2 ? (
            <SingleNodeHint node={data.nodes[0]} />
          ) : (
            <ReactFlow key={focusId ?? "__full__"} {...reactFlowProps}>
              {/* Canvas chrome — theme-aware, not hardcoded #2a2a2a / #1a1a1a.
                  React Flow's color/style props accept CSS variables; we
                  use the same `--color-border` / `--color-card` tokens
                  the rest of the dashboard pulls from, so the Flow Map
                  looks coherent in both light and dark themes. (User
                  requested round 6 — "use the tag theme, not black-and-
                  white"). */}
              <Background gap={20} size={1} color="var(--color-border)" />
              <Controls position="bottom-right" showInteractive={false} />
              {!focusedNode && (
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(n) => {
                    const d = n.data as FlowNodeData;
                    if (d.errorRate >= 0.03) return "#ef4444";
                    if (d.errorRate >= 0.01) return "#f59e0b";
                    // Healthy nodes show the brand purple in the mini-map
                    // — matches the soft brand tint the real nodes now use.
                    return "#7c3aed";
                  }}
                  // 85% backdrop over the canvas. color-mix works in both
                  // themes — falls back to a translucent surface colour.
                  maskColor="color-mix(in oklch, var(--color-background) 85%, transparent)"
                  style={{
                    background: "var(--color-card)",
                    border: "1px solid var(--color-border)",
                  }}
                />
              )}
            </ReactFlow>
          )}

          {/* Legend — encoding swaps between aggregate and expanded modes. */}
          {data && data.nodes.length >= 2 && !focusedNode && (
            <div className="absolute bottom-3 left-3 bg-background/90 backdrop-blur border border-border rounded-md px-3 py-2 text-[10px] text-muted-foreground space-y-1">
              <div className="font-semibold text-foreground mb-1">Legend</div>
              <LegendRow swatch="#7c3aed" label="Healthy (<1% err)" />
              <LegendRow swatch="#f59e0b" label="Watch (1–3% err)" />
              <LegendRow swatch="#ef4444" label="Alert (>3% err)" />
              <div>Node size = call volume</div>
              <div>Edge width = transition frequency</div>
            </div>
          )}
          {focusedNode && expandQuery.data && expandQuery.data.calls.length > 0 && (
            <div className="absolute bottom-3 left-3 bg-background/90 backdrop-blur border border-border rounded-md px-3 py-2 text-[10px] text-muted-foreground space-y-1">
              <div className="font-semibold text-foreground mb-1">Inside this node</div>
              <LegendRow swatch="#10b981" label="Successful call" />
              <LegendRow swatch="#ef4444" label="Errored call" />
              <LegendRow swatch="#f59e0b" label="Timed out" />
              <div>Large = this op&apos;s calls · Small = context (parent/child)</div>
              <div>Edges = real parent→child links</div>
            </div>
          )}
        </div>

        {/* Right panel — content depends on mode and selection. */}
        <div className="w-80 border-l border-border bg-background overflow-y-auto">
          {focusedNode && selectedCall ? (
            <CallDetailPanel
              call={selectedCall}
              onOpenTrace={() => router.push(`/dashboard/traces/${selectedCall.trace_id}?span=${selectedCall.span_id}`)}
            />
          ) : focusedNode ? (
            <ExpandedHint focusedNode={focusedNode} count={focusCallCount} />
          ) : selectedNode ? (
            <DetailPanel
              node={selectedNode}
              inbound={selectedIn}
              outbound={selectedOut}
              onDrill={() => drillToTraces(selectedNode)}
            />
          ) : (
            <div className="p-6 text-center text-xs text-muted-foreground space-y-2">
              <Share2 className="h-6 w-6 mx-auto opacity-40" />
              <p>Click a node to inspect.</p>
              <p className="text-[11px]">
                Each node = an operation (feature_name + model). Edges are
                parent→child relationships aggregated across all traces in the window.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LegendRow({ swatch, label }: { swatch: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block w-2.5 h-2.5 rounded-full"
        style={{ background: swatch }}
      />
      <span>{label}</span>
    </div>
  );
}

function DetailPanel({
  node,
  inbound,
  outbound,
  onDrill,
}: {
  node: GraphNode;
  inbound: GraphEdge[];
  outbound: GraphEdge[];
  onDrill: () => void;
}) {
  // Inline status text — round-6 theme review: -400 shades read on dark
  // but vanish on the light cream surface. -600 dark:-400 gives both.
  const errClass =
    node.error_rate >= 0.03 ? "text-red-600 dark:text-red-400"
    : node.error_rate >= 0.01 ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400";
  return (
    <div className="p-4 space-y-4">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Node</p>
        <h2 className="text-sm font-semibold">{node.op}</h2>
        <p className="text-xs text-muted-foreground">{node.model}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric label="Calls" value={node.calls.toLocaleString()} />
        <Metric label="Avg latency" value={`${Math.round(node.avg_latency_ms)}ms`} />
        <Metric label="Total cost" value={money(node.total_cost_usd)} />
        <Metric label="Error rate" value={`${(node.error_rate * 100).toFixed(2)}%`} className={errClass} />
        <Metric label="P99 latency" value={`${Math.round(node.p99_latency_ms)}ms`} />
        <Metric label="Errors" value={node.error_count.toLocaleString()} />
      </div>

      <Section title="Top inbound">
        {inbound.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Entry point — no inbound traffic</p>
        ) : (
          inbound
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
            .map((e, i) => (
              <ConnRow key={i} from={fmtId(e.from)} to={node.op} pct={e.pct} count={e.count} />
            ))
        )}
      </Section>

      <Section title="Top outbound">
        {outbound.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Terminal node</p>
        ) : (
          outbound
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
            .map((e, i) => (
              <ConnRow key={i} from={node.op} to={fmtId(e.to)} pct={e.pct} count={e.count} />
            ))
        )}
      </Section>

      <button
        onClick={onDrill}
        className="w-full inline-flex items-center justify-center gap-2 bg-brand hover:bg-brand/90 text-white text-xs font-medium px-3 py-2 rounded-md transition-colors"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        View traces involving this node
      </button>
    </div>
  );
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="p-2.5 border border-border rounded-md bg-card">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${className ?? ""}`}>{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pt-3 border-t border-border">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function ConnRow({ from, to, pct, count }: { from: string; to: string; pct: number; count: number }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className="truncate">{from}</span>
        <ArrowRight className="h-3 w-3 text-brand shrink-0" />
        <span className="truncate">{to}</span>
      </div>
      <span className="text-muted-foreground tabular-nums shrink-0 ml-2">
        {(pct * 100).toFixed(0)}% · {count.toLocaleString()}
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-sm gap-3 px-6">
      <Share2 className="h-8 w-8 text-muted-foreground opacity-40" />
      <p className="font-semibold">No traces in this window</p>
      <p className="text-xs text-muted-foreground max-w-sm">
        The Flow Map aggregates operations across traces. Once your SDK starts
        streaming calls, you&apos;ll see the structure of your LLM app here.
      </p>
      <Link
        href="/dashboard"
        className="text-xs text-brand hover:underline mt-1"
      >
        ← Back to Overview
      </Link>
    </div>
  );
}

function CallDetailPanel({ call, onOpenTrace }: { call: ExpandedCall; onOpenTrace: () => void }) {
  const statusColor =
    call.status === "error" ? "text-red-600 dark:text-red-400" :
    call.status === "timeout" ? "text-amber-600 dark:text-amber-400" :
    call.status === "rate_limited" ? "text-purple-600 dark:text-purple-400" :
    "text-emerald-600 dark:text-emerald-400";
  return (
    <div className="p-4 space-y-4">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {call.is_focus ? "Focus call" : "Context call"}
        </p>
        <h2 className="text-sm font-semibold font-mono break-all">{call.span_id}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{call.op} · {call.model}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric label="Status" value={call.status} className={statusColor} />
        <Metric label="Latency" value={`${call.latency_ms}ms`} />
        <Metric label="Cost" value={money(call.cost_usd)} />
        <Metric label="Trace" value={call.trace_id.slice(0, 8) + "…"} className="font-mono text-xs" />
      </div>

      <div className="pt-3 border-t border-border">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Timestamp</p>
        <p className="text-xs font-mono">{new Date(call.timestamp).toLocaleString()}</p>
      </div>

      {call.parent_span_id && (
        <div className="pt-3 border-t border-border">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Parent span</p>
          <p className="text-xs font-mono break-all">{call.parent_span_id}</p>
        </div>
      )}

      <button
        onClick={onOpenTrace}
        className="w-full inline-flex items-center justify-center gap-2 bg-brand hover:bg-brand/90 text-white text-xs font-medium px-3 py-2 rounded-md transition-colors"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open trace
      </button>
    </div>
  );
}

function ExpandedHint({ focusedNode, count }: { focusedNode: GraphNode; count: number }) {
  return (
    <div className="p-6 text-center text-xs text-muted-foreground space-y-2">
      <Focus className="h-6 w-6 mx-auto opacity-40 text-brand" />
      <p className="font-semibold text-foreground">Inside {focusedNode.op}</p>
      <p className="text-[11px]">
        Showing {count} individual call{count === 1 ? "" : "s"} of this operation, plus their
        immediate parents and children (faded). Click any circle to inspect, or
        click <em>Back to full graph</em> to return.
      </p>
    </div>
  );
}

function SingleNodeHint({ node }: { node: GraphNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-sm gap-3 px-6">
      <Share2 className="h-8 w-8 text-muted-foreground opacity-40" />
      <p className="font-semibold">Only one operation detected</p>
      <p className="text-xs text-muted-foreground max-w-sm">
        Your app calls <span className="font-mono text-foreground">{node.op}</span>{" "}
        ({node.calls.toLocaleString()} calls), but the Flow Map needs multiple
        connected operations to be useful. Either widen the time range, or this
        view will get interesting once your app starts chaining LLM calls.
      </p>
    </div>
  );
}
