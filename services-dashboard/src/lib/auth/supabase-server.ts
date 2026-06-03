/**
 * Supabase server-side utilities.
 *
 * ⚠️  Like supabase.ts, this is the only other file allowed to import @supabase/*.
 *    Used exclusively by:
 *      - src/middleware.ts  (session refresh)
 *      - src/app/auth/callback/route.ts  (PKCE code exchange)
 *
 * NOT imported by any client component or query hook — use @/lib/auth there.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import type { AuthUser } from "./types";
import { supabaseToAuthUser } from "./types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Server client for Route Handlers (e.g. auth/callback PKCE exchange).
 * Reads and writes the session cookie via `next/headers`.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component where cookies are read-only.
          // Middleware handles session refresh — safe to ignore here.
        }
      },
    },
  });
}

/**
 * Refreshes the Supabase session in Next.js middleware.
 *
 * Creates a server client wired to `req` cookies, calls `getUser()` to
 * trigger a silent token refresh if the access token is near-expiry, and
 * returns both the authenticated user and a NextResponse with updated cookies.
 *
 * Callers must use the returned `response` (not a freshly-created
 * `NextResponse.next()`) so the refreshed session cookie is forwarded.
 */
export async function refreshMiddlewareSession(req: NextRequest): Promise<{
  user: AuthUser | null;
  response: NextResponse;
}> {
  // `response` is mutated inside the setAll callback below when Supabase
  // needs to write an updated session cookie back to the browser.
  let response = NextResponse.next({ request: { headers: req.headers } });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // First write the updated values into req so the current handler sees them.
        cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
        // Re-create the response so we can set response cookies on the new instance.
        response = NextResponse.next({ request: { headers: req.headers } });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(
            name,
            value,
            options as Parameters<typeof response.cookies.set>[2]
          )
        );
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();
  return { user: supabaseToAuthUser(user), response };
}
