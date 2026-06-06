"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { auth } from "@/lib/auth";
import { useOrgId } from "@/lib/org-context";

// Hand-typed — /api/v1/views isn't in the OpenAPI spec yet.

export interface SavedView {
  id: string;
  org_id: string;
  created_by?: string;
  name: string;
  path: string;
  query_string: string;
  icon?: string;
  created_at: string;
}

function apiBase(): string {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "authjs") return "/api/proxy";
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3004";
}

async function authHeaders(): Promise<Record<string, string>> {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "authjs") return {};
  const token = await auth.getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useSavedViews(enabled = true) {
  // Include orgId in the cache key so an org switcher (when it lands)
  // doesn't serve the previous org's views to the next org's user. Today
  // there's no switcher, but the cache is process-lived — better to fix
  // before the switcher exposes the leak.
  const orgId = useOrgId();
  return useQuery({
    queryKey: ["saved-views", orgId],
    queryFn: async (): Promise<SavedView[]> => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/views`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`list views: ${res.status}`);
      const body = await res.json();
      return body.views ?? [];
    },
    enabled,
    // 5min — views change infrequently and the menu opens often; trade a bit
    // of staleness for fewer roundtrips.
    staleTime: 5 * 60_000,
  });
}

interface CreateInput {
  name: string;
  path: string;
  query_string?: string;
  icon?: string;
}

export function useCreateSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInput): Promise<SavedView> => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/views`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        // Hoist the error detail so the UI can show "name already exists" etc.
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `create view: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-views"] }),
  });
}

export function useDeleteSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/views/${id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error(`delete view: ${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-views"] }),
  });
}
