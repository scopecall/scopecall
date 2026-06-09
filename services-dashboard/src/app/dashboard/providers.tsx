"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState, useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { auth } from "@/lib/auth";
import { OrgIdContext } from "@/lib/org-context";

/**
 * Headless data + auth providers shared by every /dashboard surface.
 *
 * Renders NO chrome on purpose: chrome (nav rail, header, global scope) is
 * supplied by the nested (app) route-group layout, so it can evolve
 * independently of data/auth wiring. orgId is resolved once here (auth.getUser
 * fires once) and exposed via OrgIdContext; chrome and pages read it through
 * useOrgId() — no per-page useEffect duplication. The org switcher, when it
 * lands, updates this state.
 */
export function DashboardDataProviders({ children }: { children: React.ReactNode }) {
  const [orgId, setOrgId] = useState<string | undefined>();

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  useEffect(() => {
    auth.getUser().then((user) => {
      if (user) setOrgId(user.orgId);
    });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <OrgIdContext.Provider value={orgId}>
        {children}
        <Toaster />
        <ReactQueryDevtools initialIsOpen={false} />
      </OrgIdContext.Provider>
    </QueryClientProvider>
  );
}
