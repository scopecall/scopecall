import { NextResponse, type NextRequest } from "next/server";
import { refreshMiddlewareSession } from "@/lib/auth/supabase-server";
import { getToken } from "next-auth/jwt";

// Module-level flag so the bypass-auth-in-prod warning fires at most once
// per *isolate* boot (not "per process" — Next.js middleware runs in the
// Edge Runtime which spawns multiple V8 isolates per server process, so
// expect 2-8x on cold-start fan-out). Still cuts log volume by ~99% under
// steady traffic, which was the point. (D-4 / D-5 from review.)
let bypassWarnedInProd = false;

export async function middleware(req: NextRequest) {
  // Dev bypass: skip all auth checks entirely.
  // Controlled by NEXT_PUBLIC_BYPASS_AUTH=true in .env.local.
  //
  // SAFETY: never honor the bypass in production builds. The client-side
  // `lib/auth/index.ts` already throws at init time when this is set in prod,
  // but middleware runs in a separate Edge runtime that doesn't share that
  // module. If somebody bakes a prod image with the env var still set, this
  // gate ensures every request still goes through real auth instead of
  // returning silently. Mirrors the security review's blocker #2.
  if (process.env.NEXT_PUBLIC_BYPASS_AUTH === "true") {
    if (process.env.NODE_ENV === "production") {
      // Log once per process boot — not per request.
      if (!bypassWarnedInProd) {
        bypassWarnedInProd = true;
        console.error(
          "[middleware] CRITICAL: NEXT_PUBLIC_BYPASS_AUTH=true detected in production build. " +
          "Ignoring bypass and enforcing auth. Remove this env var immediately."
        );
      }
      // Fall through to the real auth path below.
    } else {
      return NextResponse.next();
    }
  }

  // /setup is public — no auth required (first-run admin creation)
  if (req.nextUrl.pathname.startsWith("/setup")) {
    return NextResponse.next();
  }

  const authProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "supabase";

  if (authProvider === "authjs") {
    // Auth.js (self-hosted): verify via JWT cookie
    // AUTH_SECRET preferred, NEXTAUTH_SECRET as back-compat fallback. Matches
    // auth.ts + proxy so all three read sites use the same resolution order.
    const token = await getToken({
      req,
      secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
    });

    if (!token && req.nextUrl.pathname.startsWith("/dashboard")) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/auth/login";
      loginUrl.searchParams.set("redirect", req.nextUrl.pathname);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  // Supabase mode (default): refresh session via Supabase SSR helper
  const { user, response } = await refreshMiddlewareSession(req);

  if (!user && req.nextUrl.pathname.startsWith("/dashboard")) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/auth/login";
    loginUrl.searchParams.set("redirect", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // Match dashboard routes and setup; skip static assets + api routes
  matcher: ["/dashboard/:path*", "/setup", "/setup/:path*"],
};
