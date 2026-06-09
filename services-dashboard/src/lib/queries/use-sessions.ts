"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

interface SessionsParams {
  orgId: string;
  from: Date;
  to: Date;
  userId?: string;
  /** Cross-cutting facets — a session matches if ≥1 of its calls matches, but
   *  its totals stay full-session ("match → whole session"). Mirrors /traces. */
  model?: string;
  provider?: string;
  status?: "success" | "error" | "timeout" | "rate_limited";
  /** Pass "__null__" to match sessions with an untagged call. */
  featureName?: string;
  environment?: string;
  limit?: number;
}

export function useSessions(params: SessionsParams, enabled = true) {
  return useQuery({
    queryKey: [
      "sessions",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.userId,
      params.model,
      params.provider,
      params.status,
      params.featureName,
      params.environment,
      params.limit,
    ],
    queryFn: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No session");
      const api = createApiClient(token);
      const { data, error, response } = await api.GET("/api/v1/sessions", {
        params: {
          query: {
            org_id: params.orgId,
            from: params.from.toISOString(),
            to: params.to.toISOString(),
            user_id: params.userId,
            model: params.model,
            provider: params.provider,
            status: params.status,
            feature_name: params.featureName,
            environment: params.environment,
            limit: params.limit,
          },
        },
      });
      if (response.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (error) throw new Error(JSON.stringify(error));
      return data!;
    },
    staleTime: 30_000,
    enabled,
    retry: 1,
  });
}
