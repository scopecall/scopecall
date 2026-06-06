"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";

// Data carried by a call-level node in the expanded view.
// Compact compared to FlowNode — there are 50+ of these on screen at once.
export interface CallNodeData {
  spanId: string;
  shortId: string;       // last 6 chars of span_id — enough to disambiguate visually
  status: string;        // success | error | timeout | rate_limited
  latencyMs: number;
  costUsd: number;
  op?: string;           // for context (non-focus) nodes — shows the parent/child's op
  isFocus: boolean;
  selected?: boolean;
  [key: string]: unknown;
}

// Status → color map. Mirrors the trace-detail page so visual encoding is
// consistent across the dashboard.
//
// Theme-awareness: text-{color}-100 reads against dark backgrounds but is
// near-white on the light theme — invisible against the cream surface.
// Use -700/-300 dark variants for the label, and drop the "success" tint
// entirely (parity with flow-node.tsx tint() — green-everywhere was loud).
function statusColor(status: string, isFocus: boolean) {
  // Context calls (parents/children of focus) get dimmed so the focus reads
  // as the "subject" and surrounding calls as "context."
  const dim = isFocus ? "" : "opacity-50";
  switch (status) {
    case "error":
      return {
        ring: "border-red-500/60",
        fill: "bg-red-500/10",
        text: "text-red-700 dark:text-red-300",
        dim,
      };
    case "timeout":
      return {
        ring: "border-amber-500/60",
        fill: "bg-amber-500/10",
        text: "text-amber-700 dark:text-amber-300",
        dim,
      };
    case "rate_limited":
      return {
        ring: "border-purple-500/60",
        fill: "bg-purple-500/10",
        text: "text-purple-700 dark:text-purple-300",
        dim,
      };
    default:
      // Successful calls — inherit the surface chrome. No tint by default;
      // colored tint = "look here." Green everywhere was unreadable on
      // light theme.
      return {
        ring: "border-border",
        fill: "bg-card",
        text: "text-foreground",
        dim,
      };
  }
}

export function CallNode({ data, selected }: NodeProps) {
  const d = data as CallNodeData;
  const c = statusColor(d.status, d.isFocus);
  // Focus calls are larger; context calls smaller to recede visually.
  const size = d.isFocus ? 56 : 40;

  return (
    <div
      className={cn("relative flex items-center justify-center", c.dim)}
      style={{ width: size, height: size }}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />

      <div
        className={cn(
          "rounded-full border flex flex-col items-center justify-center text-center px-1",
          "transition-all duration-150",
          c.fill,
          c.ring,
          selected
            ? "ring-2 ring-brand/70 ring-offset-2 ring-offset-background scale-110"
            : "hover:scale-110",
        )}
        style={{ width: size, height: size }}
      >
        <span
          className={cn(
            "font-mono leading-tight",
            d.isFocus ? "text-[10px]" : "text-[8px]",
            c.text,
          )}
        >
          {d.shortId}
        </span>
        {!d.isFocus && d.op && (
          <span className="text-[7px] text-muted-foreground leading-none truncate max-w-full">
            {d.op}
          </span>
        )}
      </div>
    </div>
  );
}
