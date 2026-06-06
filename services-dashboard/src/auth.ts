/**
 * Next-auth v4 configuration — self-hosted Auth.js implementation.
 *
 * Providers:
 *   credentials — email + password; hashed with bcrypt (cost 12) in `users` table.
 *
 * Session strategy: JWT (no DB sessions table required).
 *
 * JWT payload extensions (via callbacks):
 *   token.id     — user.id (TEXT PK from users table)
 *   token.orgId  — user.org_id
 *   token.role   — user.role ("owner" | "admin" | "viewer")
 *
 * Scope: Credentials provider only.
 *   Magic link (Email provider) deferred to v0.2 — requires SMTP configuration.
 */

import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

// ── Postgres pool ─────────────────────────────────────────────────────────────
// Lazily initialised — avoids crashing the import when DATABASE_URL is absent
// (e.g., during `next build` in CI where we don't have a running DB).
let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("[auth] DATABASE_URL is required for Auth.js (authjs mode)");
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return _pool;
}

// ── NextAuth config ───────────────────────────────────────────────────────────

// Auth secret consolidation: we name the env var AUTH_SECRET everywhere
// (proxy, middleware, this file). next-auth's default fallback to
// NEXTAUTH_SECRET still works for back-compat. Setting it explicitly here
// prevents the two-name footgun where an operator sets AUTH_SECRET only,
// gets a working proxy (which reads AUTH_SECRET directly), and a broken
// signin flow (because next-auth was reading NEXTAUTH_SECRET via env auto-
// detection). One name, one read site, one source of truth.
function resolveAuthSecret(): string | undefined {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
}

// Fail loudly in production if no secret is configured. Without this, signed
// JWTs use a default which makes them trivially forgeable across deploys.
//
// NEXT_PHASE guard: Next.js evaluates this module at `next build` time to
// collect route metadata. AUTH_SECRET is correctly absent during the build
// (env vars are runtime-only inside the Docker image). Throwing at module
// load would block every `next build` invocation. Skip the check during
// build phases; it still fires at the first runtime import, which is what
// we actually want.
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build" &&
  !resolveAuthSecret()
) {
  throw new Error(
    "[auth] AUTH_SECRET (or NEXTAUTH_SECRET) is required in production. " +
    "Generate one with: openssl rand -hex 32"
  );
}

export const authOptions: NextAuthOptions = {
  secret: resolveAuthSecret(),
  session: { strategy: "jwt" },

  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email", placeholder: "you@example.com" },
        password: { label: "Password", type: "password" },
      },

      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const pool = getPool();
        const { rows } = await pool.query<{
          id: string;
          email: string;
          password_hash: string;
          org_id: string;
          role: string;
        }>(
          "SELECT id, email, password_hash, org_id, role FROM users WHERE email = $1 LIMIT 1",
          [credentials.email.toLowerCase().trim()]
        );

        const user = rows[0];
        if (!user) return null;

        const valid = await bcrypt.compare(credentials.password, user.password_hash);
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          // These are non-standard fields — surfaced via the jwt/session callbacks
          orgId: user.org_id,
          role: user.role,
        };
      },
    }),
  ],

  callbacks: {
    // Embed custom claims into the JWT on sign-in
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        // Cast through unknown: next-auth doesn't type custom authorize() return fields
        token.orgId = ((user as unknown) as Record<string, unknown>).orgId as string;
        token.role = ((user as unknown) as Record<string, unknown>).role as string;
      }
      return token;
    },

    // Expose custom claims on the client-visible session object
    session({ session, token }) {
      if (session.user) {
        // Cast through unknown: next-auth session.user doesn't include custom fields
        const u = (session.user as unknown) as Record<string, unknown>;
        u.id = token.id;
        u.orgId = token.orgId;
        u.role = token.role;
      }
      return session;
    },
  },

  pages: {
    signIn: "/auth/login",
    error: "/auth/login",
  },
};
