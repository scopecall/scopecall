"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";

// FlowNodeData carries everything we need to render one node + sync the side
// panel on hover. radius is derived from call volume (computed in the page),
// errClass from error rate. We pass them precomputed because React Flow
// re-renders every node on any selection change — avoid per-node arithmetic.
export interface FlowNodeData {
  label: string;
  sublabel?: string;
  /** 0..1 — drives stroke colour */
  errorRate: number;
  /** node radius in px, precomputed from volume */
  radius: number;
  selected?: boolean;
  /**
   * "llm" | "workflow". Workflow nodes are sdk.trace() containers — they
   * have no model and zero cost, and represent the user's logical block
   * around a fan-out of LLM calls. Render as a rounded SQUARE (not a
   * circle) so the user can read the structure of the graph at a glance:
   * containers vs leaves. Default "llm" preserves legacy rendering for
   * older API responses missing the field.
   */
  kind?: "llm" | "workflow";
  // Allow extra props without breaking React Flow's `Record<string, unknown>` constraint.
  [key: string]: unknown;
}

// Tint maps error rate to one of three states. Thresholds match the mockup
// legend so the visual encoding is consistent end-to-end.
//
// Color choices revised for theme-awareness + readability:
//
// - Text was `text-{color}-100` everywhere — near-white. Invisible against
//   the light-theme cream background. Now `text-{color}-700 dark:text-{color}-300`
//   so the label contrasts with the surface in both themes.
// - The "healthy" branch used `bg-emerald-500/15` for every node — a loud
//   green halo on what should be the calm, default state. The Flow Map
//   was a wall of bright green. Use neutral chrome (`bg-card` + `border-border`)
//   so "no error rate" reads as "no special state." Red and amber keep
//   their tinted backgrounds because those nodes EARN attention.
function tint(errorRate: number) {
  if (errorRate >= 0.03) {
    return {
      stroke: "border-red-500/60",
      fill: "bg-red-500/10",
      text: "text-red-700 dark:text-red-300",
    };
  }
  if (errorRate >= 0.01) {
    return {
      stroke: "border-amber-500/60",
      fill: "bg-amber-500/10",
      text: "text-amber-700 dark:text-amber-300",
    };
  }
  // Healthy nodes get a soft brand-purple tint — matches the dashboard's
  // pill aesthetic (translucent fill + themed text) so the Flow Map reads
  // as part of the same visual system as Traces/Sessions/Alerts status
  // pills. Brand purple (`--color-primary`) is theme-stable; the /10
  // opacity keeps it whisper-quiet against both light and dark surfaces.
  // Red/amber retain their stronger tints because they EARN attention;
  // brand purple here just says "this is one of your nodes."
  return {
    stroke: "border-primary/30",
    fill: "bg-primary/10",
    text: "text-foreground",
  };
}

export function FlowNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const t = tint(d.errorRate);
  // Keep the circular silhouette but allow the inner content to scale a bit
  // with volume — same encoding rule as the legend explains.
  const size = Math.max(48, Math.min(120, d.radius * 2));

  // Workflow containers render as rounded SQUARES, LLM calls as circles.
  // This is the single visual cue that tells the user "this is your code
  // (sdk.trace block)" vs "this is a provider call" — without it the
  // Flow Map is just a hairball. Round-4 review fix: trace-level spans
  // are now real rows in CH, so the map can finally show containers.
  const shape = d.kind === "workflow" ? "rounded-lg" : "rounded-full";

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      {/* React Flow needs Handles to draw edges. We hide them visually but keep
          them in the DOM so connection logic works. */}
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />

      <div
        className={cn(
          shape,
          "border flex flex-col items-center justify-center text-center px-2",
          "transition-all duration-150",
          t.fill,
          t.stroke,
          // Workflow nodes get a subtly heavier border so the container
          // affordance reads at a glance, even before the user notices the
          // shape difference.
          d.kind === "workflow" && "border-2",
          selected
            ? "ring-2 ring-brand/70 ring-offset-2 ring-offset-background scale-105"
            : "hover:scale-105",
        )}
        style={{ width: size, height: size }}
      >
        <span className={cn("text-[11px] font-semibold leading-tight", t.text)}>
          {d.label}
        </span>
        {d.sublabel && (
          <span className="text-[9px] text-muted-foreground leading-tight mt-0.5 truncate max-w-full">
            {d.sublabel}
          </span>
        )}
        {/* Tiny "workflow" affordance — model chip's container analogue.
            Only renders for workflow nodes; LLM nodes use sublabel for model. */}
        {d.kind === "workflow" && !d.sublabel && (
          <span className="text-[9px] text-muted-foreground/70 italic leading-tight mt-0.5">
            workflow
          </span>
        )}
      </div>
    </div>
  );
}
