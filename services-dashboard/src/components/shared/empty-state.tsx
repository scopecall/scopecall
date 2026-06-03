import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { typography } from "@/lib/design";

// EmptyState — single source for "this page/section has nothing to show."
//
// Replaces the previous mix of:
//   - plain-text <td colSpan=N>No sessions in this range.</td>
//   - dashed-border <div>No alert rules yet. Click ...</div>
//   - bespoke flex-column hero blocks (e.g. Flow Map's "No traces in window")
//
// Three concerns the empty state should answer in plain language:
//   1. WHAT this view is (so a first-time user knows they're in the right place)
//   2. WHY it's empty (no data yet vs. filter too narrow vs. needs config)
//   3. WHAT to do next (a CTA — link or button)
//
// Use:
//   <EmptyState
//     icon={List}
//     title="No traces in this window"
//     description="Try widening the date range, or check that your SDK is sending data."
//     action={{ label: "Check SDK status", href: "/dashboard" }}
//   />
//
// For tables, use EmptyStateRow — it renders a single <tr><td colSpan=N> so it
// drops into a <tbody> without breaking the column grid.

export interface EmptyStateAction {
  label: string;
  /** Either href (renders <Link>) or onClick (renders <button>). */
  href?: string;
  onClick?: () => void;
  /** Default "primary" — brand-colored solid; "secondary" is outline only. */
  variant?: "primary" | "secondary";
}

interface Props {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  /** Compact for inline use (e.g. inside an already-padded card). */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className,
}: Props) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "py-6 px-4" : "py-10 px-6",
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            "rounded-full bg-muted/60 border border-border flex items-center justify-center mb-3",
            compact ? "size-10" : "size-12",
          )}
        >
          <Icon className={cn("text-muted-foreground", compact ? "size-4" : "size-5")} />
        </div>
      )}
      <p className={cn(typography.sectionH2, "text-foreground")}>{title}</p>
      {description && (
        <p
          className={cn(
            "text-muted-foreground mt-1 max-w-sm",
            compact ? "text-xs" : "text-xs",
          )}
        >
          {description}
        </p>
      )}
      {action && <EmptyStateActionButton action={action} className="mt-4" />}
    </div>
  );
}

function EmptyStateActionButton({
  action,
  className,
}: {
  action: EmptyStateAction;
  className?: string;
}) {
  const variant = action.variant ?? "primary";
  const cls = cn(
    "inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors",
    variant === "primary"
      ? "bg-brand text-white hover:bg-brand/90"
      : "border border-border hover:bg-muted/60 text-foreground",
    className,
  );
  if (action.href) {
    return (
      <Link href={action.href} className={cls}>
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={cls}>
      {action.label}
    </button>
  );
}

// EmptyStateRow — for use inside a <tbody>. Wraps the EmptyState in a
// <tr><td colSpan>. Saves callers from re-implementing the same one-row
// boilerplate that already drifted across Traces / Sessions / Cost.
export function EmptyStateRow({
  colSpan,
  ...props
}: Props & { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-2">
        <EmptyState compact {...props} />
      </td>
    </tr>
  );
}
