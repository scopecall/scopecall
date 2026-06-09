"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Global time-range + environment scope for the v2 surface, encoded in the URL
 * so it survives reloads, deep links, and the browser Back button. The chrome's
 * scope/time pills write here; every v2 page + drill reads {from,to,granularity}
 * from here.
 *
 * Explicit ?from&to (set by a drill-down) OVERRIDE the ?range shorthand — a page
 * can narrow the window without clobbering the global default, and clearing
 * from/to falls back to the shorthand. This is the live tool's "per-page range
 * override" preserved (PORT BRIEF item 1c), but URL-first instead of useState.
 */

export type RangeKey = "1h" | "24h" | "7d" | "30d" | "90d";

export const RANGE_KEYS: RangeKey[] = ["1h", "24h", "7d", "30d", "90d"];

export const RANGE_LABELS: Record<RangeKey, string> = {
  "1h": "Last hour",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

const RANGE_MS: Record<RangeKey, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_RANGE: RangeKey = "7d";

/** Param keys that represent global scope — carried across v2 nav + drills. */
export const GLOBAL_SCOPE_KEYS = ["range", "from", "to", "gran", "env"] as const;

/**
 * Serialize just the global-scope params from `sp` into a query string
 * ("" or "?…"). Used by nav links + drill links so the active window/scope
 * follows the user between surfaces, while page-specific filters stay put.
 */
export function globalScopeQuery(sp: URLSearchParams): string {
  const next = new URLSearchParams();
  for (const k of GLOBAL_SCOPE_KEYS) {
    const v = sp.get(k);
    if (v) next.set(k, v);
  }
  const s = next.toString();
  return s ? `?${s}` : "";
}

function isRangeKey(v: string | null): v is RangeKey {
  return v != null && Object.prototype.hasOwnProperty.call(RANGE_MS, v);
}

/**
 * Resolve a shorthand to absolute dates. `now` is floored to the start of the
 * current minute so repeated calls within the same minute return identical
 * Dates — keeps React Query keys stable (no per-render refetch churn).
 */
export function rangeToDates(key: RangeKey, now: number = Date.now()) {
  const anchored = Math.floor(now / 60_000) * 60_000;
  return { from: new Date(anchored - RANGE_MS[key]), to: new Date(anchored) };
}

export interface ResolvedTimeRange {
  from: Date;
  to: Date;
  /** null when the window came from explicit ?from&to (a drill override). */
  rangeKey: RangeKey | null;
  granularity: "hour" | "day";
  /** environment scope, e.g. "production"; undefined = all environments. */
  env: string | undefined;
  /** human label for the active window — drives the pill + page headers. */
  label: string;
}

export function useTimeRange(): ResolvedTimeRange {
  const sp = useSearchParams();
  const rangeParam = sp.get("range");
  const fromParam = sp.get("from");
  const toParam = sp.get("to");
  const granParam = sp.get("gran");
  const env = sp.get("env") ?? undefined;

  return useMemo<ResolvedTimeRange>(() => {
    let from: Date;
    let to: Date;
    let rangeKey: RangeKey | null;

    if (fromParam && toParam) {
      // Drill override — explicit absolute window.
      from = new Date(fromParam);
      to = new Date(toParam);
      rangeKey = null;
    } else {
      rangeKey = isRangeKey(rangeParam) ? rangeParam : DEFAULT_RANGE;
      ({ from, to } = rangeToDates(rangeKey));
    }

    const spanMs = to.getTime() - from.getTime();
    const granularity: "hour" | "day" =
      granParam === "hour" || granParam === "day"
        ? granParam
        : spanMs <= 2 * RANGE_MS["24h"] // ≤ 48h → hourly buckets, else daily
          ? "hour"
          : "day";

    const label = rangeKey
      ? RANGE_LABELS[rangeKey]
      : `${from.toLocaleDateString()} – ${to.toLocaleDateString()}`;

    return { from, to, rangeKey, granularity, env, label };
  }, [rangeParam, fromParam, toParam, granParam, env]);
}

/**
 * Setters for the chrome pills + drill links. Writes go through router.replace
 * (no Back-button spam from scope tweaks). Returned callbacks are stable.
 */
export function useTimeRangeControls() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const setRange = useCallback(
    (key: RangeKey) => {
      const next = new URLSearchParams(sp.toString());
      next.set("range", key);
      // a shorthand supersedes any explicit window + manual granularity
      next.delete("from");
      next.delete("to");
      next.delete("gran");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [router, pathname, sp],
  );

  const setGranularity = useCallback(
    (gran: "hour" | "day" | null) => {
      const next = new URLSearchParams(sp.toString());
      if (gran) next.set("gran", gran);
      else next.delete("gran");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [router, pathname, sp],
  );

  const setEnv = useCallback(
    (env: string | null) => {
      const next = new URLSearchParams(sp.toString());
      if (env) next.set("env", env);
      else next.delete("env");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [router, pathname, sp],
  );

  return { setRange, setGranularity, setEnv };
}
