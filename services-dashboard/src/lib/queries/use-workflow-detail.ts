"use client";

import { useQuery } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

export interface WorkflowBreakdownRow {
  key: string;
  cost_usd: number;
  calls: number;
  error_count: number;
}

export interface WorkflowSummary {
  total_cost_usd: number;
  prior_cost_usd: number;
  delta_cost_usd: number;
  pct_change: number;
  is_new: boolean;
  total_calls: number;
  error_count: number;
  customer_count: number;
  // Cost on calls where attempt_number > 1 — surfaced as pure waste.
  retry_cost_usd: number;
  // Cost on calls where is_test=true — should not be in prod budget.
  test_cost_usd: number;
  // Sum of cache_read_cost_usd, i.e. cost avoided by hitting the provider cache.
  cache_read_savings_usd: number;
}

export interface WorkflowDetailResponse {
  workflow: string;
  window_seconds: number;
  summary: WorkflowSummary;
  by_agent: WorkflowBreakdownRow[];
  by_step: WorkflowBreakdownRow[];
  by_customer: WorkflowBreakdownRow[];
  by_model: WorkflowBreakdownRow[];
  // server_computed / sdk_fallback / unknown_model / container — Phase B3 input.
  cost_source_mix: WorkflowBreakdownRow[];
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
  workflow: string;
  from: Date;
  to: Date;
}

export function useWorkflowDetail(params: Params, enabled = true) {
  return useQuery({
    queryKey: [
      "workflow-detail",
      params.orgId,
      params.workflow,
      params.from.toISOString(),
      params.to.toISOString(),
    ],
    queryFn: async (): Promise<WorkflowDetailResponse> => {
      const headers = await authHeaders();
      const qs = new URLSearchParams({
        org_id: params.orgId,
        workflow: params.workflow,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      });
      const res = await fetch(`${apiBase()}/api/v1/workflow-detail?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`workflow-detail: ${res.status} ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && !!params.orgId && !!params.workflow,
    staleTime: 60_000,
    retry: 1,
  });
}
