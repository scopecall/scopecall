"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

interface MetricsParams {
  orgId: string;
  from: Date;
  to: Date;
  granularity?: "hour" | "day";
}

function makeMetricsQuery(
  endpoint: "/api/v1/metrics/cost" | "/api/v1/metrics/latency" | "/api/v1/metrics/errors",
  key: string
) {
  return function useMetrics(params: MetricsParams, enabled = true) {
    return useQuery({
      queryKey: [key, params.orgId, params.from.toISOString(), params.to.toISOString(), params.granularity],
      queryFn: async () => {
        const token = await auth.getAccessToken();
        if (!token) throw new Error("No session");

        const api = createApiClient(token);
        const { data, error, response } = await api.GET(endpoint, {
          params: {
            query: {
              org_id: params.orgId,
              from: params.from.toISOString(),
              to: params.to.toISOString(),
              granularity: params.granularity ?? "hour",
            },
          },
        });

        if (response.status === 429) throw Object.assign(new Error("Rate limited"), { status: 429 });
        if (response.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
        if (error) throw new Error(JSON.stringify(error));
        return data!;
      },
      staleTime: 60_000,   // 60s — half of Go's 2min Redis TTL
      enabled,
      retry: 1,
    });
  };
}

export const useCostMetrics = makeMetricsQuery("/api/v1/metrics/cost", "metrics-cost");
export const useLatencyMetrics = makeMetricsQuery("/api/v1/metrics/latency", "metrics-latency");
export const useErrorMetrics = makeMetricsQuery("/api/v1/metrics/errors", "metrics-errors");
