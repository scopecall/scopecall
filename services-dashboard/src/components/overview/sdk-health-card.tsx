"use client";

import { Activity, AlertTriangle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { useSDKHealth } from "@/lib/queries/use-sdk-health";
import { cn } from "@/lib/utils";

interface Props {
  orgId: string;
}

// Freshness threshold (sec) used to label the health state. Numbers chosen
// so a user installing the SDK sees "fresh" within seconds of their first
// call, but a paused weekend doesn't trigger "cold."
const FRESH_THRESHOLD = 5 * 60;
const STALE_THRESHOLD = 60 * 60;

function fmtSince(sec: number): string {
  if (sec < 60) return `${sec} sec ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hr ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

export function SDKHealthCard({ orgId }: Props) {
  const { data, isLoading, error } = useSDKHealth(orgId, !!orgId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border bg-card text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking SDK status…
      </div>
    );
  }
  if (error || !data) {
    // Failure to load is itself a signal — quietly degrade rather than hide.
    return null;
  }

  // Three states drive the visual treatment. Chose explicit thresholds over
  // a "score" so the UI is predictable; a "warning" pill at the same time
  // every day is more debuggable than a fuzzy gradient.
  const state =
    !data.has_calls ? ("none" as const)
    : data.seconds_since_last_call <= FRESH_THRESHOLD ? ("fresh" as const)
    : data.seconds_since_last_call <= STALE_THRESHOLD ? ("stale" as const)
    : ("cold" as const);

  // Empty state: the SDK hasn't connected yet. Surface install hints.
  if (state === "none") {
    return (
      <div className="px-4 py-3 rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <p className="text-sm font-semibold text-foreground">No calls received yet</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Install the SDK and make a test call. Once your first call lands,
          this card will show real-time SDK health.
        </p>
      </div>
    );
  }

  // Active states share a layout — color + icon + headline + metrics row.
  const tone =
    state === "fresh" ? "bg-emerald-500/5 border-emerald-500/30"
    : state === "stale" ? "bg-amber-500/5 border-amber-500/30"
    : "bg-red-500/5 border-red-500/30";
  const Icon =
    state === "fresh" ? CheckCircle2 : state === "stale" ? Clock : AlertTriangle;
  const iconColor =
    state === "fresh" ? "text-emerald-400"
    : state === "stale" ? "text-amber-400"
    : "text-red-400";
  const headline =
    state === "fresh" ? "SDK healthy"
    : state === "stale" ? "SDK quiet"
    : "SDK cold — no recent calls";

  return (
    <div className={cn("px-4 py-3 rounded-lg border", tone)}>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <Icon className={cn("h-4 w-4", iconColor)} />
          <p className="text-sm font-semibold text-foreground">{headline}</p>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          last call {fmtSince(data.seconds_since_last_call)}
        </span>
        <span className="text-muted-foreground text-xs">·</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          <Activity className="inline h-3 w-3 -mt-0.5 mr-0.5" />
          {data.calls_last_hour.toLocaleString()} in last hour
          {data.recent_error_rate > 0 && (
            <span className={cn(
              "ml-1.5",
              data.recent_error_rate >= 0.03 ? "text-red-400"
                : data.recent_error_rate >= 0.01 ? "text-amber-400"
                : "text-muted-foreground",
            )}>
              · {(data.recent_error_rate * 100).toFixed(1)}% errors
            </span>
          )}
        </span>
        <div className="flex-1" />
        {/* Diversity footprint — tells the user the SDK is wired in multiple
            paths, not a one-off call from curl. */}
        <span className="text-[11px] text-muted-foreground/80 tabular-nums whitespace-nowrap">
          {data.distinct_environments} env · {data.distinct_models} model{data.distinct_models === 1 ? "" : "s"}{" "}
          · {data.distinct_providers} provider{data.distinct_providers === 1 ? "" : "s"}
          {data.sdk_versions.length > 0 && ` · sdk ${data.sdk_versions[0]}`}
        </span>
      </div>
      {state === "cold" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Calls have stopped flowing for over an hour. Common causes: SDK
          error after deploy, expired credentials, network/auth issue,
          or your app is genuinely idle. Last call landed{" "}
          {fmtSince(data.seconds_since_last_call)}.
        </p>
      )}
    </div>
  );
}
