/**
 * API proxy.
 *
 * Forwards dashboard API calls to the Go API (INTERNAL_API_URL) server-side,
 * injecting auth headers from the Auth.js session.
 *
 * Why a proxy and not NEXT_PUBLIC_API_URL?
 *   NEXT_PUBLIC_ vars are baked into the JS bundle at `next build` time.
 *   Self-hosted users don't know their server's IP/domain at image build time,
 *   so we can't bake the API URL. This proxy reads INTERNAL_API_URL at
 *   request time (server-side) — zero rebuild required when the URL changes.
 *
 * Auth: extracts the Auth.js JWT from the request cookies via getToken(),
 *   then injects x-internal-key + x-user-* headers for the Go API to trust.
 *
 * Usage (client-side API calls):
 *   baseUrl: "/api/proxy"   (instead of process.env.NEXT_PUBLIC_API_URL)
 *
 * Supported methods: GET POST PUT PATCH DELETE
 */

import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

type RouteContext = { params: { path: string[] } };

// Client-controlled headers we MUST strip before forwarding upstream. The Go
// API trusts these headers when paired with x-internal-key, so letting a
// client-supplied x-org-id reach the upstream would be a cross-tenant read
// vulnerability (CVE-class). Any new x-user-* or x-internal-* header on the
// Go side must be added here too.
const SENSITIVE_CLIENT_HEADERS = new Set([
  "x-internal-key",
  "x-user-id",
  "x-user-email",
  "x-org-id",
  "x-user-role",
  // Bearer tokens are an alternative auth path for the Go API. The proxy uses
  // the cookie+internal-key path instead, so a forwarded Authorization could
  // confuse the upstream (or worse, let a client try to forge identity).
  "authorization",
]);

// Hop-by-hop headers we drop from the forwarded request.
const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
]);

async function proxyRequest(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  if (!INTERNAL_API_URL) {
    return NextResponse.json(
      { error: "INTERNAL_API_URL is not configured" },
      { status: 503 }
    );
  }
  // Fail loudly when the internal key is missing. Previously the proxy
  // would forward requests without x-internal-key — the upstream rejected
  // every request with 401, which made the misconfiguration look like an
  // auth bug. 503 with explicit message points operators straight at the
  // missing env var. (Q3 from review.)
  if (!INTERNAL_API_KEY) {
    return NextResponse.json(
      { error: "INTERNAL_API_KEY is not configured — set it in the dashboard env" },
      { status: 503 }
    );
  }

  // Read Auth.js session token from the request cookie (server-side). The
  // token has been cryptographically verified at this point — values we read
  // from it are trusted; values from the request headers are NOT.
  //
  // Secret resolution: AUTH_SECRET preferred, NEXTAUTH_SECRET as back-compat
  // fallback — matches services-dashboard/src/auth.ts so the proxy and the
  // signin flow can never disagree on which env var is authoritative.
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
  });

  // Require a verified session before forwarding anything. Without this, an
  // attacker could hit /api/proxy/api/v1/overview?org_id=<victim> with
  // x-org-id headers and the upstream would honor them — see the security
  // review (v0.5 → blocker #1). Always reject early on no token.
  if (!token) {
    return NextResponse.json(
      { type: "about:blank", title: "Unauthorized", status: 401, detail: "missing or invalid session" },
      { status: 401 }
    );
  }

  // Build upstream URL: preserve path + query string
  const targetPath = ctx.params.path.join("/");
  const search = req.nextUrl.search;
  const upstream = `${INTERNAL_API_URL}/${targetPath}${search}`;

  // Forward headers — but strip hop-by-hop AND any header the upstream uses
  // for identity. We re-set identity headers below from the verified token.
  const forwardHeaders = new Headers();
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (SENSITIVE_CLIENT_HEADERS.has(lower)) continue;
    forwardHeaders.set(key, value);
  }

  // Internal auth — trusted by Go API via x-internal-key. ONLY set after
  // verifying the session above — never attach this to anonymous requests.
  if (INTERNAL_API_KEY) {
    forwardHeaders.set("x-internal-key", INTERNAL_API_KEY);
  }

  // User identity — sourced exclusively from the verified JWT.
  forwardHeaders.set("x-user-id", String(token.id ?? ""));
  forwardHeaders.set("x-user-email", String(token.email ?? ""));
  forwardHeaders.set("x-org-id", String(token.orgId ?? ""));
  forwardHeaders.set("x-user-role", String(token.role ?? "viewer"));

  // Body: only for methods that carry a body
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const body = hasBody ? req.body : null;

  const response = await fetch(upstream, {
    method: req.method,
    headers: forwardHeaders,
    body,
    // Required for streaming request bodies in Node.js fetch
    // @ts-expect-error — duplex is a valid Node.js extension not yet in TS lib
    duplex: "half",
  });

  // Stream the response back to the client
  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const GET    = (req: NextRequest, ctx: RouteContext) => proxyRequest(req, ctx);
export const POST   = (req: NextRequest, ctx: RouteContext) => proxyRequest(req, ctx);
export const PUT    = (req: NextRequest, ctx: RouteContext) => proxyRequest(req, ctx);
export const PATCH  = (req: NextRequest, ctx: RouteContext) => proxyRequest(req, ctx);
export const DELETE = (req: NextRequest, ctx: RouteContext) => proxyRequest(req, ctx);
