"use client";

import { useQuery } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";

/**
 * Distinct project labels for the org — feeds the header's project picker.
 * Not windowed (quiet projects stay selectable); '' (unassigned) is excluded
 * server-side. See services-go/api/internal/query/projects.go.
 */
export function useProjects(orgId: string, enabled = true) {
  return useQuery({
    queryKey: ["projects", orgId],
    queryFn: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("No session");

      const api = createApiClient(token);
      const { data, error, response } = await api.GET("/api/v1/projects", {
        params: { query: { org_id: orgId } },
      });

      if (response.status === 429) throw Object.assign(new Error("Rate limited"), { status: 429 });
      if (response.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (error) throw new Error(JSON.stringify(error));
      return data!.projects;
    },
    // Projects change when a new SDK config ships — rarely. Long staleTime
    // keeps the picker from refetching on every nav.
    staleTime: 5 * 60_000,
    enabled: enabled && !!orgId,
    retry: 1,
  });
}
