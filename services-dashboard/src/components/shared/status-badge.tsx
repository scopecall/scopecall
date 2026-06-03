import { cn } from "@/lib/utils";
import { statusPill } from "@/lib/design";

// StatusBadge — the single visual representation of a span/trace status
// across the dashboard. Uses the translucent palette from design.statusPill
// so the SAME status (e.g. "error") looks IDENTICAL whether it appears here,
// on the alerts page, in regressions, or in insights cards. Previously this
// component used a heavier `bg-{color}-950` palette that differed visibly
// from every other pill in the app.
//
// Status values come from the Go enum on llm_calls.status — extend `tones`
// below when a new status is added on the backend.

type Status = "success" | "error" | "timeout" | "rate_limited";

const tones: Record<Status, keyof Omit<typeof statusPill, "base">> = {
  success: "ok",
  error: "error",
  timeout: "warn",
  rate_limited: "info",
};

const labels: Record<Status, string> = {
  success: "ok",
  error: "error",
  timeout: "timeout",
  rate_limited: "rate limited",
};

export function StatusBadge({ status }: { status: string }) {
  const s = status as Status;
  const tone = tones[s] ?? "neutral";
  return (
    <span className={cn(statusPill.base, "font-mono", statusPill[tone])}>
      {labels[s] ?? status}
    </span>
  );
}
