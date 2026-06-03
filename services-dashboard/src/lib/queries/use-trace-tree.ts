"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

interface TraceTreeParams {
  orgId: string;
  traceId: string;
  /** Optional time window hint — bounds the ClickHouse scan. Pass whatever
   *  date range the user was on when they navigated to this trace. */
  from?: Date;
  to?: Date;
}

export function useTraceTree(params: TraceTreeParams, enabled = true) {
  return useQuery({
    queryKey: ["trace-tree", params.orgId, params.traceId, params.from?.toISOString(), params.to?.toISOString()],
    queryFn: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No session");

      const api = createApiClient(token);
      const { data, error, response } = await api.GET("/api/v1/traces/tree/{trace_id}", {
        params: {
          path: { trace_id: params.traceId },
          query: {
            org_id: params.orgId,
            from: params.from?.toISOString(),
            to: params.to?.toISOString(),
          },
        },
      });

      if (response.status === 404) throw Object.assign(new Error("Trace not found"), { status: 404 });
      if (response.status === 429) throw Object.assign(new Error("Rate limited"), { status: 429 });
      if (response.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (error) throw new Error(JSON.stringify(error));
      return data!;
    },
    staleTime: 2 * 60_000, // 2min — half of Go's 5min Redis TTL
    enabled,
    retry: 1,
  });
}
