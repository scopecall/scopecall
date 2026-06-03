"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { components } from "@/lib/api-types";

type Trace = components["schemas"]["Trace"];

interface TraceGanttProps {
  spans: Trace[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// Status → bar colour. Different problems get different visual identity so
// failures stand out at a glance against the dense bar field.
const STATUS_COLOR: Record<string, string> = {
  success:      "bg-primary",
  error:        "bg-red-500",
  timeout:      "bg-amber-500",
  rate_limited: "bg-purple-500",
};

// Compute each span's depth in the parent_span_id tree. Spans with missing
// parents (orphans) are treated as roots — graceful degradation if a chain breaks.
function computeDepths(spans: Trace[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const cache = new Map<string, number>();
  function depthOf(id: string, seen = new Set<string>()): number {
    if (cache.has(id)) return cache.get(id)!;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const s = byId.get(id);
    if (!s || !s.parent_span_id || !byId.has(s.parent_span_id)) {
      cache.set(id, 0);
      return 0;
    }
    const d = 1 + depthOf(s.parent_span_id, seen);
    cache.set(id, d);
    return d;
  }
  for (const s of spans) depthOf(s.span_id);
  return cache;
}

function spanLabel(s: Trace): string {
  return (s.feature_name ?? "") !== "" ? (s.feature_name as string) : s.model;
}

export function TraceGantt({ spans, selectedId, onSelect }: TraceGanttProps) {
  // Sort spans chronologically — gantt rows top-to-bottom mirror time. Depth
  // applies as label indentation (not row position), so parallel sub-spans
  // still appear at their actual start times rather than under their parent.
  const sorted = useMemo(
    () => [...spans].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    [spans],
  );
  const depths = useMemo(() => computeDepths(spans), [spans]);

  const traceStart = useMemo(
    () => sorted.length > 0 ? new Date(sorted[0].timestamp).getTime() : 0,
    [sorted],
  );
  const traceEnd = useMemo(
    () => sorted.reduce((m, s) => Math.max(m, new Date(s.timestamp).getTime() + s.latency_ms), traceStart),
    [sorted, traceStart],
  );
  const totalMs = Math.max(1, traceEnd - traceStart);

  // Build 5 tick marks at 0% / 25% / 50% / 75% / 100% for orientation.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => ({
    pct: p * 100,
    ms: Math.round(p * totalMs),
  }));

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      {/* Header row with timeline ticks */}
      <div className="grid grid-cols-[200px_1fr] border-b border-border bg-muted/30 text-[10px] text-muted-foreground uppercase tracking-wider">
        <div className="px-3 py-1.5">Span</div>
        <div className="relative h-6">
          {ticks.map((t) => (
            <div
              key={t.pct}
              className="absolute top-1.5 text-[10px] tabular-nums"
              style={{ left: `${t.pct}%`, transform: t.pct === 100 ? "translateX(-100%)" : "translateX(0)" }}
            >
              {t.ms}ms
            </div>
          ))}
        </div>
      </div>

      {/* Rows */}
      <div className="divide-y divide-border">
        {sorted.map((s) => {
          const startOffset = new Date(s.timestamp).getTime() - traceStart;
          const leftPct = (startOffset / totalMs) * 100;
          // Floor of 0.5% width keeps very short spans visible — otherwise sub-ms
          // spans render as invisible slivers.
          const widthPct = Math.max(0.5, (s.latency_ms / totalMs) * 100);
          const depth = depths.get(s.span_id) ?? 0;
          const isSelected = selectedId === s.span_id;
          const color = STATUS_COLOR[s.status] ?? "bg-primary";

          return (
            <button
              key={s.span_id}
              onClick={() => onSelect(s.span_id)}
              className={cn(
                "grid grid-cols-[200px_1fr] w-full text-left text-sm transition-colors",
                isSelected ? "bg-muted" : "hover:bg-muted/40",
              )}
            >
              {/* Label column — indented by tree depth */}
              <div
                className="px-3 py-2 truncate font-mono text-xs"
                style={{ paddingLeft: `${depth * 12 + 12}px` }}
              >
                {spanLabel(s)}
              </div>

              {/* Bar column */}
              <div className="relative h-9 flex items-center">
                <div
                  className={cn(
                    "absolute h-3.5 rounded-sm transition-opacity",
                    color,
                    isSelected ? "opacity-100" : "opacity-75 group-hover:opacity-100",
                  )}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={`${spanLabel(s)} · ${s.latency_ms}ms · ${s.status}`}
                />
                {/* Inline metric to the right of the bar */}
                <span
                  className="absolute text-[10px] text-muted-foreground tabular-nums whitespace-nowrap pointer-events-none"
                  style={{ left: `calc(${leftPct + widthPct}% + 6px)` }}
                >
                  {s.latency_ms}ms
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
