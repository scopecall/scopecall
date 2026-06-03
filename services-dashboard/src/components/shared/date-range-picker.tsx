"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CalendarIcon } from "lucide-react";

export interface DateRange {
  from: Date;
  to: Date;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  /**
   * Optional. When set:
   *   "hour" → only hour-scale presets (≤ 24h) — daily-scale ones hidden
   *   "day"  → only day-scale presets (≥ 7d)  — hourly ones hidden
   * Prevents incoherent combinations like hourly granularity over 30 days
   * (720 buckets crushed into the chart). Omit for callers (Sessions, Cost)
   * that don't have a granularity toggle and want all presets.
   */
  granularity?: "hour" | "day";
}

interface Preset { label: string; hours: number; scale: "hour" | "day" }
const presets: Preset[] = [
  { label: "Last 1 hour",   hours: 1,        scale: "hour" },
  { label: "Last 6 hours",  hours: 6,        scale: "hour" },
  { label: "Last 24 hours", hours: 24,       scale: "hour" },
  { label: "Last 7 days",   hours: 24 * 7,   scale: "day"  },
  { label: "Last 30 days",  hours: 24 * 30,  scale: "day"  },
];

function formatRange(range: DateRange, available: Preset[]): string {
  const now = new Date();
  const diffH = (now.getTime() - range.from.getTime()) / (1000 * 60 * 60);
  for (const p of available) {
    if (Math.abs(diffH - p.hours) < 0.1) return p.label;
  }
  return `${range.from.toLocaleDateString()} – ${range.to.toLocaleDateString()}`;
}

/**
 * Always emits absolute Date objects — never relative strings.
 * This is the single source of truth that converts "Last 24h" into actual
 * ISO8601 timestamps before they reach any API call.
 */
export function DateRangePicker({ value, onChange, granularity }: DateRangePickerProps) {
  const available = granularity
    ? presets.filter((p) => p.scale === granularity)
    : presets;

  function applyPreset(hours: number) {
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    onChange({ from, to });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors">
        <CalendarIcon className="h-3.5 w-3.5" />
        {formatRange(value, available)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {available.map((p) => (
          <DropdownMenuItem key={p.hours} onClick={() => applyPreset(p.hours)}>
            {p.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled className="text-xs text-muted-foreground">
          Custom range — coming soon
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
