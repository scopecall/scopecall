/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for Docker multi-stage build: copies only the minimal runtime
  // files into the final image. The Dockerfile copies .next/standalone + static.
  output: "standalone",

  // ── Cutover redirects ──────────────────────────────────────────────────
  // The redesigned dashboard (formerly /dashboard/v2/*) is now THE dashboard,
  // served at canonical /dashboard/* URLs from the (app) route group. The old
  // "classic" surface has been retired. These redirects keep every retired URL
  // — bookmarks, Slack alert links, the dev-era /v2 paths — landing on the
  // surface that absorbed it instead of 404ing. 307 (temporary) is used on
  // purpose: the dashboard is authed (not indexed), so there's no SEO equity to
  // preserve, and a temporary redirect avoids poisoning browser caches if the
  // IA shifts again. The original query string is forwarded automatically.
  async redirects() {
    return [
      // Cost / Customers / Prompts collapsed into Spend (tabbed lenses).
      { source: "/dashboard/cost", destination: "/dashboard/spend", permanent: false },
      { source: "/dashboard/customers", destination: "/dashboard/spend?view=customers", permanent: false },
      { source: "/dashboard/prompts", destination: "/dashboard/spend?view=prompts", permanent: false },
      // Flow / Sessions / Compare collapsed into Traces.
      { source: "/dashboard/flow", destination: "/dashboard/traces", permanent: false },
      { source: "/dashboard/sessions", destination: "/dashboard/traces", permanent: false },
      { source: "/dashboard/compare", destination: "/dashboard/traces", permanent: false },
      // API keys moved under the unified Settings surface.
      { source: "/dashboard/settings/keys", destination: "/dashboard/settings", permanent: false },
      // Classic full-page trace view → in-context drawer (opened via ?trace=).
      {
        source: "/dashboard/traces/:trace_id",
        destination: "/dashboard/traces?trace=:trace_id",
        permanent: false,
      },
      // Dev-era /v2/* prefix → canonical URLs (covers /dashboard/v2 itself too).
      { source: "/dashboard/v2", destination: "/dashboard", permanent: false },
      { source: "/dashboard/v2/:path*", destination: "/dashboard/:path*", permanent: false },
    ];
  },
};

export default nextConfig;
