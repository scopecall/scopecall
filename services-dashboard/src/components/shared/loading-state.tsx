import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// LoadingState — standardised replacement for ad-hoc <div>Loading…</div>
// blocks. Variants match the shape of the content that will replace them,
// so the page doesn't reflow between loading and loaded state. That eliminates
// the "layout shift" feeling that ad-hoc loading text creates.
//
// Use:
//   <LoadingState />                       // generic line of skeleton
//   <LoadingState variant="card" />        // KPI tile placeholder
//   <LoadingState variant="table" rows={5} />
//   <LoadingState variant="chart" />       // chart panel
//   <LoadingState variant="rows" rows={3} />  // list of horizontal rows

type Variant = "line" | "card" | "table" | "chart" | "rows" | "panel";

interface Props {
  variant?: Variant;
  /** For table/rows variants — how many rows to fake. Default 5. */
  rows?: number;
  /** Optional extra className for the wrapper. */
  className?: string;
}

export function LoadingState({ variant = "line", rows = 5, className }: Props) {
  if (variant === "card") {
    return (
      <div className={cn("p-3 rounded-lg border border-border bg-card", className)}>
        <div className="flex items-center gap-2 mb-2">
          <Skeleton className="size-6 rounded" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-7 w-24" />
      </div>
    );
  }
  if (variant === "table") {
    return (
      <div className={cn("border border-border rounded-md overflow-hidden", className)}>
        <div className="bg-muted/30 border-b border-border h-9 flex items-center gap-3 px-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-12" />
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="border-b border-border last:border-0 h-11 flex items-center gap-3 px-3"
          >
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-16 ml-auto" />
          </div>
        ))}
      </div>
    );
  }
  if (variant === "chart") {
    return (
      <div className={cn("border border-border rounded-lg p-4 bg-card", className)}>
        <Skeleton className="h-4 w-32 mb-3" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (variant === "rows") {
    return (
      <div className={cn("space-y-2", className)}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (variant === "panel") {
    return (
      <div className={cn("border border-border rounded-lg p-4 bg-card space-y-3", className)}>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    );
  }
  // default: single line
  return <Skeleton className={cn("h-4 w-32", className)} />;
}
