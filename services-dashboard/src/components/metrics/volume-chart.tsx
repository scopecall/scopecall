"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import type { components } from "@/lib/api-types";

type MetricPoint = components["schemas"]["MetricPoint"];
type Granularity = "hour" | "day";

interface VolumeChartProps {
  data: MetricPoint[];
  isLoading: boolean;
  error: Error | null;
  granularity: Granularity;
}

const COLORS = ["#2563EB", "#5B54E8", "#8B5CF6", "#22D3EE", "#F59E0B", "#10B981", "#EC4899", "#EF4444", "#A855F7", "#84CC16"];

function makeFormatter(g: Granularity) {
  return (iso: string) => {
    const d = new Date(iso);
    return g === "day"
      ? d.toLocaleDateString([], { month: "short", day: "numeric" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
}

function pivotByModel(points: MetricPoint[]): { rows: Array<Record<string, number | string>>; models: string[] } {
  const byTime = new Map<string, Record<string, number | string>>();
  const modelSet = new Set<string>();
  for (const p of points) {
    if (!p.timestamp) continue;
    const key = p.timestamp;
    if (!byTime.has(key)) byTime.set(key, { timestamp: key });
    const row = byTime.get(key)!;
    const m = p.model ?? "(unknown)";
    modelSet.add(m);
    row[m] = (row[m] as number | undefined ?? 0) + (p.call_count ?? 0);
  }
  return {
    rows: Array.from(byTime.values()).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))),
    models: Array.from(modelSet).sort(),
  };
}

export function VolumeChart({ data, isLoading, error, granularity }: VolumeChartProps) {
  const router = useRouter();
  const { rows, models } = useMemo(() => pivotByModel(data), [data]);
  // Per-chart series-visibility set. Clicking a legend item toggles that model
  // in or out — same UX as Datadog / Vercel chart legends.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (name: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const xFmt = makeFormatter(granularity);

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-medium">
          Volume <span className="text-muted-foreground font-normal">(calls/{granularity === "day" ? "day" : "hr"}, stacked by model)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="h-[260px] w-full">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : error ? (
            <ErrorState variant="inline" title="Chart failed to load" error={error} />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground pt-8 text-center">No calls in this time range.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={rows}
                margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                onClick={(state) => {
                  if (state?.activeLabel) {
                    const ts = String(state.activeLabel);
                    const stepMs = granularity === "day" ? 24 * 3600_000 : 3600_000;
                    const from = new Date(ts).toISOString();
                    const to = new Date(new Date(ts).getTime() + stepMs).toISOString();
                    router.push(`/dashboard/traces?from=${from}&to=${to}`);
                  }
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" vertical={false} />
                <XAxis dataKey="timestamp" tickFormatter={xFmt} tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} width={36} />
                <Tooltip
                  formatter={(v: number, name: string) => [v.toLocaleString(), name]}
                  labelFormatter={(l) => new Date(l).toLocaleString()}
                  contentStyle={{ background: "#1F1F1F", border: "1px solid #343434", borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: "#B4B4B4", fontSize: 11 }}
                  cursor={{ fill: "rgba(91,84,232,0.08)" }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8, cursor: "pointer" }}
                  iconSize={8}
                  onClick={(o) => o?.value && toggle(String(o.value))}
                  formatter={(value: string) => (
                    <span style={{ opacity: hidden.has(value) ? 0.4 : 1 }}>{value}</span>
                  )}
                />
                {models.map((m, i) => (
                  <Bar key={m} dataKey={m} stackId="vol" fill={COLORS[i % COLORS.length]} hide={hidden.has(m)} className="cursor-pointer" />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
