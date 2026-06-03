"use client";

import { useQuery } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

export type RegressionKind = "latency_p99" | "error_rate" | "cost" | "volume_drop";
export type RegressionSeverity = "critical" | "watch";

export interface Regression {
  kind: RegressionKind;
  severity: RegressionSeverity;
  feature: string; // may be empty when feature_name was unset
  model: string;
  current_value: number;
  prior_value: number;
  pct_change: number;
  current_calls: number;
}

export interface RegressionsResponse {
  regressions: Regression[];
  prior_from: string;
  prior_to: string;
}

function apiBase(): string {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "authjs") return "/api/proxy";
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3004";
}

async function authHeaders(): Promise<Record<string, string>> {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "authjs") return {};
  const token = await auth.getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface Params {
  orgId: string;
  from: Date;
  to: Date;
  limit?: number;
}

export function useRegressions(params: Params, enabled = true) {
  return useQuery({
    queryKey: [
      "regressions",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.limit,
    ],
    queryFn: async (): Promise<RegressionsResponse> => {
      const headers = await authHeaders();
      const qs = new URLSearchParams({
        org_id: params.orgId,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      });
      if (params.limit) qs.set("limit", String(params.limit));
      const res = await fetch(`${apiBase()}/api/v1/regressions?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`regressions: ${res.status} ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && !!params.orgId,
    staleTime: 60_000,
    retry: 1,
  });
}
