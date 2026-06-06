"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertOctagon,
  ChevronDown,
  ChevronRight,
  Coins,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useWasteInbox, type WasteItem, type WasteKind } from "@/lib/queries/use-waste-inbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Props {
  orgId: string;
  from: Date;
  to: Date;
  enabled: boolean;
}

function money(n: number): string {
  const abs = Math.abs(n);
  const d = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: d }).format(n);
}

function iconFor(kind: WasteKind) {
  switch (kind) {
    case "retry_burner":
      return <RefreshCw className="h-3.5 w-3.5" />;
    case "model_misuse":
      return <Coins className="h-3.5 w-3.5" />;
    case "high_error_workflow":
      return <ShieldAlert className="h-3.5 w-3.5" />;
    default:
      return <AlertOctagon className="h-3.5 w-3.5" />;
  }
}

// Severity tones — kept low-saturation so the page doesn't look like a fire
// drill when items are routine. The Overview already has a lot of color
// real-estate spent on charts; the Waste Inbox earns attention by sitting
// near the top, not by shouting.
function severityCls(sev: WasteItem["severity"]): string {
  switch (sev) {
    case "high":
      return "border-red-500/40 bg-red-500/5 text-red-300";
    case "medium":
      return "border-amber-500/40 bg-amber-500/5 text-amber-300";
    default:
      return "border-border text-muted-foreground";
  }
}

export function WasteInbox({ orgId, from, to, enabled }: Props) {
  const router = useRouter();
  const { data, isLoading } = useWasteInbox({ orgId, from, to }, enabled);
  // Key the expanded row by a stable composite id, NOT by list index. On the
  // 60s refetch interval a new high-severity item can enter at position 0
  // and shift existing items down — if we keyed by index, the expanded row
  // would silently become a *different* item the user didn't choose.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const items = data?.items ?? [];

  // Composite key — kind alone isn't unique (multiple retry_burner items),
  // and (workflow,model,step) together is the natural identity of every
  // rule's findings.
  const keyOf = (item: WasteItem): string =>
    `${item.kind}|${item.workflow ?? ""}|${item.model ?? ""}|${item.step ?? ""}`;

  // Hide the card entirely when there's nothing to report — adds signal to
  // its appearance. Same convention RegressionsPanel uses.
  if (!isLoading && items.length === 0) return null;

  function onItemClick(item: WasteItem) {
    // Best-effort drill-in. Each rule kind maps to a slightly different
    // surface — retry burner → traces filtered by workflow×model, model
    // misuse → traces filtered by step, high-error → traces with status=error
    // pre-applied.
    const qs = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    if (item.kind === "retry_burner") {
      if (item.workflow) qs.set("feature_name", item.workflow);
      if (item.model) qs.set("model", item.model);
    } else if (item.kind === "model_misuse") {
      if (item.step) qs.set("feature_name", item.step);
      if (item.model) qs.set("model", item.model);
    } else if (item.kind === "high_error_workflow") {
      if (item.workflow) qs.set("feature_name", item.workflow);
      qs.set("status", "error");
    }
    router.push(`/dashboard/traces?${qs.toString()}`);
  }

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-center justify-between space-y-0">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            Waste Inbox
            {!isLoading && items.length > 0 && (
              <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4 font-normal">
                {items.length}
              </Badge>
            )}
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Specific spend you could cut today, ranked by potential savings
          </p>
        </div>
        {!isLoading && data && data.total_savings_usd > 0 && (
          <div
            className="text-right"
            // Title spells out that the headline is a ceiling — a workflow
            // that appears in both the retry-burner rule AND the high-error
            // rule will have its waste counted under both items, so the sum
            // can exceed the workflow's actual spend. Honest framing
            // ("up to") beats overpromising.
            title="Upper-bound estimate — overlapping signals (e.g. retries on errored calls) are counted under each rule that catches them."
          >
            <div className="text-sm font-semibold tabular-nums text-amber-300">
              up to {money(data.total_savings_usd)}
            </div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
              potential
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="px-2 pb-2">
        {isLoading ? (
          <div className="space-y-1 px-2 pb-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => {
              const k = keyOf(item);
              const isExpanded = expandedKey === k;
              return (
              <li key={k}>
                <button
                  onClick={() => setExpandedKey(isExpanded ? null : k)}
                  className={cn(
                    "w-full text-left flex items-start gap-2 px-2 py-1.5 rounded hover:bg-muted/30 transition-colors",
                  )}
                >
                  <div
                    className={cn(
                      "shrink-0 mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded border",
                      severityCls(item.severity),
                    )}
                  >
                    {iconFor(item.kind)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-xs font-medium">{item.headline}</span>
                      {item.severity === "high" && (
                        <Badge variant="outline" className="text-[9px] py-0 px-1 h-4 border-red-500/40 text-red-300">
                          high
                        </Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      Save up to{" "}
                      <span className="text-amber-300 font-medium tabular-nums">
                        {money(item.potential_savings_usd)}
                      </span>{" "}
                      in this window
                    </div>
                  </div>
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
                  )}
                </button>
                {isExpanded && (
                  <div className="ml-10 mr-2 mb-2 mt-0.5 p-2.5 rounded border border-border bg-muted/20 text-[11px] space-y-2">
                    <p className="text-muted-foreground">{item.detail}</p>
                    <p>
                      <span className="text-foreground font-medium">What to do:</span>{" "}
                      <span className="text-muted-foreground">{item.recommendation}</span>
                    </p>
                    <button
                      onClick={() => onItemClick(item)}
                      className="text-[11px] text-foreground hover:underline inline-flex items-center gap-1"
                    >
                      Open in Traces →
                    </button>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
