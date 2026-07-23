"use client";

import { useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Coins,
  Database,
  Gauge,
  MessageSquareWarning,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import {
  type Finding,
  type FindingCategory,
  type FindingImpactKind,
  type RecommendationsResponse,
} from "@/lib/queries/use-recommendations";
import { cn } from "@/lib/utils";
import { money } from "@/lib/format";

interface Props {
  data?: RecommendationsResponse;
  isLoading: boolean;
  /** Drill-in, mirrors the page's `drill(param, value)` used by the Waste Inbox rows. */
  onOpenTraces?: (param: string, value: string) => void;
}

// Fixed display order — deterministic rules read top-to-bottom the same way
// every time regardless of which categories happen to have findings.
const CATEGORY_ORDER: FindingCategory[] = [
  "caching",
  "tokens",
  "speed",
  "reliability",
  "prompt_quality",
];

const CATEGORY_LABEL: Record<FindingCategory, string> = {
  caching: "Caching",
  tokens: "Tokens",
  speed: "Speed",
  reliability: "Reliability",
  prompt_quality: "Prompt quality",
};

function categoryIcon(cat: FindingCategory) {
  switch (cat) {
    case "caching":
      return <Database className="h-3.5 w-3.5" />;
    case "tokens":
      return <Coins className="h-3.5 w-3.5" />;
    case "speed":
      return <Gauge className="h-3.5 w-3.5" />;
    case "reliability":
      return <ShieldAlert className="h-3.5 w-3.5" />;
    case "prompt_quality":
      return <MessageSquareWarning className="h-3.5 w-3.5" />;
    default:
      return <Wrench className="h-3.5 w-3.5" />;
  }
}

// Same low-saturation severity tones as the Waste Inbox — this section sits
// right below it, so the two should read as one visual language.
function severityCls(sev: Finding["severity"]): string {
  switch (sev) {
    case "high":
      return "border-red-500/40 bg-red-500/5 text-red-300";
    case "medium":
      return "border-amber-500/40 bg-amber-500/5 text-amber-300";
    default:
      return "border-border text-muted-foreground";
  }
}

// Drop a trailing ".0" but keep real decimals (e.g. 3.7% tokens, not 3.70%).
function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function impactLabel(kind: FindingImpactKind, value: number): string | null {
  switch (kind) {
    case "usd":
      return money(value);
    case "tokens_pct":
      return `${trimNum(value)}% tokens`;
    case "seconds":
      return `${trimNum(value)}s`;
    case "calls":
      return `${trimNum(value)} ${value === 1 ? "call" : "calls"}`;
    default:
      return null;
  }
}

function keyOf(f: Finding, i: number): string {
  return `${f.category}|${f.title}|${f.model ?? ""}|${f.feature ?? ""}|${i}`;
}

export function OptimizationGaps({ data, isLoading, onOpenTraces }: Props) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const findings = data?.findings ?? [];
  const wastagePct = data?.token_wastage_pct ?? 0;

  const groups = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    findings: findings.filter((f) => f.category === cat),
  })).filter((g) => g.findings.length > 0);

  return (
    <section className="relative overflow-hidden rounded-xl ring-1 ring-foreground/10 bg-card">
      <div className="absolute inset-0 bg-gradient-to-br from-sky-500/[0.08] via-transparent to-transparent pointer-events-none" />
      <div className="absolute left-0 inset-y-0 w-1 bg-gradient-to-b from-sky-400 to-sky-600" />
      <div className="relative p-5 pl-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Wrench className="h-4 w-4 text-sky-400" /> Optimization Gaps
              {!isLoading && findings.length > 0 && (
                <span className="text-[11px] font-medium border border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300 rounded px-1.5 py-0.5">
                  {findings.length} {findings.length === 1 ? "finding" : "findings"}
                </span>
              )}
            </h2>
            <p className="text-[12px] text-muted-foreground mt-0.5">
              Caching, token, latency, reliability, and prompt-quality gaps across this window.
            </p>
          </div>
          {!isLoading && data && wastagePct > 0 && (
            <div
              className="text-right shrink-0"
              title="Share of tokens spent on errored calls, truncated output, or retries — tokens that bought nothing."
            >
              <div className="text-3xl font-semibold tabular-nums leading-none text-sky-600 dark:text-sky-300">
                {trimNum(wastagePct)}%
              </div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">
                token wastage · this window
              </div>
            </div>
          )}
        </div>

        <div className="mt-4">
          {isLoading ? (
            <RowsSkeleton />
          ) : findings.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-card/40 p-5 text-center">
              <p className="text-sm text-foreground">No optimization gaps in this window.</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Caching, token, latency, reliability, and prompt-quality checks all came back clean.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g.category}>
                  <div className="flex items-center gap-1.5 px-2 mb-1 text-muted-foreground">
                    {categoryIcon(g.category)}
                    <span className="text-[11px] font-medium uppercase tracking-wider">
                      {CATEGORY_LABEL[g.category]}
                    </span>
                    <span className="text-[10px]">· {g.findings.length}</span>
                  </div>
                  <ul className="space-y-1">
                    {g.findings.map((f, i) => {
                      const k = keyOf(f, i);
                      return (
                        <FindingRow
                          key={k}
                          finding={f}
                          isExpanded={expandedKey === k}
                          onToggle={() => setExpandedKey(expandedKey === k ? null : k)}
                          onOpenTraces={onOpenTraces}
                        />
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FindingRow({
  finding,
  isExpanded,
  onToggle,
  onOpenTraces,
}: {
  finding: Finding;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenTraces?: (param: string, value: string) => void;
}) {
  const impact = impactLabel(finding.impact_kind, finding.impact_value);
  const canDrill = !!(onOpenTraces && (finding.feature || finding.model));
  const drill = () => {
    if (!onOpenTraces) return;
    if (finding.feature) onOpenTraces("feature", finding.feature);
    else if (finding.model) onOpenTraces("model", finding.model);
  };

  return (
    <li>
      <button
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded row-interactive"
      >
        <span
          className={cn(
            "shrink-0 mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded border",
            severityCls(finding.severity),
          )}
        >
          {categoryIcon(finding.category)}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs font-medium">{finding.title}</span>
            {finding.severity === "high" && (
              <span className="text-[10px] py-0 px-1 h-4 inline-flex items-center rounded border border-red-500/40 text-red-300">
                high
              </span>
            )}
            <SourceTag source={finding.source} />
          </span>
          <span className="block text-[11px] text-muted-foreground mt-0.5">
            {impact ? (
              <>
                Up to{" "}
                <span className="text-sky-600 dark:text-sky-300 font-medium tabular-nums">{impact}</span>{" "}
                in this window
              </>
            ) : (
              finding.evidence
            )}
          </span>
        </span>
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
        )}
      </button>
      {isExpanded && (
        <div className="ml-10 mr-2 mb-2 mt-0.5 p-2.5 rounded border border-border bg-muted/20 text-[11px] space-y-2">
          <p className="text-muted-foreground">{finding.detail}</p>
          <p>
            <span className="text-foreground font-medium">What to do:</span>{" "}
            <span className="text-muted-foreground">{finding.recommendation}</span>
          </p>
          <p className="text-muted-foreground">
            <span className="text-foreground font-medium">Evidence:</span> {finding.evidence}
          </p>
          {canDrill && (
            <button
              onClick={drill}
              className="text-[11px] text-foreground hover:underline inline-flex items-center gap-1"
            >
              Open in Traces →
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// Subtle rule-vs-AI tag — deterministic findings are the trustworthy default;
// llm_insight findings (Phase B prompt audit) are flagged so users calibrate
// trust accordingly without either being buried or over-emphasized.
function SourceTag({ source }: { source: Finding["source"] }) {
  const isAi = source === "llm_insight";
  return (
    <span
      className={cn(
        "text-[9px] py-0 px-1 h-4 inline-flex items-center gap-0.5 rounded border",
        isAi ? "border-purple-400/40 text-purple-300" : "border-border text-muted-foreground",
      )}
      title={isAi ? "Generated by an LLM prompt-quality audit" : "Deterministic rule over your call data"}
    >
      {isAi ? <Bot className="h-2.5 w-2.5" /> : null}
      {isAi ? "AI" : "rule"}
    </span>
  );
}

function RowsSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-9 rounded bg-muted/30 animate-pulse" />
      ))}
    </div>
  );
}
