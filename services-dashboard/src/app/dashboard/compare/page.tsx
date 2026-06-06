"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, GitCompare } from "lucide-react";
import { useTraceTree } from "@/lib/queries/use-trace-tree";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useOrgId } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/shared/status-badge";
import { RelativeTime } from "@/components/shared/relative-time";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { card } from "@/lib/design";
import { money, num } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { components } from "@/lib/api-types";

type Trace = components["schemas"]["Trace"];

function CompareView() {
  useDocumentTitle("Compare");
  const router = useRouter();
  const sp = useSearchParams();
  const orgId = useOrgId();
  const a = sp.get("a") ?? "";
  const b = sp.get("b") ?? "";

  const aQ = useTraceTree({ orgId: orgId ?? "", traceId: a }, !!orgId && !!a);
  const bQ = useTraceTree({ orgId: orgId ?? "", traceId: b }, !!orgId && !!b);
  useApiError(aQ.error ?? bQ.error);

  if (!a || !b) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard/traces")} className="gap-1">
          <ArrowLeft className="h-4 w-4" /> Traces
        </Button>
        <div className={card.dashed}>
          <EmptyState
            icon={GitCompare}
            title="Pick two traces to compare"
            description={
              "On the Traces page, click the ↔ icon on two rows. Then come back here — " +
              "we'll show them side by side with shared spans highlighted."
            }
            action={{ label: "Go to Traces", href: "/dashboard/traces", variant: "secondary" }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard/traces")} className="gap-1">
          <ArrowLeft className="h-4 w-4" /> Traces
        </Button>
        <h1 className="text-lg font-semibold">Compare</h1>
        <span className="text-xs text-muted-foreground">
          Side-by-side trace diff — same span_id across both columns is highlighted.
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CompareColumn
          label="A"
          traceId={a}
          spans={aQ.data?.spans ?? []}
          isLoading={aQ.isLoading}
          error={aQ.error}
          otherSpans={bQ.data?.spans ?? []}
        />
        <CompareColumn
          label="B"
          traceId={b}
          spans={bQ.data?.spans ?? []}
          isLoading={bQ.isLoading}
          error={bQ.error}
          otherSpans={aQ.data?.spans ?? []}
        />
      </div>
    </div>
  );
}

interface CompareColumnProps {
  label: string;
  traceId: string;
  spans: Trace[];
  isLoading: boolean;
  error: Error | null;
  otherSpans: Trace[]; // for detecting shared span_ids — visual cue
}

function CompareColumn({ label, traceId, spans, isLoading, error, otherSpans }: CompareColumnProps) {
  const otherSpanIds = new Set(otherSpans.map((s) => s.span_id));

  // Rollups for this trace
  const totalLatency = spans.reduce((m, s) => Math.max(m, s.latency_ms), 0);
  const totalCost = spans.reduce((sum, s) => sum + s.cost_usd, 0);
  const totalTokens = spans.reduce((sum, s) => sum + s.input_tokens + s.output_tokens, 0);

  return (
    <div className="border border-border rounded-md bg-card">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <span className="size-5 rounded-full bg-primary/15 text-primary inline-flex items-center justify-center text-xs font-semibold">
          {label}
        </span>
        <Link
          // traceId came from the URL (`?a=...&b=...`) so encode it before
          // interpolating into a path. A traceId containing `?` would inject
          // a query string; `/../foo` would normalize to an unexpected route.
          // Same-origin same-auth-context so not a security boundary, but it
          // produces broken links otherwise.
          href={`/dashboard/traces/${encodeURIComponent(traceId)}`}
          className="font-mono text-xs hover:underline truncate flex items-center gap-1"
          title="Open this trace"
        >
          {traceId} <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {isLoading ? (
        <LoadingState variant="rows" rows={6} className="p-4" />
      ) : error ? (
        <div className="p-4">
          <ErrorState
            variant="inline"
            title="Couldn't load this trace"
            error={error}
          />
        </div>
      ) : spans.length === 0 ? (
        <EmptyState
          compact
          icon={GitCompare}
          title="Trace not found"
          description="It may have aged out of the retention window, or the ID is mistyped."
        />
      ) : (
        <>
          {/* Per-trace rollups */}
          <div className="grid grid-cols-3 divide-x divide-border border-b border-border text-center">
            <Stat label="Spans" value={num(spans.length)} />
            <Stat label="Max latency" value={`${totalLatency}ms`} />
            <Stat label="Total cost" value={money(totalCost)} />
          </div>

          {/* Span list, chronological */}
          <ul className="divide-y divide-border">
            {[...spans]
              .sort((x, y) => new Date(x.timestamp).getTime() - new Date(y.timestamp).getTime())
              .map((s) => {
                const shared = otherSpanIds.has(s.span_id);
                return (
                  <li
                    key={s.span_id}
                    className={cn(
                      "px-4 py-2 text-sm",
                      shared && "bg-emerald-500/5 border-l-2 border-emerald-500/40",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs truncate flex-1">
                        {(s.feature_name ?? "") !== "" ? s.feature_name : s.model}
                      </span>
                      <StatusBadge status={s.status} />
                    </div>
                    <div className="text-[11px] text-muted-foreground tabular-nums mt-0.5 flex items-center gap-2">
                      <span>{s.latency_ms}ms</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span>{s.input_tokens.toLocaleString()} → {s.output_tokens.toLocaleString()} tok</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span>{money(s.cost_usd)}</span>
                    </div>
                    {s.error_message && (
                      <div className="text-[11px] text-red-400 font-mono mt-1 truncate">{s.error_message}</div>
                    )}
                  </li>
                );
              })}
          </ul>

          {/* Total tokens at the bottom (less important than the head stats) */}
          <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground">
            Total tokens: <span className="text-foreground tabular-nums">{totalTokens.toLocaleString()}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={<LoadingState variant="panel" />}>
      <CompareView />
    </Suspense>
  );
}
