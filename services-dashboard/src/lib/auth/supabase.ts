/**
 * Supabase browser implementation of AuthProvider.
 *
 * ⚠️  This is the ONE file in the dashboard allowed to import @supabase/*.
 *    All other callsites import from @/lib/auth.
 *    ESLint no-restricted-imports enforces this in CI.
 *
 * Server-side Supabase utilities (middleware session refresh, route-handler
 * code exchange) live in supabase-server.ts — same exemption applies.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { AuthProvider } from "./types";
import { supabaseToAuthUser } from "./types";

/**
 * Create a fresh browser client per call.
 * We avoid a module-level singleton because Next.js server-renders client
 * components and a singleton would be shared across concurrent SSR requests.
 */
function client() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser AuthProvider — exported as `auth` via index.ts
// ─────────────────────────────────────────────────────────────────────────────

export const supabaseAuth: AuthProvider = {
  async getAccessToken() {
    const { data: { session } } = await client().auth.getSession();
    return session?.access_token ?? null;
  },

  async getUser() {
    // getUser() makes a network call to Supabase to validate the token —
    // safer than getSession() which reads from storage without validation.
    const { data: { user } } = await client().auth.getUser();
    return supabaseToAuthUser(user);
  },

  async signIn({ email, password }) {
    const { error } = await client().auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  },

  async signInWithOtp(email, redirectTo) {
    const { error } = await client().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) throw new Error(error.message);
  },

  async signOut() {
    const { error } = await client().auth.signOut();
    if (error) throw new Error(error.message);
  },

  onAuthStateChange(cb) {
    const { data: { subscription } } = client().auth.onAuthStateChange(
      (event, session) => cb(event, supabaseToAuthUser(session?.user ?? null))
    );
    return { unsubscribe: () => subscription.unsubscribe() };
  },
};
