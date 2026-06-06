"use client";

import { useQuery } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

export interface CustomerProfitabilityRow {
  customer_id: string;
  current_cost_usd: number;
  prior_cost_usd: number;
  delta_cost_usd: number;
  pct_change: number; // -1 sentinel = no prior baseline; use is_new instead
  is_new: boolean;
  current_calls: number;
  error_count: number;
  workflow_count: number;
  model_count: number;
  retry_cost_usd: number;
  test_cost_usd: number;
  cache_read_savings_usd: number;
  // Share of *attributed* cost (not grand total) — rows sum to 100%.
  pct_of_attributed: number;
}

export interface CustomerProfitabilityResponse {
  window_seconds: number;
  grand_total_cost_usd: number;
  attributed_cost_usd: number;
  // Spend that had no customer_id — surfaced as "Unattributed" on the page.
  unattributed_cost_usd: number;
  attributed_customer_count: number;
  rows: CustomerProfitabilityRow[];
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

export function useCustomerProfitability(params: Params, enabled = true) {
  return useQuery({
    queryKey: [
      "customer-profitability",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.limit,
    ],
    queryFn: async (): Promise<CustomerProfitabilityResponse> => {
      const headers = await authHeaders();
      const qs = new URLSearchParams({
        org_id: params.orgId,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      });
      if (params.limit) qs.set("limit", String(params.limit));
      const res = await fetch(`${apiBase()}/api/v1/customer-profitability?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`customer-profitability: ${res.status} ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && !!params.orgId,
    staleTime: 60_000,
    retry: 1,
  });
}
