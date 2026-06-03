"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState, useEffect } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopHeader } from "@/components/layout/top-header";
import { CommandPalette } from "@/components/layout/command-palette";
import { CompareTray } from "@/components/traces/compare-tray";
import { Toaster } from "@/components/ui/sonner";
import { auth } from "@/lib/auth";
import { OrgIdContext } from "@/lib/org-context";
import { CompareSetProvider } from "@/hooks/use-compare-set";

export function DashboardProviders({ children }: { children: React.ReactNode }) {
  // auth.getUser() fires once here. Pages read orgId via useOrgId() — no
  // per-page useEffect duplication. the org switcher updates this state.
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
      <CompareSetProvider>
        <div className="flex flex-col h-screen overflow-hidden">
          {/* Top header spans full width (Supabase layout — header above rail+main) */}
          <TopHeader orgId={orgId} />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-y-auto">
              {/* pb-20 on mobile leaves room above the fixed bottom nav */}
              <div className="p-4 md:p-6 pb-20 md:pb-6 max-w-7xl mx-auto">{children}</div>
            </main>
          </div>
        </div>
        <CommandPalette orgId={orgId} />
        <CompareTray />
        <Toaster />
        <ReactQueryDevtools initialIsOpen={false} />
      </CompareSetProvider>
      </OrgIdContext.Provider>
    </QueryClientProvider>
  );
}
