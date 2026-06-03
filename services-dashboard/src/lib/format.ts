// Shared formatters. Previously each component had its own local `money(n)` —
// keeping them in sync (e.g., when adding compact notation) was a footgun.

/**
 * USD with dynamic precision:
 *  - >= $1,000  → compact ($24.5k, $1.2M)
 *  - >= $1     → 2 decimals ($24.58)
 *  - >= $0.01  → 4 decimals ($0.0423)
 *  - <  $0.01  → 6 decimals ($0.000123)
 *
 * Compact notation prevents the dashboard from showing five-digit amounts
 * with four decimals (e.g. "$24,517.3247") to real customers.
 */
export function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  }
  const d = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: d,
  }).format(n);
}

/** Number with thousands separator. */
export function num(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat("en-US", opts).format(n);
}

/** Sentinel sent to the backend to mean "filter where this column IS NULL".
 *  Used by the "(none)" bucket drill-in from Cost. */
export const NULL_SENTINEL = "__null__";
