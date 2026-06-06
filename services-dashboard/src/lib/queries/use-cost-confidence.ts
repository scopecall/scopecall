"use client";

import { useQuery } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

export type CostSource =
  | "server_computed"
  | "sdk_fallback"
  | "unknown_model"
  | "container"
  | string; // future-proofing: keep open type for unknown server values

export interface CostSourceShare {
  source: CostSource;
  calls: number;
  cost_usd: number;
  pct_of_cost: number;
}

export interface UnknownModel {
  model: string;
  provider: string;
  calls: number;
  cost_usd: number; // SDK-supplied fallback; usually 0 for unknown_model rows
}

export interface CostConfidenceResponse {
  window_seconds: number;
  total_cost_usd: number;
  server_computed_cost_usd: number;
  // Headline number: server_computed / total × 100. 100 when total=0.
  verified_pct: number;
  sources: CostSourceShare[];
  unknown_models: UnknownModel[];
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
  unknownLimit?: number;
}

export function useCostConfidence(params: Params, enabled = true) {
  return useQuery({
    queryKey: [
      "cost-confidence",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.unknownLimit,
    ],
    queryFn: async (): Promise<CostConfidenceResponse> => {
      const headers = await authHeaders();
      const qs = new URLSearchParams({
        org_id: params.orgId,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      });
      if (params.unknownLimit) qs.set("unknown_limit", String(params.unknownLimit));
      const res = await fetch(`${apiBase()}/api/v1/cost-confidence?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`cost-confidence: ${res.status} ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && !!params.orgId,
    staleTime: 60_000,
    retry: 1,
  });
}
