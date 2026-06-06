"use client";

import { useQuery } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

export type WasteKind = "retry_burner" | "model_misuse" | "high_error_workflow";
export type WasteSeverity = "high" | "medium" | "low";

export interface WasteItem {
  kind: WasteKind;
  severity: WasteSeverity;
  headline: string;
  detail: string;
  recommendation: string;
  potential_savings_usd: number;
  workflow?: string;
  model?: string;
  step?: string;
}

export interface WasteInboxResponse {
  window_seconds: number;
  total_savings_usd: number;
  items: WasteItem[];
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

interface Params {
  orgId: string;
  from: Date;
  to: Date;
}

export function useWasteInbox(params: Params, enabled = true) {
  return useQuery({
    queryKey: ["waste-inbox", params.orgId, params.from.toISOString(), params.to.toISOString()],
    queryFn: async (): Promise<WasteInboxResponse> => {
      const headers = await authHeaders();
      const qs = new URLSearchParams({
        org_id: params.orgId,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
      });
      const res = await fetch(`${apiBase()}/api/v1/waste-inbox?${qs}`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`waste-inbox: ${res.status} ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && !!params.orgId,
    staleTime: 60_000,
    retry: 1,
  });
}
