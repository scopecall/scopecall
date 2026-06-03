/**
 * Auth abstraction layer.
 *
 * Import `auth` from here for all auth operations in client components
 * and query hooks. Never import @supabase/* directly.
 *
 * Provider selection: NEXT_PUBLIC_AUTH_PROVIDER env var (baked at build time).
 *   "supabase"  → Supabase Cloud (default); requires NEXT_PUBLIC_SUPABASE_URL etc.
 *   "authjs"    → self-hosted; requires AUTH_SECRET + DATABASE_URL server-side.
 *
 * For self-hosted, the Docker image is built with
 *   NEXT_PUBLIC_AUTH_PROVIDER=authjs
 * and the Supabase cloud image with (default):
 *   NEXT_PUBLIC_AUTH_PROVIDER=supabase
 *
 * Zero callsite changes required when switching providers — import `auth` here.
 */

import { supabaseAuth } from "./supabase";
import { authjsAuth } from "./authjs";
import type { AuthProvider, AuthUser } from "./types";

// ─── Dev bypass ──────────────────────────────────────────────────────────────
// Set NEXT_PUBLIC_BYPASS_AUTH=true in .env.local to skip auth entirely.
// Returns a mock user so all dashboard screens render with skeleton loaders.
// NEVER set this in staging or production.
const MOCK_USER: AuthUser = {
  id: "dev-user-id",
  email: "dev@scopecall.ai",
  orgId: "org_dev",
  role: "owner",
};

const devBypassAuth: AuthProvider = {
  getAccessToken: async () => "dev-token",
  getUser: async () => MOCK_USER,
  signIn: async () => {},
  signInWithOtp: async () => {},
  signOut: async () => { window.location.href = "/auth/login"; },
  onAuthStateChange: (cb) => {
    cb("SIGNED_IN", MOCK_USER);
    return { unsubscribe: () => {} };
  },
};
// ─────────────────────────────────────────────────────────────────────────────

// NEXT_PUBLIC_AUTH_PROVIDER is baked at `next build` time — intentional.
// Self-hosted and cloud deployments produce separate images with different
// build args, so the value is always known at build time.
const provider: AuthProvider = (() => {
  if (process.env.NEXT_PUBLIC_BYPASS_AUTH === "true") {
    // Hard error if bypass is somehow set in production — comment alone isn't enough
    // when bypass returns a mock user with role: "owner".
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[auth] NEXT_PUBLIC_BYPASS_AUTH=true is not allowed in production. " +
        "Remove this env var from your production configuration."
      );
    }
    console.warn("[auth] ⚠️  BYPASS_AUTH is active — dev mode only, never use in production");
    return devBypassAuth;
  }
  const p = process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "supabase";
  switch (p) {
    case "authjs":
      return authjsAuth;
    case "supabase":
    default:
      if (p !== "supabase") {
        console.warn(`[auth] Unknown AUTH_PROVIDER="${p}", falling back to supabase`);
      }
      return supabaseAuth;
  }
})();

export const auth = provider;
export type { AuthProvider, AuthUser } from "./types";
