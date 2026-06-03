"use client";

import { useRouter } from "next/navigation";
import { ArrowLeftRight, GitCompare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompareSet } from "@/hooks/use-compare-set";

// Floating tray bottom-right; only renders when the compare set is non-empty.
// Mounted by DashboardProviders so it survives navigation — user can mark a
// trace on /traces, drill into another, mark it there, and the tray follows.
//
// Copy is intentionally explicit about the workflow ("Pick one more…") because
// the previous "1 marked" + disabled button left users guessing what to do next.
export function CompareTray() {
  const router = useRouter();
  const { ids, clear, count, max, toggle } = useCompareSet();

  if (count === 0) return null;

  const canCompare = count >= 2;
  function openCompare() {
    if (!canCompare) return;
    const [a, b] = ids;
    router.push(`/dashboard/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  }

  return (
    <div
      role="region"
      aria-label="Trace comparison tray"
      className="fixed bottom-4 right-4 z-50 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover shadow-lg p-3 flex flex-col gap-2"
    >
      {/* Header line — what's selected, with explicit max.
          aria-live: polite so screen readers announce count changes when
          the user marks/unmarks a trace. Not assertive — these aren't
          alarm-class updates. (D-2 from a11y review.) */}
      <div className="flex items-center gap-2" aria-live="polite" aria-atomic="true">
        <GitCompare className="h-4 w-4 text-brand shrink-0" aria-hidden="true" />
        <p className="text-xs font-medium">
          {canCompare ? (
            <>Ready to compare <span className="text-brand">2 of {max}</span></>
          ) : (
            <>Pick <span className="text-brand">one more</span> to compare</>
          )}
        </p>
        <div className="flex-1" />
        <button
          onClick={clear}
          title="Clear all marked"
          aria-label="Clear all marked traces"
          className="text-muted-foreground hover:text-foreground transition-colors -mr-1"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Chips for each marked trace — each individually removable. Lets the
          user swap one half of the pair without clearing both. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {ids.map((id, i) => (
          <div key={id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-[11px] font-mono">
            <span>{i === 0 ? "A:" : "B:"}</span>
            <span className="text-muted-foreground">{id.slice(0, 8)}…</span>
            <button
              onClick={() => toggle(id)}
              title="Remove from compare"
              aria-label="Remove from compare"
              className="text-muted-foreground hover:text-foreground -mr-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {!canCompare && (
          <span className="text-[11px] text-muted-foreground italic">
            click the ↔ icon on another row
          </span>
        )}
      </div>

      {/* Compare action */}
      <Button
        size="sm"
        variant="default"
        disabled={!canCompare}
        onClick={openCompare}
        className="w-full"
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
        Compare side-by-side
      </Button>
    </div>
  );
}
