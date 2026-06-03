"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { auth } from "@/lib/auth";

// Hand-typed — /api/v1/orgs/{org_id}/keys isn't in the OpenAPI spec yet.
// Same precedent as use-sdk-health / use-alerts / use-graph; promote later
// when the surface stabilises and we run the OpenAPI regen workflow.

/** Scope vocabulary. Kept in sync with the Go middleware allowlist
 *  (services-go/api/internal/handler/api_keys.go) and the Rust ingest
 *  scope check (services-rust/ingest/src/auth.rs). */
export type APIKeyScope = "ingest:write" | "traces:read";

export interface APIKeyView {
  id: string;
  name: string | null;
  key_prefix: string | null;
  /** Empty array = legacy key (NULL scopes in PG) — treated as
   *  fully-privileged. Non-empty arrays are exact-match enforced. */
  scopes: APIKeyScope[];
  revoked: boolean;
  created_at: string;
  last_used_at: string | null;
  /** ISO timestamp the key was revoked. NULL on active keys and on
   *  legacy revoked rows that predate the column. The dashboard uses
   *  this to drive the "auto-delete in Nd" countdown on the Revoked
   *  tab — legacy rows with NULL revoked_at never auto-delete. */
  revoked_at: string | null;
}

export interface CreateKeyResponse {
  key: APIKeyView;
  /** Raw token, shown EXACTLY ONCE in the success modal. After this, the
   *  server only has a SHA-256 hash and the prefix — there's no way to
   *  recover the raw token. */
  raw_token: string;
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

const keyTag = (orgId: string) => ["api-keys", orgId] as const;

export function useAPIKeys(orgId: string, enabled = true) {
  return useQuery({
    queryKey: keyTag(orgId),
    queryFn: async (): Promise<APIKeyView[]> => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/orgs/${orgId}/keys`, { headers });
      if (!res.ok) throw new Error(`list keys: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { keys: APIKeyView[] };
      return body.keys ?? [];
    },
    enabled: enabled && !!orgId,
    // No aggressive refresh: keys change on user action only. Manual refetch
    // happens via the mutation hooks below.
    staleTime: 60_000,
  });
}

export interface CreateAPIKeyInput {
  name: string;
  /** Defaults server-side to ['ingest:write'] when omitted/empty. */
  scopes?: APIKeyScope[];
}

export function useCreateAPIKey(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAPIKeyInput): Promise<CreateKeyResponse> => {
      const headers = { ...(await authHeaders()), "Content-Type": "application/json" };
      const res = await fetch(`${apiBase()}/api/v1/orgs/${orgId}/keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: input.name,
          // Only send the scopes field when the caller explicitly set it.
          // Omitting it lets the server apply its default (ingest:write).
          ...(input.scopes && input.scopes.length > 0 ? { scopes: input.scopes } : {}),
        }),
      });
      if (!res.ok) throw new Error(`create key: ${res.status} ${await res.text()}`);
      return res.json();
    },
    onSuccess: () => {
      // The new key is appended to the list — invalidate so it appears.
      qc.invalidateQueries({ queryKey: keyTag(orgId) });
    },
  });
}

export function useRevokeAPIKey(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (keyId: string): Promise<void> => {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase()}/api/v1/orgs/${orgId}/keys/${keyId}`, {
        method: "DELETE",
        headers,
      });
      // 204 No Content is the success signal; anything else is an error.
      if (res.status !== 204) throw new Error(`revoke key: ${res.status} ${await res.text()}`);
    },
    onSuccess: () => {
      // Optimistic UX would also work, but list invalidation is simpler and
      // keys-revoke is an extremely low-volume action.
      qc.invalidateQueries({ queryKey: keyTag(orgId) });
    },
  });
}
