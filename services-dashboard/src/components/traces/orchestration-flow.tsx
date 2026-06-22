"use client";

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  BaseEdge,
  getBezierPath,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { money } from "@/lib/format";
import type { components } from "@/lib/api-types";

type Trace = components["schemas"]["Trace"];

// Cost is the load-bearing signal: edge dot speed/size + node cost-bar scale
// with dollars. Kind sets card identity; provider tints llm leaves.
const KIND_CHIP: Record<string, string> = {
  workflow: "bg-primary/15 text-primary",
  agent: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  step: "bg-purple-500/15 text-purple-600 dark:text-purple-300",
  llm: "bg-muted text-muted-foreground",
};
const KIND_RING: Record<string, string> = {
  workflow: "var(--color-primary)",
  agent: "#3b82f6",
  step: "#a855f7",
  llm: "#64748b",
};
const PROVIDER_ACCENT: Record<string, string> = {
  openai: "#10b981",
  google: "#8b5cf6",
  anthropic: "#f59e0b",
};
const STATUS_DOT: Record<string, string> = {
  success: "#10b981",
  error: "#ef4444",
  timeout: "#f59e0b",
  rate_limited: "#a855f7",
};

const NODE_W = 208;
const NODE_H = 74;
const COL = NODE_W + 72; // spine horizontal spacing
const ROW = NODE_H + 20; // branch vertical spacing

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

interface OrchData extends Record<string, unknown> {
  kind: string;
  name: string;
  provider?: string;
  cost: number;
  costPct: number;
  latencyMs: number;
  calls: number;
  errors: number;
  retries: number;
  status?: string;
  accent: string;
  spine: boolean;
  delayMs: number;
}

// ── custom node ──────────────────────────────────────────────────────────────
function OrchestrationNode({ data, selected }: NodeProps) {
  const d = data as OrchData;
  const isLeaf = d.kind === "llm";
  return (
    <div className="sc-orch-node" style={{ width: NODE_W, height: NODE_H, animationDelay: `${d.delayMs}ms` }}>
      {/* four hidden handles: spine flows r→l, branches flow b→t */}
      <Handle id="l" type="target" position={Position.Left} className="!opacity-0 !border-0" />
      <Handle id="t" type="target" position={Position.Top} className="!opacity-0 !border-0" />
      <Handle id="r" type="source" position={Position.Right} className="!opacity-0 !border-0" />
      <Handle id="b" type="source" position={Position.Bottom} className="!opacity-0 !border-0" />
      <div
        className={cn(
          "relative h-full w-full overflow-hidden rounded-lg border bg-card px-3 py-2 transition-all duration-200",
          selected ? "scale-[1.03]" : "hover:scale-[1.02]",
        )}
        style={{
          borderColor: selected ? d.accent : "var(--color-border)",
          boxShadow: selected ? `0 0 0 1px ${d.accent}, 0 10px 28px -10px ${d.accent}90` : "0 1px 2px rgba(0,0,0,0.18)",
        }}
      >
        <span className="absolute left-0 top-0 h-full w-[3px]" style={{ background: d.accent }} />
        <div className="flex items-center gap-1.5">
          <span className={cn("rounded px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide", KIND_CHIP[d.kind] ?? KIND_CHIP.llm)}>
            {d.kind}
          </span>
          <span className={cn("truncate text-[12px] font-semibold text-foreground", isLeaf && "font-mono text-[11px]")}>{d.name}</span>
          {isLeaf && d.status && <span className="ml-auto size-1.5 shrink-0 rounded-full" style={{ background: STATUS_DOT[d.status] ?? "#64748b" }} />}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{money(d.cost)}</span>
          <span>·</span>
          <span>{fmtMs(d.latencyMs)}</span>
          {!isLeaf && d.calls > 0 && (<><span>·</span><span>{d.calls} {d.calls === 1 ? "call" : "calls"}</span></>)}
          {d.retries > 0 && <span className="ml-auto rounded bg-amber-500/15 px-1 text-[8px] font-medium text-amber-600 dark:text-amber-300">↻{d.retries}</span>}
          {d.errors > 0 && <span className={cn("rounded bg-red-500/15 px-1 text-[8px] font-medium text-red-600 dark:text-red-300", d.retries > 0 ? "" : "ml-auto")}>{d.errors} err</span>}
        </div>
        <div className="absolute bottom-0 left-0 h-[2px] w-full bg-border/40">
          <span className="sc-orch-bar block h-full" style={{ width: `${Math.max(2, d.costPct * 100)}%`, background: d.accent }} />
        </div>
      </div>
    </div>
  );
}

