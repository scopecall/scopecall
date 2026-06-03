"use client";

import { useQuery } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

// Hand-typed — /api/v1/sdk/health isn't in the OpenAPI spec yet. Same
// precedent as use-alerts / use-graph; promote later when stable.

export interface SDKHealthSnapshot {
  last_call_at?: string;
  has_calls: boolean;
  seconds_since_last_call: number;
  calls_last_hour: number;
  calls_last_24_hour: number;
  /** 0..1 */
  recent_error_rate: number;
  distinct_environments: number;
  distinct_models: number;
  distinct_providers: number;
  sdk_versions: string[];
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

export function useSDKHealth(orgId: string, enabled = true) {
  return useQuery({
    queryKey: ["sdk-health", orgId],
    queryFn: async (): Promise<SDKHealthSnapshot> => {
      const headers = await authHeaders();
      const qs = new URLSearchParams({ org_id: orgId });
      const res = await fetch(`${apiBase()}/api/v1/sdk/health?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`sdk health: ${res.status} ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && !!orgId,
    // Two-mode poll cadence.
    //
    //   Pre-first-call (has_calls === false): 3 s. The first-run UI promises
    //   "your first trace lands here in seconds" — at 30 s the dashboard
    //   feels broken for ~25 s after the SDK auto-flushes. 3 s lines up with
    //   the SDK's 5 s flush interval so end-to-end pre-first-call latency is
    //   typically ≤ 8 s.
    //
    //   Post-first-call: 30 s. Once data is flowing, the indicator shifts
    //   from "is this working?" to "what's the throughput?" — 30 s is plenty
    //   for that. Faster polling here would just burn API quota.
    //
    // Round-7 review feedback. Implemented as a function so React Query
    // re-evaluates after every query result, flipping the cadence
    // automatically on the first non-zero call count.
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.has_calls ? 30_000 : 3_000;
    },
    staleTime: 2_000,
    retry: 1,
  });
}
