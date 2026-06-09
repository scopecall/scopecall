// Server Component — allows `dynamic` segment config to be respected.
// Client-side wiring (QueryClient, org/auth resolution) lives in
// DashboardDataProviders. Chrome (nav rail, header, global scope) is supplied
// by the nested ./(app)/layout.tsx route-group layout.

// Authenticated pages are always dynamic — they depend on session cookies and
// live data from the API. Forcing dynamic prevents Next.js from trying to
// statically pre-render them at build time (which would fail without real env vars).
export const dynamic = "force-dynamic";

import { DashboardDataProviders } from "./providers";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardDataProviders>{children}</DashboardDataProviders>;
}
