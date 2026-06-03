import createClient from "openapi-fetch";
import type { paths } from "@/lib/api-types";

/**
 * Creates a typed openapi-fetch client pre-configured with the correct base URL
 * and auth headers for the active auth provider.
 *
 * Auth.js mode (self-hosted):
 *   - Base URL: "/api/proxy" (relative — same Next.js app)
 *   - No Authorization header: the proxy injects x-internal-key + x-user-* server-side
 *   - accessToken arg is ignored (pass null or the sentinel "authjs")
 *
 * Supabase mode (cloud):
 *   - Base URL: NEXT_PUBLIC_API_URL (baked at build time — known for cloud deployments)
 *   - Authorization: Bearer <supabase-jwt>
 *
 * Call this inside each queryFn after resolving the current session.
 * Never cache the client at module scope — tokens can refresh mid-session.
 */
export function createApiClient(accessToken: string | null) {
  const isAuthJs = process.env.NEXT_PUBLIC_AUTH_PROVIDER === "authjs";

  const baseUrl = isAuthJs
    ? "/api/proxy"  // server-side proxy; no build-time URL baking required
    : (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3004");

  const headers: Record<string, string> = {};
  if (!isAuthJs && accessToken && accessToken !== "authjs") {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return createClient<paths>({ baseUrl, headers });
}
