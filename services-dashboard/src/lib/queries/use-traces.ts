"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

interface TracesParams {
  orgId: string;
  from: Date;
  to: Date;
  cursor?: string;
  limit?: number;
  model?: string;
  status?: "success" | "error" | "timeout" | "rate_limited";
  featureName?: string;
  provider?: string;
  userId?: string;
  environment?: string;
  q?: string;
  /** Filter to one prompt version. Pass "__null__" for untagged calls. */
  promptVersion?: string;
  /** v0.3 — B2B tenant filter. Drilled into from /dashboard/customers and
   *  the workflow-detail by-customer panel. */
  customerId?: string;
  /** v0.3 — scope to all calls inside this workflow (resolves to trace_id
   *  IN-subquery against kind='workflow' rows). Use this instead of
   *  featureName when drilling from the Workflow Treemap or Waste Inbox. */
  workflow?: string;
  /** v0.3 — scope to all calls inside this agent. */
  agent?: string;
  /** v0.3 — scope to all calls inside this step. */
  step?: string;
  /** When set, the query refetches at this interval (ms). For live-tail. */
  refetchIntervalMs?: number;
}

export function useTraces(params: TracesParams, enabled = true) {
  return useQuery({
    queryKey: [
      "traces",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.cursor,
      params.model,
      params.status,
      params.featureName,
      params.provider,
      params.userId,
      params.environment,
      params.q,
      params.promptVersion,
      params.customerId,
      params.workflow,
      params.agent,
      params.step,
    ],
    queryFn: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No session");

      const api = createApiClient(token);
      const { data, error, response } = await api.GET("/api/v1/traces", {
        params: {
          query: {
            org_id: params.orgId,
            from: params.from.toISOString(),
            to: params.to.toISOString(),
            cursor: params.cursor,
            limit: params.limit ?? 50,
            model: params.model,
            status: params.status,
            feature_name: params.featureName,
            provider: params.provider,
            user_id: params.userId,
            environment: params.environment,
            q: params.q,
            prompt_version: params.promptVersion,
            customer_id: params.customerId,
            workflow: params.workflow,
            agent: params.agent,
            step: params.step,
          },
        },
      });

      if (response.status === 429) throw Object.assign(new Error("Rate limited"), { status: 429 });
      if (response.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (error) throw new Error(JSON.stringify(error));
      return data!;
    },
    staleTime: 30_000,   // 30s — half of Go's 60s Redis TTL
    enabled,
    retry: 1,
    refetchInterval: params.refetchIntervalMs ?? false,
    // Always refetch on each interval, even if data appears fresh — that's
    // the whole point of live-tail mode.
    refetchIntervalInBackground: false,
  });
}
