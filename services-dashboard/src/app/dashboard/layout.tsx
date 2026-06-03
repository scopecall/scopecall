// Server Component — allows `dynamic` segment config to be respected.
// Client-side wiring (QueryClient, Sidebar, Toaster) lives in DashboardProviders.

// Authenticated pages are always dynamic — they depend on session cookies and
// live data from the API. Forcing dynamic prevents Next.js from trying to
// statically pre-render them at build time (which would fail without real env vars).
export const dynamic = "force-dynamic";

import { DashboardProviders } from "./providers";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardProviders>{children}</DashboardProviders>;
}
