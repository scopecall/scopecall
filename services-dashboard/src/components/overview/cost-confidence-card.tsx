"use client";

import { ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";
import { useCostConfidence, type CostSource } from "@/lib/queries/use-cost-confidence";
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

// Friendly labels for the closed-enum cost_source values. Kept in one place
// (and replicated on the workflow detail page's smaller bar) so the
// vocabulary stays consistent — users learn what "server-priced" means once.
function labelFor(src: CostSource): string {
  switch (src) {
    case "server_computed":
      return "Server-priced";
    case "sdk_fallback":
      return "SDK fallback";
    case "unknown_model":
      return "Unknown model";
    case "container":
      return "Container span";
    default:
      return src || "unknown";
  }
}

function colorFor(src: CostSource): string {
  switch (src) {
    case "server_computed":
      return "bg-emerald-500/70";
    case "sdk_fallback":
      return "bg-amber-500/70";
    case "unknown_model":
      return "bg-red-500/70";
    case "container":
      return "bg-muted";
    default:
      return "bg-muted";
  }
}

// Trust tone of the headline number — three tiers chosen to match the
// "you can act on this" thresholds. ≥90% verified = the data is trustworthy;
// 60-90 = double-check before making decisions on it; <60 = the dashboard's
// dollar numbers are mostly fiction and the user needs to fix their
// pricing table now.
function trustFor(pct: number): { icon: typeof ShieldCheck; tone: string; label: string } {
  if (pct >= 90) return { icon: ShieldCheck, tone: "text-emerald-300", label: "Trustworthy" };
  if (pct >= 60) return { icon: ShieldAlert, tone: "text-amber-300", label: "Partially verified" };
  return { icon: ShieldX, tone: "text-red-300", label: "Mostly unverified" };
}

export function CostConfidenceCard({ orgId, from, to, enabled }: Props) {
  const { data, isLoading } = useCostConfidence({ orgId, from, to, unknownLimit: 10 }, enabled);

  // Hide on first-run / empty windows — same convention as Regressions /
  // Waste Inbox. The card is informational; an empty state would be noise.
  if (!isLoading && data && data.total_cost_usd === 0) return null;

  const verifiedPct = data?.verified_pct ?? 100;
  const trust = trustFor(verifiedPct);
  const TrustIcon = trust.icon;

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-center justify-between space-y-0">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <TrustIcon className={cn("h-3.5 w-3.5", trust.tone)} />
            Cost confidence
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            How much of your reported cost came from server-priced rows you can trust
          </p>
        </div>
        {!isLoading && data && (
          <div className="text-right">
            <div className={cn("text-lg font-semibold tabular-nums", trust.tone)}>
              {verifiedPct.toFixed(0)}%
            </div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
              verified
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {isLoading ? (
          <>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        ) : !data ? null : (
          <>
            {/* ── Stacked bar ─────────────────────────────────────────── */}
            <div>
              <div className="flex h-3 w-full rounded overflow-hidden border border-border">
                {data.sources.map((s) => (
                  <div
                    key={s.source}
                    className={cn("h-full", colorFor(s.source as CostSource))}
                    style={{ width: `${s.pct_of_cost}%` }}
                    title={`${labelFor(s.source as CostSource)}: ${money(s.cost_usd)} (${s.pct_of_cost.toFixed(0)}%)`}
                  />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                {data.sources.map((s) => (
                  <div key={s.source} className="inline-flex items-center gap-1.5">
                    <span className={cn("inline-block w-2 h-2 rounded-sm", colorFor(s.source as CostSource))} />
                    <span>{labelFor(s.source as CostSource)}</span>
                    <span className="text-foreground tabular-nums">
                      {s.pct_of_cost.toFixed(0)}%
                    </span>
                    <span className="tabular-nums">({money(s.cost_usd)})</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Punch list: unknown models ──────────────────────────────
                Only shown when there's something to add. The actionability
                is the whole point — "your pricing table is missing these"
                converts directly into a pull-request the user can ship.
            */}
            {data.unknown_models.length > 0 && (
              <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <div className="text-xs font-medium text-amber-200">
                    Models the pricing table doesn&apos;t recognize
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Add these to{" "}
                    <code className="px-1 py-0.5 rounded bg-muted text-foreground">
                      schemas/pricing/pricing.json
                    </code>{" "}
                    to verify their cost
                  </div>
                </div>
                <ul className="space-y-1">
                  {data.unknown_models.map((u) => (
                    <li
                      key={`${u.model}-${u.provider}`}
                      className="flex items-center justify-between gap-2 text-[11px]"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <code className="font-mono text-foreground truncate">{u.model}</code>
                        <Badge
                          variant="outline"
                          className="text-[9px] py-0 px-1 h-4 border-border text-muted-foreground shrink-0"
                        >
                          {u.provider}
                        </Badge>
                      </div>
                      <div className="text-muted-foreground tabular-nums shrink-0">
                        {u.calls.toLocaleString()} calls
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {verifiedPct < 60 && (
              <p className="text-[11px] text-muted-foreground">
                <span className="text-red-300 font-medium">Heads up:</span>{" "}
                less than 60% of your cost data is server-priced. The dollar numbers on this dashboard
                are mostly SDK-supplied or zeroed — fix the unknown-model list above to trust them.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
