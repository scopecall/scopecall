"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/shared/error-state";
import type { components } from "@/lib/api-types";

type ErrorBucket = components["schemas"]["ErrorBucket"];
type Granularity = "hour" | "day";

interface StatusErrorsChartProps {
  data: ErrorBucket[];
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

const COLORS = {
  error: "#EF4444",
  timeout: "#F59E0B",
  rate_limited: "#A855F7",
};

export function StatusErrorsChart({ data, isLoading, error, granularity }: StatusErrorsChartProps) {
  const router = useRouter();
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
          Errors <span className="text-muted-foreground font-normal">(stacked by status)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="h-[260px] w-full">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : error ? (
            <ErrorState variant="inline" title="Chart failed to load" error={error} />
          ) : data.length === 0 ? (
            <p className="text-sm text-muted-foreground pt-8 text-center">No failures in this time range.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                onClick={(state) => {
                  if (state?.activeLabel) {
                    const ts = String(state.activeLabel);
                    const stepMs = granularity === "day" ? 24 * 3600_000 : 3600_000;
                    const from = new Date(ts).toISOString();
                    const to = new Date(new Date(ts).getTime() + stepMs).toISOString();
                    router.push(`/dashboard/traces?from=${from}&to=${to}&status=error`);
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
                  cursor={{ fill: "rgba(239,68,68,0.08)" }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8, cursor: "pointer" }}
                  iconSize={8}
                  onClick={(o) => o?.value && toggle(String(o.value))}
                  formatter={(value: string) => (
                    <span style={{ opacity: hidden.has(value) ? 0.4 : 1 }}>{value}</span>
                  )}
                />
                <Bar dataKey="error" stackId="err" fill={COLORS.error} hide={hidden.has("error")} className="cursor-pointer" />
                <Bar dataKey="timeout" stackId="err" fill={COLORS.timeout} hide={hidden.has("timeout")} className="cursor-pointer" />
                <Bar dataKey="rate_limited" stackId="err" fill={COLORS.rate_limited} hide={hidden.has("rate_limited")} className="cursor-pointer" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
