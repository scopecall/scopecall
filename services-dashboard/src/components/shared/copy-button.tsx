"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  value: string;
  className?: string;
  /** When true, render only the copy icon — no truncated preview text. Use
   *  this when the caller is already displaying `value` in full nearby, so
   *  the truncated chip becomes a confusing duplicate (e.g. trace detail
   *  page header showing the full trace_id next to the button). */
  iconOnly?: boolean;
}

export function CopyButton({ value, className, iconOnly = false }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      onClick={copy}
      className={cn(
        "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors",
        className
      )}
      title={iconOnly ? `Copy ${value}` : "Copy to clipboard"}
      aria-label={iconOnly ? `Copy ${value}` : undefined}
    >
      {!iconOnly && <code className="font-mono">{value.slice(0, 12)}…</code>}
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
