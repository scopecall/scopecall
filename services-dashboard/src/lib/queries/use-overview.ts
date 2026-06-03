"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

interface OverviewParams {
  orgId: string;
  from: Date;
  to: Date;
}

export function useOverview(params: OverviewParams, enabled = true) {
  return useQuery({
    queryKey: ["overview", params.orgId, params.from.toISOString(), params.to.toISOString()],
    queryFn: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No session");

      const api = createApiClient(token);
      const { data, error, response } = await api.GET("/api/v1/overview", {
        params: {
          query: {
            org_id: params.orgId,
            from: params.from.toISOString(),
            to: params.to.toISOString(),
          },
        },
      });

      if (response.status === 429) throw Object.assign(new Error("Rate limited"), { status: 429 });
      if (response.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (error) throw new Error(JSON.stringify(error));
      return data!;
    },
    staleTime: 15_000,    // 15s — half of Go's 30s Redis TTL
    enabled,
    retry: 1,
  });
}
