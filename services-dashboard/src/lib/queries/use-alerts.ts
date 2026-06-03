"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { auth } from "@/lib/auth";
import { useOrgId } from "@/lib/org-context";

// Lightweight types — alerts endpoints aren't in the OpenAPI spec yet, so we
// hand-type the wire format. (Adding them to the spec would mean either Go
// regen — divergent — or duplicating the schemas; not worth right now.)

export type RuleType = "cost_spike" | "error_rate" | "latency_p99";
export type ChannelType = "none" | "slack";

export interface AlertRule {
  id: string;
  name: string;
  type: RuleType;
  threshold: number;
  window_seconds: number;
  dim_filter: Record<string, string>;
  channel_type: ChannelType;
  channel_config: Record<string, string>;
  enabled: boolean;
  created_at: string;
}

export interface AlertEvent {
  id: string;
  rule_id: string;
  rule_name: string;
  fired_at: string;
  value: number;
  message: string;
  resolved_at?: string | null;
}

// Auth.js mode uses the dashboard's /api/proxy. Reach the API base via the
// same path the rest of the dashboard does so headers/sessions match.
function apiBase(): string {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "authjs") return "/api/proxy";
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3004";
}

async function authHeaders(): Promise<Record<string, string>> {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "authjs") return {};
  const token = await auth.getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function useAlertRules(enabled = true) {
  // orgId in the key prevents cross-org cache leak once an org switcher
  // exists. (D1 from sixth-pass review — same fix as saved-views.)
  const orgId = useOrgId();
  return useQuery({
    queryKey: ["alert-rules", orgId],
    queryFn: async (): Promise<AlertRule[]> => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/alerts/rules`, { headers });
      if (!res.ok) throw new Error(`list rules: ${res.status}`);
      const body = await res.json();
      return body.rules ?? [];
    },
    enabled,
    staleTime: 10_000,
  });
}

// One offending trace surfaced under an event — closes the alert→trace loop.
export interface AlertSampleTrace {
  trace_id: string;
  span_id: string;
  model: string;
  feature_name?: string;
  status: string;
  latency_ms: number;
  cost_usd: number;
  error_count: number;
  timestamp: string;
}

export interface AlertEventTracesResponse {
  traces: AlertSampleTrace[];
  window_from: string;
  window_to: string;
  window_seconds: number;
  rule_type: string;
}

export function useAlertEventTraces(eventId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["alert-event-traces", eventId],
    queryFn: async (): Promise<AlertEventTracesResponse> => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/alerts/events/${eventId}/traces`, { headers });
      if (res.status === 401) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      if (!res.ok) throw new Error(`event traces: ${res.status} ${await res.text()}`);
      return res.json();
    },
    enabled: enabled && !!eventId,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useAlertEvents(enabled = true) {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ["alert-events", orgId],
    queryFn: async (): Promise<AlertEvent[]> => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/alerts/events`, { headers });
      if (!res.ok) throw new Error(`list events: ${res.status}`);
      const body = await res.json();
      return body.events ?? [];
    },
    enabled,
    // Refetch every 30s so fresh fires appear without a manual refresh.
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useCreateAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rule: Partial<AlertRule>) => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/alerts/rules`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      });
      if (!res.ok) throw new Error(`create rule: ${res.status} ${await res.text()}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-rules"] });
    },
  });
}

export function useToggleAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/alerts/rules/${id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`toggle rule: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-rules"] });
    },
  });
}

export function useDeleteAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/alerts/rules/${id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error(`delete rule: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-rules"] });
    },
  });
}
