/**
 * AuthProvider — the interface every auth implementation must satisfy.
 *
 * Supabase implementation (src/lib/auth/supabase.ts).
 * Auth.js implementation (src/lib/auth/authjs.ts) drops in behind
 *          the same interface for self-hosted deployments.
 *
 * Callsites import `auth` from @/lib/auth — never from @supabase/* directly.
 * ESLint no-restricted-imports enforces this boundary at CI time.
 */

export interface AuthUser {
  id: string;
  email: string;
  /** Extracted from JWT app_metadata.org_id. Falls back to user.id in dev. */
  orgId: string;
  /** "owner" | "admin" | "viewer" — from app_metadata.role. */
  role: string;
}

// ─── Internal helper (used by supabase.ts + supabase-server.ts) ──────────────
// Kept here so neither file duplicates it. Not part of the public interface.
export type RawSupabaseUser = {
  id: string;
  email?: string;
  app_metadata?: Record<string, unknown>;
};

export function supabaseToAuthUser(user: RawSupabaseUser | null): AuthUser | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? "",
    orgId: (user.app_metadata?.org_id as string | undefined) ?? user.id,
    role: (user.app_metadata?.role as string | undefined) ?? "viewer",
  };
}
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthProvider {
  /** Bearer token for Go API requests. Null when not signed in. */
  getAccessToken(): Promise<string | null>;

  /** Current user. Null when not signed in. */
  getUser(): Promise<AuthUser | null>;

  /** Sign in with email + password. Throws on failure. */
  signIn(credentials: { email: string; password: string }): Promise<void>;

  /**
   * Send a magic link / OTP to `email`.
   * `redirectTo` is the absolute URL Supabase will redirect to after the user
   * clicks the link (typically `${window.location.origin}/auth/callback`).
   */
  signInWithOtp(email: string, redirectTo: string): Promise<void>;

  /** Sign out the current user. */
  signOut(): Promise<void>;

  /**
   * Subscribe to auth state changes (sign-in, sign-out, token refresh).
   * Returns an object with an `unsubscribe()` method — call it in cleanup.
   */
  onAuthStateChange(
    cb: (event: string, user: AuthUser | null) => void
  ): { unsubscribe(): void };
}