// ── custom animated edge: a glowing dot travels source → target ───────────────
function FlowEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const color = (data?.color as string) ?? "var(--color-primary)";
  const width = (data?.width as number) ?? 1.5;
  const spine = Boolean(data?.spine);
  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={{ stroke: color, strokeWidth: width, opacity: spine ? 0.55 : 0.3 }} />
      <circle r={spine ? 3.2 : 2.1} fill={color} style={{ filter: `drop-shadow(0 0 3px ${color})` }}>
        <animateMotion dur={spine ? "2.4s" : "3.2s"} repeatCount="indefinite" path={edgePath} />
      </circle>
    </>
  );
}

const nodeTypes = { orch: OrchestrationNode };
const edgeTypes = { flow: FlowEdge };

// ── tree + rollup ────────────────────────────────────────────────────────────
type TNode = Trace & { children: TNode[] };
function ts(n: Trace) { return new Date(n.timestamp).getTime(); }

function buildTree(spans: Trace[]) {
  const byId = new Map<string, TNode>();
  for (const s of spans) byId.set(s.span_id, { ...s, children: [] });
  const roots: TNode[] = [];
  for (const n of byId.values()) {
    const p = n.parent_span_id ? byId.get(n.parent_span_id) : undefined;
    if (p) p.children.push(n);
    else roots.push(n);
  }
  for (const n of byId.values()) n.children.sort((a, b) => ts(a) - ts(b));
  roots.sort((a, b) => ts(a) - ts(b));
  return { roots, byId };
}

function rollup(n: TNode) {
  let cost = 0, calls = 0, errors = 0, retries = 0;
  const visit = (node: TNode) => {
    if ((node.kind ?? "llm") === "llm") {
      cost += node.cost_usd || 0;
      calls += 1;
      if (node.status !== "success") errors += 1;
      if ((node.attempt_number ?? 1) > 1) retries += 1;
    }
    node.children.forEach(visit);
  };
  visit(n);
  return { cost, calls, errors, retries };
}

function nodeName(n: TNode): string {
  if ((n.feature_name ?? "") !== "") return n.feature_name as string;
  if ((n.kind ?? "llm") === "llm") return n.model || "llm call";
  return n.kind ?? "span";
}

