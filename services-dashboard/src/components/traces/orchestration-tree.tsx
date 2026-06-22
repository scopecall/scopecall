"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { money, num } from "@/lib/format";
import type { components } from "@/lib/api-types";

type Trace = components["schemas"]["Trace"];
type Node = Trace & { children: Node[] };

// Kind → badge styling. The container kinds (workflow/agent/step) get their
// own colour so the orchestration hierarchy reads at a glance; llm leaves are
// neutral. Mirrors the dashboard's translucent status-pill treatment.
const KIND_BADGE: Record<string, string> = {
  workflow: "bg-primary/15 text-primary border-primary/30",
  agent: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  step: "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  llm: "bg-muted text-muted-foreground border-border",
};

const STATUS_DOT: Record<string, string> = {
  success: "bg-emerald-500",
  error: "bg-red-500",
  timeout: "bg-amber-500",
  rate_limited: "bg-purple-500",
};

interface Rollup {
  cost: number;
  calls: number;
  errors: number;
  retries: number;
  models: Set<string>;
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

function buildTree(spans: Trace[]): Node[] {
  const byId = new Map<string, Node>();
  for (const s of spans) byId.set(s.span_id, { ...s, children: [] });
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const parent = n.parent_span_id ? byId.get(n.parent_span_id) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const sortRec = (ns: Node[]) => {
    ns.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    ns.forEach((c) => sortRec(c.children));
  };
  sortRec(roots);
  return roots;
}

// Roll up llm cost / call-count / error / retry / models across a node's
// whole subtree (including itself when it's an llm leaf). Container spans
// carry zero cost of their own — the value is what their descendants spent.
function rollup(n: Node): Rollup {
  const r: Rollup = { cost: 0, calls: 0, errors: 0, retries: 0, models: new Set() };
  const visit = (node: Node) => {
    if ((node.kind ?? "llm") === "llm") {
      r.cost += node.cost_usd || 0;
      r.calls += 1;
      if (node.status !== "success") r.errors += 1;
      if ((node.attempt_number ?? 1) > 1) r.retries += 1;
      if (node.model) r.models.add(node.model);
    }
    node.children.forEach(visit);
  };
  visit(n);
  return r;
}

function nodeLabel(n: Node): string {
  if ((n.feature_name ?? "") !== "") return n.feature_name as string;
  if ((n.kind ?? "llm") === "llm") return n.model || "llm call";
  return n.kind ?? "span";
}

interface OrchestrationTreeProps {
  spans: Trace[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Orchestration view: the full workflow → agent → step → llm tree for one
 * trace, with cost / latency / calls / errors / retries rolled up at every
 * level. Parallel fan-out (e.g. an OpenAI + Gemini consensus under one step)
 * shows as sibling rows under a shared guide line. Complements the Timeline
 * (which is time-ordered) by making the orchestration structure explicit.
 */
export function OrchestrationTree({ spans, selectedId, onSelect }: OrchestrationTreeProps) {
  const roots = useMemo(() => buildTree(spans), [spans]);

  const renderNode = (n: Node, depth: number): React.ReactNode => {
    const kind = n.kind ?? "llm";
    const isLeaf = kind === "llm";
    const r = rollup(n);
    const selected = selectedId === n.span_id;
    const dot = STATUS_DOT[n.status] ?? "bg-muted-foreground";

    return (
      <div key={n.span_id}>
        <button
          onClick={() => onSelect(n.span_id)}
          className={cn(
            "group grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-md py-1.5 pr-2 text-left text-sm transition-colors",
            selected ? "bg-muted" : "hover:bg-muted/40",
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {/* Left: guide + kind badge + name */}
          <div className="flex min-w-0 items-center gap-2">
            {depth > 0 && (
              <span className="text-muted-foreground/40 select-none">└</span>
            )}
            <span
              className={cn(
                "shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                KIND_BADGE[kind] ?? KIND_BADGE.llm,
              )}
            >
              {kind}
            </span>
            <span
              className={cn(
                "truncate",
                isLeaf ? "font-mono text-xs" : "font-medium",
              )}
            >
              {nodeLabel(n)}
            </span>
            {isLeaf && n.provider && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {n.provider}
              </span>
            )}
            {(n.attempt_number ?? 1) > 1 && (
              <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/15 px-1 text-[9px] font-medium text-amber-700 dark:text-amber-300">
                retry{n.retry_reason ? ` · ${n.retry_reason}` : ""}
              </span>
            )}
          </div>

          {/* Right: rolled-up metrics */}
          <div className="flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
            {!isLeaf && r.calls > 0 && (
              <span title="LLM calls in this subtree">{r.calls} {r.calls === 1 ? "call" : "calls"}</span>
            )}
            {(r.errors > 0) && (
              <span className="text-red-600 dark:text-red-400" title="errors in subtree">
                {r.errors} err
              </span>
            )}
            {isLeaf && (
              <span title="tokens in → out">
                {num(n.input_tokens)}→{num(n.output_tokens)}
              </span>
            )}
            <span title="latency">{fmtMs(n.latency_ms)}</span>
            <span className="w-16 text-right font-medium text-foreground" title="cost (rolled up)">
              {money(r.cost)}
            </span>
            {isLeaf && (
              <span className={cn("size-1.5 rounded-full", dot)} title={n.status} />
            )}
          </div>
        </button>
        {n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  if (roots.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-[11px] text-muted-foreground">
        No spans to orchestrate.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card p-1">
      {/* the nested border-l guides already indent; render roots flush */}
      {roots.map((n) => renderNode(n, 0))}
    </div>
  );
}
