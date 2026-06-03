"use client";

import { useQuery } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

// Hand-typed wire format — /api/v1/graph isn't in the OpenAPI spec yet.
// Same precedent as use-alerts.ts: promote to spec once the endpoint stabilizes.

export interface GraphNode {
  id: string;
  op: string;
  model: string;
  /**
   * "llm" (default) or "workflow". Workflow nodes are sdk.trace()
   * containers — no model, zero cost, latency = full block duration.
   * Render them as containers (rounded badge, no model chip), not as
   * provider calls. Lets the user visually parse fan-out structure.
   * Surfaced by the Go graph query as of Round 4. May be undefined on
   * responses from older API binaries — treat undefined as "llm".
   */
  kind?: "llm" | "workflow";
  calls: number;
  total_cost_usd: number;
  avg_latency_ms: number;
  p99_latency_ms: number;
  error_count: number;
  /** 0..1 */
  error_rate: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  count: number;
  /** 0..1 — share of `from`'s outbound traffic */
  pct: number;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
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

interface GraphParams {
  orgId: string;
  from: Date;
  to: Date;
  limit?: number;
}

export interface ExpandedCall {
  span_id: string;
  trace_id: string;
  parent_span_id: string;
  op: string;
  model: string;
  status: string;
  latency_ms: number;
  cost_usd: number;
  timestamp: string;
  is_focus: boolean;
}

export interface ExpandResponse {
  calls: ExpandedCall[];
}

interface ExpandParams {
  orgId: string;
  op: string;
  model: string;
  from: Date;
  to: Date;
  limit?: number;
}

export function useNodeExpand(params: ExpandParams | null, enabled = true) {
  return useQuery({
    queryKey: params
      ? [
          "graph-expand",
          params.orgId,
          params.op,
          params.model,
          params.from.toISOString(),
          params.to.toISOString(),
          params.limit,
        ]
      : ["graph-expand", "disabled"],
    queryFn: async (): Promise<ExpandResponse> => {
      if (!params) return { calls: [] };
      const headers = await authHeaders();
      const qs = new URLSearchParams({
        org_id: params.orgId,
        op: params.op,
        model: params.model,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      });
      if (params.limit) qs.set("limit", String(params.limit));
      const res = await fetch(`${apiBase()}/api/v1/graph/expand?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`expand: ${res.status} ${await res.text()}`);
      return res.json();
    },
    staleTime: 60_000,
    enabled: enabled && !!params,
    retry: 1,
  });
}

export function useFlowGraph(params: GraphParams, enabled = true) {
  return useQuery({
    queryKey: [
      "graph",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.limit,
    ],
    queryFn: async (): Promise<GraphResponse> => {
      const headers = await authHeaders();
      const qs = new URLSearchParams({
        org_id: params.orgId,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      });
      if (params.limit) qs.set("limit", String(params.limit));
      const res = await fetch(`${apiBase()}/api/v1/graph?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`graph: ${res.status} ${await res.text()}`);
      return res.json();
    },
    staleTime: 60_000,
    enabled,
    retry: 1,
  });
}
