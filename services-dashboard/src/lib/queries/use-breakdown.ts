"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

export type BreakdownDimension =
  | "model"
  | "provider"
  | "feature"
  | "user"
  | "environment";

interface BreakdownParams {
  orgId: string;
  from: Date;
  to: Date;
  groupBy: BreakdownDimension;
  secondaryGroupBy?: BreakdownDimension;
  limit?: number;
}

export function useBreakdown(params: BreakdownParams, enabled = true) {
  return useQuery({
    queryKey: [
      "breakdown",
      params.orgId,
      params.from.toISOString(),
      params.to.toISOString(),
      params.groupBy,
      params.secondaryGroupBy,
      params.limit,
    ],
    queryFn: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No session");

      const api = createApiClient(token);
      const { data, error, response } = await api.GET("/api/v1/breakdown", {
        params: {
          query: {
            org_id: params.orgId,
            from: params.from.toISOString(),
            to: params.to.toISOString(),
            group_by: params.groupBy,
            secondary_group_by: params.secondaryGroupBy,
            limit: params.limit,
          },
        },
      });

      if (response.status === 429) throw Object.assign(new Error("Rate limited"), { status: 429 });
      if (response.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (error) throw new Error(JSON.stringify(error));
      return data!;
    },
    staleTime: 30_000, // 30s — half of Go's 60s Redis TTL
    enabled,
    retry: 1,
  });
}
