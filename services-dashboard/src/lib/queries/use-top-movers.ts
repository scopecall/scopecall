"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";
import type { BreakdownDimension } from "@/lib/queries/use-breakdown";

interface TopMoversParams {
  orgId: string;
  from: Date;
  to: Date;
  groupBy: BreakdownDimension;
  limit?: number;
}

export function useTopMovers(params: TopMoversParams, enabled = true) {
  return useQuery({
    queryKey: ["top-movers", params.orgId, params.from.toISOString(), params.to.toISOString(), params.groupBy, params.limit],
    queryFn: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No session");
      const api = createApiClient(token);
      const { data, error, response } = await api.GET("/api/v1/metrics/top-movers", {
        params: {
          query: {
            org_id: params.orgId,
            from: params.from.toISOString(),
            to: params.to.toISOString(),
            group_by: params.groupBy,
            limit: params.limit,
          },
        },
      });
      if (response.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (error) throw new Error(JSON.stringify(error));
      return data!;
    },
    staleTime: 60_000,
    enabled,
    retry: 1,
  });
}