interface OrchestrationFlowProps {
  spans: Trace[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function OrchestrationFlow({ spans, selectedId, onSelect }: OrchestrationFlowProps) {
  const { nodes, edges } = useMemo(() => {
    const { roots, byId } = buildTree(spans);
    const all = [...byId.values()];
    if (all.length === 0) return { nodes: [] as Node[], edges: [] as Edge[] };

    const roll = new Map<string, ReturnType<typeof rollup>>();
    for (const n of all) roll.set(n.span_id, rollup(n));
    const maxCost = Math.max(1e-9, ...all.map((n) => roll.get(n.span_id)!.cost));

    const pos = new Map<string, { x: number; y: number }>();
    const spineIds = new Set<string>();

    // The spine = each root (workflow) followed by its direct children
    // (the agents / stages), laid left→right in execution (timestamp) order.
    // Everything deeper (steps, llm/tool calls) branches DOWN under its stage.
    let col = 0;
    const placeBranch = (node: TNode, stageCol: number, startRow: { r: number }, depth: number) => {
      node.children.forEach((child) => {
        startRow.r += 1;
        pos.set(child.span_id, { x: stageCol * COL + depth * 20, y: startRow.r * ROW });
        placeBranch(child, stageCol, startRow, depth + 1);
      });
    };

    for (const root of roots) {
      pos.set(root.span_id, { x: col * COL, y: 0 });
      spineIds.add(root.span_id);
      col += 1;
      for (const stage of root.children) {
        pos.set(stage.span_id, { x: col * COL, y: 0 });
        spineIds.add(stage.span_id);
        placeBranch(stage, col, { r: 0 }, 0);
        col += 1;
      }
    }

    const rfNodes: Node[] = all.map((n) => {
      const p = pos.get(n.span_id) ?? { x: 0, y: 0 };
      const r = roll.get(n.span_id)!;
      const kind = n.kind ?? "llm";
      const provider = (n.provider ?? "").toLowerCase();
      const accent = kind === "llm" ? PROVIDER_ACCENT[provider] ?? KIND_RING.llm : KIND_RING[kind] ?? KIND_RING.llm;
      const data: OrchData = {
        kind, name: nodeName(n), provider: n.provider ?? undefined,
        cost: r.cost, costPct: r.cost / maxCost, latencyMs: n.latency_ms,
        calls: r.calls, errors: r.errors, retries: r.retries, status: n.status,
        accent, spine: spineIds.has(n.span_id), delayMs: Math.round((p.x / COL) * 70),
      };
      return { id: n.span_id, type: "orch", position: p, data, selected: selectedId === n.span_id };
    });

    const rfEdges: Edge[] = [];
    // Spine sequence edges (synthetic, left→right): root → stage0 → stage1 …
    for (const root of roots) {
      const chain = [root, ...root.children];
      for (let i = 0; i < chain.length - 1; i++) {
        rfEdges.push({
          id: `spine-${chain[i].span_id}-${chain[i + 1].span_id}`,
          source: chain[i].span_id, target: chain[i + 1].span_id,
          sourceHandle: "r", targetHandle: "l", type: "flow",
          data: { color: "var(--color-primary)", width: 2.25, spine: true },
          markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-primary)", width: 16, height: 16 },
        });
      }
    }
    // Branch edges (downward): each stage → its calls, step → llm, etc.
    const rootIds = new Set(roots.map((r) => r.span_id));
    for (const n of all) {
      if (!n.parent_span_id || !byId.has(n.parent_span_id)) continue;
      if (rootIds.has(n.parent_span_id)) continue; // root→stage is the spine
      const r = roll.get(n.span_id)!;
      const color = r.errors > 0 ? "#ef4444" : "var(--color-primary)";
      rfEdges.push({
        id: `b-${n.parent_span_id}-${n.span_id}`,
        source: n.parent_span_id as string, target: n.span_id,
        sourceHandle: "b", targetHandle: "t", type: "flow",
        data: { color, width: 1 + (r.cost / maxCost) * 3, spine: false },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
      });
    }

    return { nodes: rfNodes, edges: rfEdges };
  }, [spans, selectedId]);

  if (nodes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-[11px] text-muted-foreground">
        No spans to orchestrate.
      </div>
    );
  }

  return (
    <div className="relative h-[460px] w-full overflow-hidden rounded-lg border border-border bg-card">
      <style>{`
        .sc-orch-node { animation: scOrchIn 380ms cubic-bezier(0.22,1,0.36,1) both; }
        @keyframes scOrchIn { from { opacity: 0; transform: translateY(6px) scale(0.97); } to { opacity: 1; transform: none; } }
        .sc-orch-bar { animation: scOrchBar 700ms cubic-bezier(0.22,1,0.36,1) both; transform-origin: left; }
        @keyframes scOrchBar { from { transform: scaleX(0); } to { transform: scaleX(1); } }
        /* Theme React Flow's controls to match the dark dashboard chrome
           (default is a white pill — jarring against the dark surface). */
        .react-flow__controls { box-shadow: none !important; border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; background: var(--color-card); }
        .react-flow__controls-button { background: var(--color-card); border-bottom: 1px solid var(--color-border); width: 22px; height: 22px; }
        .react-flow__controls-button:hover { background: var(--color-muted); }
        .react-flow__controls-button svg { fill: var(--color-muted-foreground); }
        .react-flow__attribution { display: none; }
      `}</style>
      {/* INPUT → OUTPUT orientation hint */}
      <div className="pointer-events-none absolute left-3 top-2 z-10 flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/70">
        <span>input</span><span className="text-primary">→</span><span>execution</span><span className="text-primary">→</span><span>output</span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.25}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="!opacity-40" />
        <Controls showInteractive={false} className="!shadow-none" />
      </ReactFlow>
    </div>
  );
}
