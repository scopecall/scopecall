"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

interface PromptsParams {
  orgId: string;
  from: Date;
  to: Date;
  featureName?: string;
  environment?: string;
  limit?: number;
}

/**
 * Fetches the Prompts page's per-version aggregate table. Server-side this is
 * GET /api/v1/prompts, hand-wired in Go but typed via the OpenAPI spec.
 *
 * The empty-string version is the "(untagged)" bucket — calls that never had
 * promptVersion set via sdk.trace() or config.defaultPromptVersion. The page
 * renders that row last and labels it "(untagged)" so users can see what
 * fraction of traffic isn't tagged yet.
 */
export function usePrompts(params: PromptsParams, enabled = true) {
  return useQuery({
    queryKey: [
      "prompts",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.featureName,
      params.environment,
      params.limit,
    ],
    queryFn: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No session");
      const api = createApiClient(token);
      const { data, error, response } = await api.GET("/api/v1/prompts", {
        params: {
          query: {
            org_id: params.orgId,
            from: params.from.toISOString(),
            to: params.to.toISOString(),
            feature_name: params.featureName,
            environment: params.environment,
            limit: params.limit,
          },
        },
      });
      if (response.status === 429) throw Object.assign(new Error("Rate limited"), { status: 429 });
      if (response.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (error) throw new Error(JSON.stringify(error));
      return data!;
    },
    staleTime: 30_000,
    enabled,
    retry: 1,
  });
}
