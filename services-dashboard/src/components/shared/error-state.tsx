import { AlertTriangle, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

// ErrorState — standardised replacement for ad-hoc red error blobs.
// Friendly message + optional retry button + optionally surfaces the raw
// error in a collapsed <details> (defaults to hidden — we don't want to
// expose server-side error strings to users in production).
//
// Variants:
//   "inline" — small horizontal strip; use inside a panel/table
//   "panel"  — full panel takeover (default)
//   "field"  — single-line "this card failed" for stat tiles etc.

type Variant = "inline" | "panel" | "field";

interface Props {
  title?: string;
  /** Optional. If omitted, generic "Refresh the page" hint is shown. */
  hint?: string;
  /** Underlying error — shown in collapsed details if showDetails is true. */
  error?: Error | null;
  /** Whether to show the raw error message. Default false (keep details private). */
  showDetails?: boolean;
  /** Optional retry callback — renders a button when provided. */
  onRetry?: () => void;
  variant?: Variant;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  hint = "Try refreshing in a moment. If this keeps happening, it's on our end.",
  error,
  showDetails = false,
  onRetry,
  variant = "panel",
  className,
}: Props) {
  if (variant === "field") {
    return (
      <p className={cn("text-xs text-red-400", className)}>
        Couldn&apos;t load — try refreshing.
      </p>
    );
  }

  const isInline = variant === "inline";
  return (
    <div
      className={cn(
        "border rounded-md border-red-500/30 bg-red-500/5",
        isInline ? "px-3 py-2 flex items-center gap-3 text-xs" : "p-6 text-sm",
        className,
      )}
    >
      <AlertTriangle
        className={cn("text-red-400 shrink-0", isInline ? "h-3.5 w-3.5" : "h-5 w-5")}
      />
      <div className="flex-1 min-w-0">
        <p className={cn("font-medium text-foreground", isInline ? "text-xs" : "text-sm mb-1")}>
          {title}
        </p>
        {!isInline && <p className="text-xs text-muted-foreground">{hint}</p>}
        {showDetails && error && (
          <details className="mt-2 text-[11px] text-muted-foreground/80">
            <summary className="cursor-pointer select-none hover:text-foreground">
              technical details
            </summary>
            <pre className="font-mono mt-1 whitespace-pre-wrap break-all bg-background/40 p-2 rounded border border-border max-h-32 overflow-auto">
              {error.message}
            </pre>
          </details>
        )}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "inline-flex items-center gap-1 rounded border border-border hover:bg-muted/60 transition-colors",
            isInline ? "text-[11px] px-2 py-1" : "text-xs px-2.5 py-1.5",
          )}
        >
          <RotateCw className={cn(isInline ? "h-3 w-3" : "h-3.5 w-3.5")} />
          Retry
        </button>
      )}
    </div>
  );
}
