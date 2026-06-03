"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import type { components } from "@/lib/api-types";

type MetricPoint = components["schemas"]["MetricPoint"];
type Granularity = "hour" | "day";

interface LatencyChartProps {
  data: MetricPoint[];
  isLoading: boolean;
  error: Error | null;
  granularity: Granularity;
}

function makeFormatter(g: Granularity) {
  return (iso: string) => {
    const d = new Date(iso);
    return g === "day"
      ? d.toLocaleDateString([], { month: "short", day: "numeric" })
      : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
}

function aggregate(points: MetricPoint[]): Array<{ timestamp: string; avg: number; p99: number }> {
  const byTime = new Map<string, { totalCalls: number; weightedAvg: number; p99: number }>();
  for (const p of points) {
    if (!p.timestamp) continue;
    const key = p.timestamp;
    const calls = p.call_count ?? 0;
    const avg = p.avg_latency_ms ?? 0;
    const p99 = p.p99_latency_ms ?? 0;
    if (!byTime.has(key)) byTime.set(key, { totalCalls: 0, weightedAvg: 0, p99: 0 });
    const e = byTime.get(key)!;
    e.weightedAvg += avg * calls;
    e.totalCalls += calls;
    e.p99 = Math.max(e.p99, p99);
  }
  return Array.from(byTime.entries())
    .map(([timestamp, v]) => ({
      timestamp,
      avg: v.totalCalls > 0 ? v.weightedAvg / v.totalCalls : 0,
      p99: v.p99,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function LatencyChart({ data, isLoading, error, granularity }: LatencyChartProps) {
  const router = useRouter();
  const rows = useMemo(() => aggregate(data), [data]);
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
          Latency <span className="text-muted-foreground font-normal">(avg · p99)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="h-[260px] w-full">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : error ? (
            <ErrorState variant="inline" title="Chart failed to load" error={error} />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground pt-8 text-center">No data in this time range.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
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
                <YAxis tickFormatter={(v) => `${v}ms`} tick={{ fontSize: 11, fill: "#888" }} tickLine={false} axisLine={false} width={56} />
                <Tooltip
                  formatter={(v: number, name: string) => [`${Math.round(v)}ms`, name]}
                  labelFormatter={(l) => new Date(l).toLocaleString()}
                  contentStyle={{ background: "#1F1F1F", border: "1px solid #343434", borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: "#B4B4B4", fontSize: 11 }}
                  cursor={{ stroke: "rgba(91,84,232,0.3)" }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8, cursor: "pointer" }}
                  iconSize={8}
                  onClick={(o) => o?.value && toggle(String(o.value))}
                  formatter={(value: string) => (
                    <span style={{ opacity: hidden.has(value) ? 0.4 : 1 }}>{value}</span>
                  )}
                />
                <Line type="monotone" dataKey="avg" name="avg" stroke="#5B54E8" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} hide={hidden.has("avg")} />
                <Line type="monotone" dataKey="p99" name="p99" stroke="#F59E0B" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} hide={hidden.has("p99")} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
