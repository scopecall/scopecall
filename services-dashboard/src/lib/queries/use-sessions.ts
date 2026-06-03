"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

interface SessionsParams {
  orgId: string;
  from: Date;
  to: Date;
  userId?: string;
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
