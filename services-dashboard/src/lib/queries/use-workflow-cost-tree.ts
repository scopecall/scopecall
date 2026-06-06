"use client";

import { useQuery } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

// One workflow's roll-up. Cost is summed over kind='llm' rows attributed via
// trace_id ⇒ workflow-span join. PriorCost is the same-sized window
// immediately preceding `from`, so the treemap can color tiles by delta.
//
// `name` is "" for traces that had LLM calls but no workflow span — pre-v0.3
// SDKs, or callers using bare sdk.record_llm_call(). The Overview surfaces
// that bucket as "Unattributed" so users can see what's escaping their
// cost-attribution model.
export interface WorkflowCostNode {
  name: string;
  current_cost_usd: number;
  prior_cost_usd: number;
  delta_cost_usd: number;
  pct_change: number; // -1 sentinel = no prior baseline; use is_new instead
  is_new: boolean;
  current_calls: number;
  error_count: number;
  customer_count: number;
  is_test_share: number; // 0..1 fraction
}

export interface WorkflowCostTreeResponse {
  window_seconds: number;
  /** Grand total across ALL workflows in the org's window (not just the
   *  top-N returned in `workflows`). */
  total_cost_usd: number;
  /** Sum across only the workflows actually returned. When the response
   *  was LIMIT-capped, this is a strict subset of total_cost_usd. */
  visible_cost_usd: number;
  workflows: WorkflowCostNode[];
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

export function useWorkflowCostTree(params: Params, enabled = true) {
  return useQuery({
    queryKey: [
      "workflow-cost-tree",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.limit,
    ],
    queryFn: async (): Promise<WorkflowCostTreeResponse> => {
      const headers = await authHeaders();
      const qs = new URLSearchParams({
        org_id: params.orgId,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      });
      if (params.limit) qs.set("limit", String(params.limit));
      const res = await fetch(`${apiBase()}/api/v1/workflow-cost-tree?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`workflow-cost-tree: ${res.status} ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && !!params.orgId,
    staleTime: 60_000,
    retry: 1,
  });
}
