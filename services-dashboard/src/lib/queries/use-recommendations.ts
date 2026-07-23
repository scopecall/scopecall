"use client";

import { useQuery } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

export type FindingCategory = "caching" | "tokens" | "speed" | "reliability" | "prompt_quality";
export type FindingSeverity = "high" | "medium" | "low";
export type FindingImpactKind = "usd" | "tokens_pct" | "seconds" | "calls" | "none";
export type FindingSource = "rule" | "llm_insight";

export interface Finding {
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  detail: string;
  recommendation: string;
  impact_kind: FindingImpactKind;
  impact_value: number;
  evidence: string;
  /** Optional scope the finding was computed over — a specific model... */
  model?: string;
  /** ...or a specific feature (workflow step / feature_name). */
  feature?: string;
  source: FindingSource;
  /** Only present on prompt_quality findings (Phase B). */
  prompt_version?: string;
}

export interface RecommendationsResponse {
  window_seconds: number;
  /** Headline: (errored + truncated-output + retried tokens) / total * 100. */
  token_wastage_pct: number;
  findings: Finding[];
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
  environment?: string;
  project?: string;
}

export function useRecommendations(params: Params, enabled = true) {
  return useQuery({
    queryKey: [
      "recommendations",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.environment,
      params.project,
    ],
    queryFn: async (): Promise<RecommendationsResponse> => {
      const headers = await authHeaders();
      const qs = new URLSearchParams({
        org_id: params.orgId,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      });
      if (params.environment) qs.set("environment", params.environment);
      if (params.project) qs.set("project", params.project);
      const res = await fetch(`${apiBase()}/api/v1/recommendations?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`recommendations: ${res.status} ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && !!params.orgId,
    staleTime: 60_000,
    retry: 1,
  });
}
