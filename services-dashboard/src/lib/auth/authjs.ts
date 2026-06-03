/**
 * Auth.js (next-auth v4) implementation of AuthProvider.
 *
 * Used when AUTH_PROVIDER=authjs (self-hosted deployments).
 * Supabase auth lives in supabase.ts and supabase-server.ts.
 *
 * Key differences from Supabase:
 *   - API calls go through Next.js proxy (/api/proxy/*) rather than directly
 *     to the Go API. The proxy handles auth server-side via getToken().
 *   - signInWithOtp() is not supported in v0.1 (no SMTP config required).
 *   - onAuthStateChange() fires once on mount; next-auth has no real-time
 *     subscription model. Use React's useSession() for reactive state instead.
 */

import {
  getSession,
  signIn as nextAuthSignIn,
  signOut as nextAuthSignOut,
} from "next-auth/react";
import type { AuthProvider, AuthUser } from "./types";

function sessionToAuthUser(session: Awaited<ReturnType<typeof getSession>>): AuthUser | null {
  if (!session?.user) return null;
  const u = session.user as Record<string, unknown>;
  return {
    id: (u.id as string | undefined) ?? "",
    email: (u.email as string | undefined) ?? "",
    orgId: (u.orgId as string | undefined) ?? "",
    role: (u.role as string | undefined) ?? "viewer",
  };
}

export const authjsAuth: AuthProvider = {
  /**
   * Returns a sentinel string "authjs" when a session exists.
   * The API proxy (app/api/proxy/[...path]/route.ts) reads the real JWT
   * server-side via getToken({ req }); callers should NOT send this as a
   * Bearer token to an external URL.
   */
  async getAccessToken() {
    const session = await getSession();
    return session ? "authjs" : null;
  },

  async getUser() {
    const session = await getSession();
    return sessionToAuthUser(session);
  },

  async signIn({ email, password }) {
    const result = await nextAuthSignIn("credentials", {
      email,
      password,
      redirect: false,
    });
    if (result?.error) {
      throw new Error(result.error === "CredentialsSignin" ? "Invalid email or password" : result.error);
    }
  },

  async signInWithOtp(_email, _redirectTo) {
    // Magic link sign-in is not available in self-hosted mode v0.1.
    // Requires SMTP/email provider configuration (deferred to v0.2).
    throw new Error(
      "Magic link sign-in is not available in self-hosted mode. Use email + password."
    );
  },

  async signOut() {
    await nextAuthSignOut({ redirect: false });
    window.location.href = "/auth/login";
  },

  onAuthStateChange(cb) {
    // next-auth has no real-time subscription; fire once with current state.
    // For reactive auth state in components, use next-auth's useSession() hook.
    getSession().then((session) => {
      const user = sessionToAuthUser(session);
      cb(user ? "SIGNED_IN" : "SIGNED_OUT", user);
    });
    return { unsubscribe: () => {} };
  },
};
