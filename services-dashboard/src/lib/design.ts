/**
 * Design tokens — composable className strings for typography, status pills,
 * and a couple of other patterns that drift across pages.
 *
 * Why named constants (and not a Tailwind preset / CVA / framer-design-tokens)
 * package: this codebase isn't big enough yet to justify the indirection.
 * Named exports give us "single source of truth" with zero build setup, and
 * grep -rn "typography.eyebrow" is enough tooling to find every site.
 *
 * When to add a new entry: when you find yourself copy-pasting the same
 * Tailwind class string into a third file, lift it here. Below that bar,
 * inline strings are fine.
 *
 * Convention: lowercase keys, semantic names ("pageH1" not "textLg"). The
 * VALUE may change (e.g. "text-lg" → "text-xl"), the KEY should not.
 */

// ─── Typography ────────────────────────────────────────────────────────────

export const typography = {
  /** Top-of-page title. Used on all top-level dashboard routes. */
  pageH1: "text-lg font-semibold",
  /** In-page section header (e.g. "Recent events", "Regressions detected"). */
  sectionH2: "text-sm font-semibold",
  /** Sub-section header inside a panel (e.g. side-panel "Node" / "Top inbound"). */
  panelH3: "text-sm font-semibold",
  /** Eyebrow / kicker — small UPPERCASE label above a value or section.
   *  text-[10px] not text-xs to match the rest of the dashboard. */
  eyebrow:
    "text-[10px] font-medium text-muted-foreground uppercase tracking-wider",
  /** Tabular numeric value (price, latency, count). leading-tight + tabular-nums. */
  metricValue: "text-lg font-semibold tabular-nums leading-tight",
  /** Field-level subtle help text under inputs / cards. */
  helpText: "text-[11px] text-muted-foreground",
} as const;

// ─── Status pills ──────────────────────────────────────────────────────────
// All status colors use the "translucent" treatment (bg-{color}-500/15 +
// text-{color}-400 + border-{color}-500/30) to match the rest of the
// dashboard (insights strip, regressions, alert open/resolved). Previously
// StatusBadge used the "heavy" bg-{color}-950 palette — same conceptual
// status, visibly different color. Unified here.

// Status pill palette. Two-mode: dark theme uses -300 text against the
// translucent -500/15 fill, light theme uses -700. The previous version
// hardcoded -300 only, which rendered near-white "ok" labels against the
// light cream surface as effectively invisible (user reported round 6).
//
// AA contrast verified for both:
//   - Dark:  text-emerald-300 on bg-emerald-500/15 over #232323 ≈ 6.8:1
//   - Light: text-emerald-700 on bg-emerald-500/15 over #FAFAF8  ≈ 5.4:1
//
// Background tints stay translucent (/15) so the pill silhouette is
// unchanged across themes and across components that import this token.
// Touch ONE constant and the whole dashboard updates — Traces table,
// Sessions, Alerts, Trace tree status pills, etc.
export const statusPill = {
  base:
    "inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border",
  ok:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  warn:
    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  error:
    "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  info:
    "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  neutral:
    "bg-muted text-muted-foreground border-border",
} as const;

export type StatusTone = keyof Omit<typeof statusPill, "base">;

// ─── Card shells ───────────────────────────────────────────────────────────

export const card = {
  /** Standard card panel (e.g. side panels, info blocks). */
  panel: "border border-border rounded-lg bg-card",
  /** Compact panel — used inside grid layouts. */
  compact: "border border-border rounded-md bg-card",
  /** Dashed / empty-state card. */
  dashed: "border border-dashed border-border rounded-lg bg-card/40",
} as const;
