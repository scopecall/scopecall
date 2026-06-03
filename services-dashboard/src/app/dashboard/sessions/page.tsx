"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Users } from "lucide-react";
import { useSessions } from "@/lib/queries/use-sessions";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useOrgId } from "@/lib/org-context";
import { DateRangePicker, type DateRange } from "@/components/shared/date-range-picker";
import { LoadingState } from "@/components/shared/loading-state";
import { EmptyStateRow } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { money, num } from "@/lib/format";
import { cn } from "@/lib/utils";

function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// Human-readable duration. Sessions can be anywhere from <1s to days.
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function SessionsView() {
  useDocumentTitle("Sessions");
  const orgId = useOrgId();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [range, setRange] = useState(defaultRange);
  const [userInput, setUserInput] = useState<string>(searchParams.get("user_id") ?? "");
  const [userId, setUserId] = useState<string | undefined>(() => searchParams.get("user_id") ?? undefined);

  function applyUser() {
    const v = userInput.trim();
    setUserId(v === "" ? undefined : v);
  }

  const { data, isLoading, error, refetch } = useSessions(
    { orgId: orgId ?? "", from: range.from, to: range.to, userId, limit: 100 },
    !!orgId,
  );
  useApiError(error, refetch);

  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Sessions</h1>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            Calls grouped by session_id — click any row to see the conversation
          </span>
        </div>
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {/* user_id filter — the primary use case ("show me user_042's sessions"). */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Filter by user_id (Enter to apply)"
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyUser(); } }}
          onBlur={applyUser}
          className="rounded-md border border-input bg-background px-3 text-sm h-8 w-72 focus:outline-none focus:border-ring"
        />
        {userId && (
          <button
            onClick={() => { setUserInput(""); setUserId(undefined); }}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Clear
          </button>
        )}
      </div>

      <div className="border border-border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Session</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden sm:table-cell">User</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">Calls</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">Cost</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground hidden md:table-cell">Duration</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground hidden lg:table-cell">Errors</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden md:table-cell">Last seen</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground w-10"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {Array.from({ length: 8 }).map((_, j) => (
                    <td key={j} className="px-3 py-2.5"><Skeleton className="h-4 w-full" /></td>
                  ))}
                </tr>
              ))
            ) : sessions.length === 0 ? (
              <EmptyStateRow
                colSpan={8}
                icon={Users}
                title={userId ? `No sessions for ${userId}` : "No sessions yet"}
                description={
                  userId
                    ? "Try widening the date range, or check that this user_id has any traffic."
                    : "Sessions group LLM calls by session_id. Any call your SDK sends with a session_id will appear here."
                }
              />
            ) : (
              sessions.map((s) => (
                <tr
                  key={s.session_id}
                  onClick={() => router.push(`/dashboard/traces?q=${encodeURIComponent(s.session_id)}`)}
                  className={cn(
                    "border-b border-border last:border-0 cursor-pointer transition-colors hover:bg-muted/30",
                  )}
                >
                  <td className="px-3 py-2.5 font-mono text-xs">{s.session_id}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground hidden sm:table-cell">
                    {s.user_id || <span className="italic">(none)</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(s.call_count)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">{money(s.total_cost_usd)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                    {fmtDuration(s.duration_ms)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums hidden lg:table-cell">
                    {s.error_count > 0
                      ? <span className="text-red-400">{num(s.error_count)}</span>
                      : <span className="text-muted-foreground">0</span>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">
                    <RelativeTime date={s.last_at} />
                  </td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground">
                    <ArrowRight className="h-3.5 w-3.5 inline" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Clicking a session opens Traces filtered by its session_id — every call in the conversation, in order.
      </p>
    </div>
  );
}

export default function SessionsPage() {
  return (
    <Suspense fallback={<LoadingState variant="table" rows={6} />}>
      <SessionsView />
    </Suspense>
  );
}
