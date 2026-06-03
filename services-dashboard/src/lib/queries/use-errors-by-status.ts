"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

interface ErrorsByStatusParams {
  orgId: string;
  from: Date;
  to: Date;
  granularity?: "hour" | "day";
}

export function useErrorsByStatus(params: ErrorsByStatusParams, enabled = true) {
  return useQuery({
    queryKey: ["errors-by-status", params.orgId, params.from.toISOString(), params.to.toISOString(), params.granularity ?? "hour"],
    queryFn: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No session");
      const api = createApiClient(token);
      const { data, error, response } = await api.GET("/api/v1/metrics/errors-by-status", {
        params: {
          query: {
            org_id: params.orgId,
            from: params.from.toISOString(),
            to: params.to.toISOString(),
            granularity: params.granularity ?? "hour",
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
