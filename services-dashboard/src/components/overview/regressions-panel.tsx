"use client";

import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  DollarSign,
  TrendingDown,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRegressions, type Regression, type RegressionKind } from "@/lib/queries/use-regressions";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Props {
  orgId: string;
  from: Date;
  to: Date;
  enabled: boolean;
}

// Per-kind metadata. Keeping copy + icon + value formatting co-located so a
// single switch covers all four kinds rather than scattering format logic.
const KIND_META: Record<RegressionKind, { icon: LucideIcon; label: string }> = {
  latency_p99:  { icon: Zap,           label: "p99 latency" },
  error_rate:   { icon: AlertCircle,   label: "error rate" },
  cost:         { icon: DollarSign,    label: "cost" },
  volume_drop:  { icon: TrendingDown,  label: "volume" },
};

function fmtValue(kind: RegressionKind, v: number): string {
  switch (kind) {
    case "latency_p99":  return `${Math.round(v)}ms`;
    case "error_rate":   return `${v.toFixed(1)}%`;
    case "cost":         return money(v);
    case "volume_drop":  return `${Math.round(v).toLocaleString()} calls`;
  }
}

function fmtChange(r: Regression): string {
  // error_rate uses pct-point delta (signed); others use relative %.
  if (r.kind === "error_rate") {
    return `+${r.pct_change.toFixed(1)}pp`;
  }
  if (r.kind === "volume_drop") {
    return `${r.pct_change.toFixed(0)}%`;
  }
  const sign = r.pct_change >= 0 ? "+" : "";
  return `${sign}${r.pct_change.toFixed(0)}%`;
}

function dimLabel(r: Regression): string {
  if (r.feature && r.feature !== r.model) return `${r.feature} · ${r.model}`;
  return r.model;
}

// Build the drill-down URL — different metrics have different best-fit pages.
function drillHref(r: Regression, from: Date, to: Date): string {
  const qs = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    model: r.model,
  });
  // feature_name (NOT "feature") — must match Traces page URL state.
  // See flow/page.tsx for the same fix; both sites shipped broken.
  if (r.feature && r.feature !== r.model) qs.set("feature_name", r.feature);
  if (r.kind === "error_rate") {
    qs.set("status", "error");
    return `/dashboard/traces?${qs}`;
  }
  if (r.kind === "cost") return `/dashboard/cost?${qs}`;
  return `/dashboard/traces?${qs}`;
}

export function RegressionsPanel({ orgId, from, to, enabled }: Props) {
  const { data, isLoading, error } = useRegressions({ orgId, from, to, limit: 5 }, enabled);

  // Quiet handling — the panel is "bonus" surface. If it errors, just hide.
  if (error) return null;

  // Defensive: response shape might drift, so accept anything sensible and
  // coerce. Empty array means "nothing notable" which we also hide.
  const regressions = Array.isArray(data?.regressions) ? data!.regressions : [];

  // Skip rendering entirely if we have zero detections AND we're not loading.
  // (We deliberately don't show a "no regressions" empty state — the
  // insights strip already has a quiet-state card to do that job.)
  if (!isLoading && regressions.length === 0) return null;

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
        <h3 className="text-sm font-semibold">Regressions detected</h3>
        <span className="text-[11px] text-muted-foreground">
          · vs. previous period · auto-surfaced, no rule needed
        </span>
      </div>

      {isLoading ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">Scanning for regressions…</div>
      ) : (
        <ul className="divide-y divide-border">
          {regressions.map((r, i) => (
            <RegressionRow key={i} r={r} from={from} to={to} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RegressionRow({ r, from, to }: { r: Regression; from: Date; to: Date }) {
  const meta = KIND_META[r.kind];
  const Icon = meta.icon;

  const sevTone =
    r.severity === "critical"
      ? "bg-red-500/10 text-red-400 border-red-500/30"
      : "bg-amber-500/10 text-amber-400 border-amber-500/30";

  return (
    <Link
      href={drillHref(r, from, to)}
      className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors group"
    >
      <Icon className={cn(
        "h-4 w-4 shrink-0",
        r.severity === "critical" ? "text-red-400" : "text-amber-400",
      )} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{dimLabel(r)}</span>
          <span className={cn(
            "text-[10px] font-medium px-1.5 py-0.5 rounded border",
            sevTone,
          )}>
            {meta.label} {fmtChange(r)}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
          {fmtValue(r.kind, r.current_value)} now · was {fmtValue(r.kind, r.prior_value)}
          {" · "}
          {r.current_calls.toLocaleString()} calls this period
        </p>
      </div>

      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </Link>
  );
}
