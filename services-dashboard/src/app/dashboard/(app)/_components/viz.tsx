"use client";

// Dependency-free SVG mini-visualizations for the v2 surface. Ported from the
// design prototype's viz.tsx (Sparkline, AreaChart, ConfidenceBar, Delta,
// Treemap), de-coupled from the prototype's mock types so they take live data.
// The Treemap gains an optional `onSelect` so a tile can drill into Traces.

import { useId, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { money } from "@/lib/format";

const BRAND = "#5B54E8";

// ── Sparkline ───────────────────────────────────────────────────────────────
export function Sparkline({
  data,
  color = BRAND,
  className,
}: {
  data: number[];
  color?: string;
  className?: string;
}) {
  if (data.length < 2) return null;
  const w = 100;
  const h = 24;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("block w-full h-6", className)}
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        points={points}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Filled area chart (spend over time) ──────────────────────────────────────
// Hovering (or touch-dragging) reveals a crosshair, emphasises the nearest
// point, and shows a value readout — so the chart is something you *read off*,
// not just a shape. `labels`, when one-per-point, doubles as the readout's time
// axis; the component samples a handful for the bottom ticks so they don't
// crowd. `formatValue` renders the readout in the series' own unit ($ / ms).
export function AreaChart({
  data,
  labels,
  color = BRAND,
  height = 140,
  formatValue = (n: number) => n.toLocaleString(),
}: {
  data: number[];
  labels?: string[];
  color?: string;
  height?: number;
  formatValue?: (n: number) => string;
}) {
  const gid = `area${useId().replace(/:/g, "")}`;
  const [hoverI, setHoverI] = useState<number | null>(null);
  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-[11px] text-muted-foreground"
        style={{ height }}
      >
        Not enough data to chart this window.
      </div>
    );
  }
  const w = 1000;
  const h = 200;
  const pad = 8;
  const max = Math.max(...data, 1) * 1.1;
  const min = 0;
  const range = max - min || 1;
  const xy = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (w - pad * 2) + pad;
    const y = h - ((v - min) / range) * (h - pad * 2) - pad;
    return [x, y] as const;
  });
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`;

  // `labels` is per-point when its length matches the data: use it for the
  // readout and sample ~5 evenly for the axis. Otherwise treat it as a caller-
  // supplied sparse axis and leave it alone.
  const perPoint = !!labels && labels.length === data.length;
  const axisTicks: string[] = !labels
    ? []
    : !perPoint
      ? labels
      : labels.length <= 7
        ? labels
        : [0, Math.floor(labels.length / 4), Math.floor(labels.length / 2), Math.floor((3 * labels.length) / 4), labels.length - 1].map(
            (i) => labels[i],
          );

  const pick = (clientX: number, rect: DOMRect) => {
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHoverI(Math.round(ratio * (data.length - 1)));
  };

  // Guard the index so a stale value can never index out of range.
  const hi = hoverI != null && hoverI >= 0 && hoverI < data.length ? hoverI : null;
  const hLeft = hi != null ? (xy[hi][0] / w) * 100 : 0;
  // Flip the readout near the edges so it never spills out of the card.
  const tx = hLeft < 15 ? "0%" : hLeft > 85 ? "-100%" : "-50%";

  return (
    <div>
      <div className="relative w-full" style={{ height }}>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="absolute inset-0 block h-full w-full"
        >
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon points={area} fill={`url(#${gid})`} />
          <polyline
            points={line}
            fill="none"
            stroke={color}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        {/* Dots in an HTML overlay so they stay round — the SVG is stretched
            non-uniformly by preserveAspectRatio="none". The hovered point grows
            and gets a ring so the readout has an anchor. */}
        <div className="pointer-events-none absolute inset-0">
          {xy.map(([x, y], i) => (
            <span
              key={i}
              className="absolute rounded-full transition-[width,height]"
              style={{
                left: `${(x / w) * 100}%`,
                top: `${(y / h) * 100}%`,
                width: hi === i ? 10 : 6,
                height: hi === i ? 10 : 6,
                transform: "translate(-50%, -50%)",
                background: color,
                boxShadow: hi === i ? `0 0 0 3px var(--background), 0 0 0 4px ${color}` : undefined,
              }}
            />
          ))}
        </div>
        {/* Crosshair + readout (hover/touch only). */}
        {hi != null && (
          <>
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-foreground/25"
              style={{ left: `${hLeft}%` }}
            />
            <div
              className="pointer-events-none absolute top-1 z-10"
              style={{ left: `${hLeft}%`, transform: `translateX(${tx})` }}
            >
              <div className="rounded-md bg-popover ring-1 ring-foreground/10 shadow-lg px-2 py-1 text-[11px] whitespace-nowrap">
                {perPoint && labels && <div className="text-muted-foreground">{labels[hi]}</div>}
                <div className="font-medium tabular-nums" style={{ color }}>
                  {formatValue(data[hi])}
                </div>
              </div>
            </div>
          </>
        )}
        {/* Transparent capture layer on top — keeps the dots/crosshair
            pointer-transparent while still tracking the cursor. */}
        <div
          className="absolute inset-0 cursor-crosshair"
          onMouseMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onMouseLeave={() => setHoverI(null)}
          onTouchStart={(e) => pick(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
          onTouchMove={(e) => pick(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())}
          onTouchEnd={() => setHoverI(null)}
        />
      </div>
      {axisTicks.length > 0 && (
        <div className="flex justify-between mt-1.5 px-1">
          {axisTicks.map((l, i) => (
            <span key={`${l}-${i}`} className="text-[10px] text-muted-foreground tabular-nums">
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Confidence bar (cost_source split) ───────────────────────────────────────
export function ConfidenceBar({
  verified,
  estimated,
  unknown,
  showLegend = true,
}: {
  verified: number;
  estimated: number;
  unknown: number;
  showLegend?: boolean;
}) {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  return (
    <div className="space-y-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="bg-emerald-500/80" style={{ width: pct(verified) }} />
        <div className="bg-amber-500/80" style={{ width: pct(estimated) }} />
        <div className="bg-muted-foreground/40" style={{ width: pct(unknown) }} />
      </div>
      {showLegend && (
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground tabular-nums">
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-emerald-500/80" />
            {pct(verified)} verified
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-amber-500/80" />
            {pct(estimated)} estimated
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-muted-foreground/40" />
            {pct(unknown)} unknown
          </span>
        </div>
      )}
    </div>
  );
}

// ── Delta pill ────────────────────────────────────────────────────────────────
export function Delta({
  pct,
  direction,
}: {
  pct: number;
  direction: "up-is-bad" | "down-is-bad" | "neutral";
}) {
  const up = pct > 0;
  const isBad = direction === "up-is-bad" ? up : direction === "down-is-bad" ? !up : false;
  const Arrow = up ? ArrowUp : ArrowDown;
  const color =
    direction === "neutral" ? "text-muted-foreground" : isBad ? "text-red-400" : "text-emerald-400";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] tabular-nums font-medium",
        color,
      )}
    >
      <Arrow className="h-3 w-3" />
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

// ── Treemap (binary split, ported from workflow-treemap.tsx) ─────────────────
export interface TreeNode {
  name: string;
  cost: number;
  /** Δ vs prior, percent. Drives tile color. */
  pct: number;
  /** No prior baseline — colored "new". */
  isNew?: boolean;
  /** Raw dimension value for drill (defaults to `name`). */
  value?: string;
  /** Optional muted hint shown on non-drillable rows (e.g. the Unattributed
   *  bucket) explaining why the row can't be opened and how to fix it. */
  note?: string;
}

interface Tile {
  node: TreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

function layout(items: TreeNode[], x: number, y: number, w: number, h: number): Tile[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ node: items[0], x, y, w, h }];
  const total = items.reduce((s, n) => s + n.cost, 0);
  const target = total / 2;
  let acc = 0;
  let splitIdx = 0;
  for (let i = 0; i < items.length - 1; i++) {
    acc += items[i].cost;
    if (acc >= target) {
      splitIdx = i + 1;
      break;
    }
  }
  if (splitIdx === 0) splitIdx = 1;
  const left = items.slice(0, splitIdx);
  const right = items.slice(splitIdx);
  const leftSum = left.reduce((s, n) => s + n.cost, 0);
  const ratio = total > 0 ? leftSum / total : 0.5;
  if (w >= h) {
    const lw = w * ratio;
    return [...layout(left, x, y, lw, h), ...layout(right, x + lw, y, w - lw, h)];
  }
  const lh = h * ratio;
  return [...layout(left, x, y, w, lh), ...layout(right, x, y + lh, w, h - lh)];
}

function tileColor(n: TreeNode): { bg: string; ring: string } {
  if (n.isNew) return { bg: "fill-purple-500/30", ring: "stroke-purple-400/60" };
  const p = n.pct;
  if (p > 20) return { bg: "fill-red-500/40", ring: "stroke-red-400/60" };
  if (p > 5) return { bg: "fill-amber-500/30", ring: "stroke-amber-400/60" };
  if (p < -5) return { bg: "fill-emerald-500/30", ring: "stroke-emerald-400/60" };
  return { bg: "fill-muted/40", ring: "stroke-border" };
}

function pctLabel(n: TreeNode): string {
  if (n.isNew) return "new";
  if (Math.abs(n.pct) < 1) return "≈0%";
  return `${n.pct > 0 ? "+" : ""}${n.pct.toFixed(0)}%`;
}

// Δ-vs-prior trend for the cost leaderboard, rendered as a calm caret + colored
// text (not a filled chip — a chip on every row turns the list into noise).
// Hue mirrors tileColor's thresholds and the section legend: red = much
// pricier, amber = pricier, emerald = cheaper, purple = new, muted = ~flat.
function deltaTone(n: TreeNode): { text: string; cls: string; label: string } {
  if (n.isNew) return { text: "new", cls: "text-purple-300", label: "new vs prior period" };
  const p = n.pct;
  if (Math.abs(p) < 1) return { text: "≈ 0%", cls: "text-muted-foreground", label: "≈ stable vs prior period" };
  // Tiny prior baselines (a near-empty prior window) make the raw % explode into
  // absurd 4–5 digit values that read as "broken". Clamp the *displayed*
  // magnitude — past ~10× the exact figure isn't actionable anyway.
  const mag =
    Math.abs(p) >= 1000
      ? `${p > 0 ? "▲" : "▼"} >999%`
      : `${p > 0 ? "▲" : "▼"}${Math.abs(p).toFixed(0)}%`;
  if (p > 20) return { text: mag, cls: "text-red-300", label: "much pricier vs prior period" };
  if (p > 5) return { text: mag, cls: "text-amber-300", label: "pricier vs prior period" };
  if (p > 0) return { text: mag, cls: "text-muted-foreground", label: "slightly pricier vs prior period" };
  if (p < -5) return { text: mag, cls: "text-emerald-300", label: "cheaper vs prior period" };
  return { text: mag, cls: "text-muted-foreground", label: "slightly cheaper vs prior period" };
}

export function Treemap({
  nodes,
  onSelect,
  drillLabel = "Click to drill into Traces",
}: {
  nodes: TreeNode[];
  onSelect?: (node: TreeNode) => void;
  /** Hover-tooltip hint shown when a tile is selectable. */
  drillLabel?: string;
}) {
  const [hover, setHover] = useState<TreeNode | null>(null);
  const VB_W = 1000;
  const VB_H = 320;
  const sorted = useMemo(
    () => [...nodes].filter((n) => n.cost > 0).sort((a, b) => b.cost - a.cost),
    [nodes],
  );
  const tiles = useMemo(() => layout(sorted, 0, 0, VB_W, VB_H), [sorted]);

  if (sorted.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-[11px] text-muted-foreground">
        No spend to attribute in this window.
      </div>
    );
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="w-full h-[320px] block"
        onMouseLeave={() => setHover(null)}
      >
        {tiles.map((t, i) => {
          const color = tileColor(t.node);
          const isHover = hover === t.node;
          const showName = t.w > 80 && t.h > 40;
          const showCost = t.w > 140 && t.h > 60;
          const showPct = t.w > 100 && t.h > 50;
          const clickable = !!onSelect;
          return (
            <g
              key={`${t.node.name}-${i}`}
              onMouseEnter={() => setHover(t.node)}
              onClick={clickable ? () => onSelect(t.node) : undefined}
              className={cn(clickable && "cursor-pointer")}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(t.node);
                      }
                    }
                  : undefined
              }
            >
              <rect
                x={t.x + 2}
                y={t.y + 2}
                width={Math.max(0, t.w - 4)}
                height={Math.max(0, t.h - 4)}
                className={cn(
                  color.bg,
                  color.ring,
                  "transition-opacity",
                  isHover ? "opacity-100" : "opacity-90",
                )}
                strokeWidth={1}
              />
              {showName && (
                <text
                  x={t.x + 12}
                  y={t.y + 24}
                  className="fill-foreground text-[13px] font-medium"
                  style={{ pointerEvents: "none" }}
                >
                  {t.node.name}
                </text>
              )}
              {showCost && (
                <text
                  x={t.x + 12}
                  y={t.y + 42}
                  className="fill-muted-foreground text-[11px] tabular-nums"
                  style={{ pointerEvents: "none" }}
                >
                  {money(t.node.cost)}
                </text>
              )}
              {showPct && (
                <text
                  x={t.x + 12}
                  y={showCost ? t.y + 58 : t.y + 42}
                  className={cn(
                    "text-[10px] tabular-nums font-medium",
                    t.node.isNew
                      ? "fill-purple-300"
                      : t.node.pct > 20
                        ? "fill-red-300"
                        : t.node.pct > 5
                          ? "fill-amber-300"
                          : t.node.pct < -5
                            ? "fill-emerald-300"
                            : "fill-muted-foreground",
                  )}
                  style={{ pointerEvents: "none" }}
                >
                  {pctLabel(t.node)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="absolute top-2 right-2 bg-popover border border-border rounded-md p-3 text-xs shadow-md min-w-[200px] pointer-events-none">
          <div className="font-medium text-foreground mb-1">{hover.name}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
            <span>Cost</span>
            <span className="text-right tabular-nums text-foreground">{money(hover.cost)}</span>
            <span>Δ vs prior</span>
            <span
              className={cn(
                "text-right tabular-nums",
                hover.isNew
                  ? "text-purple-300"
                  : hover.pct > 20
                    ? "text-red-300"
                    : hover.pct > 5
                      ? "text-amber-300"
                      : hover.pct < -5
                        ? "text-emerald-300"
                        : "text-foreground",
              )}
            >
              {pctLabel(hover)}
            </span>
          </div>
          {onSelect && (
            <div className="mt-2 pt-2 border-t border-border text-[10px] text-muted-foreground">
              {drillLabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── CostBars — ranked "where the money goes" leaderboard ─────────────────────
// Replaces the treemap. Rectangle-area comparison is hard to judge and hides
// every small tile's label, so the long tail becomes an un-scannable wall of
// boxes. Here we rank by cost with always-legible horizontal bars (length =
// share of the largest line; the % is share of total) and surface the Δ-vs-
// prior signal as a filled pill beside the dollar amount. The whole row drills,
// with a visible row-interactive hover lift and a → affordance on hover.
export function CostBars({
  nodes,
  onSelect,
  canSelect,
  drillLabel = "Click to drill into Traces",
}: {
  nodes: TreeNode[];
  onSelect?: (node: TreeNode) => void;
  /** Per-row gate. A row is only interactive when this returns true (default:
   *  all rows when `onSelect` is set). Lets the caller mark dead-end rows — e.g.
   *  the Unattributed bucket, which has no detail page — as non-clickable so we
   *  never render a → / hover-lift on a row that does nothing. */
  canSelect?: (node: TreeNode) => boolean;
  /** Hover-title hint shown when a row is selectable. */
  drillLabel?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(
    () => [...nodes].filter((n) => n.cost > 0).sort((a, b) => b.cost - a.cost),
    [nodes],
  );
  const total = useMemo(() => sorted.reduce((s, n) => s + n.cost, 0), [sorted]);
  const MAX_ROWS = 8;
  const visible = showAll ? sorted : sorted.slice(0, MAX_ROWS);

  if (sorted.length === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center text-[11px] text-muted-foreground">
        No spend to attribute in this window.
      </div>
    );
  }

  return (
    <div>
      <ul className="flex flex-col gap-0.5">
        {visible.map((n, i) => {
          // Bar length AND the trailing % are both share-of-total, so the
          // visual and the number say the same thing — this is "where the
          // money goes", i.e. the proportion question.
          const share = total > 0 ? (n.cost / total) * 100 : 0;
          const tone = deltaTone(n);
          const rowClickable = !!onSelect && (canSelect ? canSelect(n) : true);
          return (
            <li key={n.name}>
              <button
                type="button"
                onClick={rowClickable ? () => onSelect!(n) : undefined}
                title={rowClickable ? drillLabel : n.note}
                aria-disabled={rowClickable ? undefined : true}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left",
                  rowClickable ? "row-interactive focus-ring cursor-pointer" : "cursor-default",
                )}
              >
                <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span
                  className={cn(
                    "w-44 shrink-0 truncate text-[13px]",
                    rowClickable ? "text-foreground" : "text-muted-foreground",
                  )}
                  title={n.name}
                >
                  {n.name}
                </span>
                {/* Middle column fills the row: a share-of-total bar for drillable
                    rows, or the "why not clickable" note for dead-end rows. */}
                <span className="hidden min-w-[3rem] flex-1 px-1 sm:flex sm:items-center">
                  {rowClickable ? (
                    // Track must read against the card (#232323); --muted is the
                    // SAME value as --card, so a bg-muted track is invisible —
                    // bg-foreground/10 gives a faint, theme-aware groove the
                    // purple fill sits in.
                    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                      <span
                        className="block h-full rounded-full bg-[#5B54E8]"
                        style={{ width: `${share}%` }}
                      />
                    </span>
                  ) : n.note ? (
                    <span className="truncate text-[11px] italic text-muted-foreground/70">
                      {n.note}
                    </span>
                  ) : null}
                </span>
                <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {share.toFixed(0)}%
                </span>
                <span
                  className={cn("w-16 shrink-0 text-right text-[11px] tabular-nums", tone.cls)}
                  title={tone.label}
                >
                  {tone.text}
                </span>
                <span className="w-16 shrink-0 text-right text-[13px] font-medium tabular-nums text-foreground">
                  {money(n.cost)}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "w-3 shrink-0 text-center text-muted-foreground transition-opacity",
                    rowClickable ? "opacity-0 group-hover:opacity-100" : "opacity-0",
                  )}
                >
                  →
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {sorted.length > MAX_ROWS && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 w-full rounded-md px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-ring"
        >
          {showAll ? "Show less" : `Show ${sorted.length - MAX_ROWS} more`}
        </button>
      )}
    </div>
  );
}

// ── Sankey (cost-flow: workflow → model → outcome) ───────────────────────────
// Ported from the prototype, de-coupled from mock types so it renders live data.
// Three columns: col 0 = workflow, col 1 = model, col 2 = outcome. Ribbon width
// is dollars. Outcome hue is carried on the node (`tone`) so the same status
// looks consistent with StatusBadge / the legend swatches.
export interface FlowNode {
  id: string;
  label: string;
  /** 0 = workflow, 1 = model, 2 = outcome */
  col: 0 | 1 | 2;
  kind: "workflow" | "model" | "outcome";
  /** Only for outcome nodes — drives the ribbon/box color. */
  tone?: "ok" | "warn" | "bad";
}
export interface FlowLink {
  source: string;
  target: string;
  value: number;
}

interface SNode extends FlowNode {
  value: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
interface SLink extends FlowLink {
  sy0: number;
  sy1: number;
  ty0: number;
  ty1: number;
}

const TONE_FILL: Record<string, string> = {
  ok: "fill-emerald-400",
  warn: "fill-amber-500",
  bad: "fill-red-400",
};
function nodeFill(n: FlowNode): string {
  if (n.kind === "outcome") return TONE_FILL[n.tone ?? ""] ?? "fill-muted-foreground";
  if (n.kind === "model") return "fill-primary";
  return "fill-muted-foreground";
}

export function Sankey({ nodes, links }: { nodes: FlowNode[]; links: FlowLink[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const VB_W = 1000;
  const VB_H = 360;
  const NODE_W = 13;
  const GAP = 12;
  const PAD_Y = 10;
  const bodyX0 = 188;
  const bodyX1 = 838;

  const { snodes, slinks, total } = useMemo(() => {
    const inSum = (id: string) =>
      links.filter((l) => l.target === id).reduce((s, l) => s + l.value, 0);
    const outSum = (id: string) =>
      links.filter((l) => l.source === id).reduce((s, l) => s + l.value, 0);
    const valueOf = (n: FlowNode) =>
      n.col === 0 ? outSum(n.id) : n.col === 2 ? inSum(n.id) : Math.max(inSum(n.id), outSum(n.id));

    const cols = [0, 1, 2].map((c) => nodes.filter((n) => n.col === c));
    const total = cols[0].reduce((s, n) => s + valueOf(n), 0) || 1;
    const maxCount = Math.max(...cols.map((c) => c.length), 1);
    const scale = (VB_H - 2 * PAD_Y - GAP * (maxCount - 1)) / total;
    const xFor = (col: number) =>
      col === 0 ? bodyX0 : col === 2 ? bodyX1 - NODE_W : (bodyX0 + bodyX1) / 2 - NODE_W / 2;

    const snodes: Record<string, SNode> = {};
    cols.forEach((colNodes) => {
      let cursor = PAD_Y;
      colNodes.forEach((n) => {
        const v = valueOf(n);
        const x0 = xFor(n.col);
        const y0 = cursor;
        const y1 = y0 + v * scale;
        snodes[n.id] = { ...n, value: v, x0, x1: x0 + NODE_W, y0, y1 };
        cursor = y1 + GAP;
      });
    });

    const slinks: SLink[] = links.map((l) => ({ ...l, sy0: 0, sy1: 0, ty0: 0, ty1: 0 }));
    Object.values(snodes).forEach((n) => {
      let cursor = n.y0;
      slinks
        .filter((l) => l.source === n.id && snodes[l.target])
        .sort((a, b) => snodes[a.target].y0 - snodes[b.target].y0)
        .forEach((l) => {
          l.sy0 = cursor;
          l.sy1 = cursor + l.value * scale;
          cursor = l.sy1;
        });
    });
    Object.values(snodes).forEach((n) => {
      let cursor = n.y0;
      slinks
        .filter((l) => l.target === n.id && snodes[l.source])
        .sort((a, b) => snodes[a.source].y0 - snodes[b.source].y0)
        .forEach((l) => {
          l.ty0 = cursor;
          l.ty1 = cursor + l.value * scale;
          cursor = l.ty1;
        });
    });
    return { snodes, slinks, total };
  }, [nodes, links]);

  const linkActive = (l: SLink) => !hover || l.source === hover || l.target === hover;
  const nodeActive = (id: string) =>
    !hover ||
    id === hover ||
    slinks.some(
      (l) => (l.source === hover && l.target === id) || (l.target === hover && l.source === id),
    );
  const hoverNode = hover ? snodes[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full block"
        style={{ height: 360 }}
        onMouseLeave={() => setHover(null)}
      >
        {slinks.map((l, i) => {
          const s = snodes[l.source];
          const t = snodes[l.target];
          if (!s || !t) return null;
          const x0 = s.x1;
          const x1 = t.x0;
          const xc = (x0 + x1) / 2;
          const d = `M${x0},${l.sy0} C${xc},${l.sy0} ${xc},${l.ty0} ${x1},${l.ty0} L${x1},${l.ty1} C${xc},${l.ty1} ${xc},${l.sy1} ${x0},${l.sy1} Z`;
          return (
            <path
              key={i}
              d={d}
              className={cn(
                t.kind === "outcome" ? TONE_FILL[t.tone ?? ""] ?? "fill-primary" : "fill-primary",
                "transition-opacity",
              )}
              fillOpacity={linkActive(l) ? (hover ? 0.5 : 0.24) : 0.05}
            />
          );
        })}
        {Object.values(snodes).map((n) => {
          const active = nodeActive(n.id);
          return (
            <g key={n.id} onMouseEnter={() => setHover(n.id)} className="cursor-pointer">
              <rect
                x={n.x0}
                y={n.y0}
                width={NODE_W}
                height={Math.max(1, n.y1 - n.y0)}
                rx={2}
                className={cn(nodeFill(n), "transition-opacity")}
                fillOpacity={active ? 0.95 : 0.3}
              />
              <text
                x={n.col === 0 ? n.x0 - 8 : n.x1 + 8}
                y={(n.y0 + n.y1) / 2}
                textAnchor={n.col === 0 ? "end" : "start"}
                dominantBaseline="middle"
                className="fill-foreground stroke-background text-[11px]"
                style={{ paintOrder: "stroke", pointerEvents: "none" }}
                strokeWidth={3}
                fillOpacity={active ? 1 : 0.45}
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
      {hoverNode && (
        <div className="absolute top-2 right-2 bg-popover border border-border rounded-md p-3 text-xs shadow-md min-w-[180px] pointer-events-none">
          <div className="font-medium text-foreground mb-1">{hoverNode.label}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
            <span>Cost</span>
            <span className="text-right tabular-nums text-foreground">{money(hoverNode.value)}</span>
            <span>Share</span>
            <span className="text-right tabular-nums text-foreground">
              {((hoverNode.value / total) * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
