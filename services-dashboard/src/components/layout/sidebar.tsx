"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, Building2, Coins, FileText, Home, KeyRound, List, LogOut, Share2, Users } from "lucide-react";
import { auth } from "@/lib/auth";
import { cn } from "@/lib/utils";

// Supabase-style hover-expand rail:
//   • Default 56px (icon-only).
//   • On hover, the panel widens to 224px and labels slide into view — but
//     because the panel is position:absolute over a w-14 layout slot, it
//     *overlays* the page content rather than pushing it. No content reflow.
const navItems = [
  { href: "/dashboard", label: "Overview", icon: Home },
  { href: "/dashboard/cost", label: "Cost", icon: Coins },
  // Customers — B2B "is this customer profitable?" lens. Uses the v0.3
  // customer_id attribution; relies on the SDK caller passing customer_id to
  // sdk.workflow(). The page surfaces an attribution-coverage banner when
  // the field isn't being populated.
  { href: "/dashboard/customers", label: "Customers", icon: Building2 },
  { href: "/dashboard/flow", label: "Flow Map", icon: Share2 },
  { href: "/dashboard/sessions", label: "Sessions", icon: Users },
  // Prompts page surfaces KPI deltas across prompt versions — placed
  // adjacent to Traces because the typical workflow is Prompts → drill-in
  // to filtered Traces.
  { href: "/dashboard/prompts", label: "Prompts", icon: FileText },
  { href: "/dashboard/traces", label: "Traces", icon: List },
  { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
  // Settings entry — separated from analytics items by intent. Right now the
  // only settings page is API Keys; once Settings grows, /dashboard/settings
  // will become an index that catalogues its sub-pages.
  { href: "/dashboard/settings/keys", label: "API Keys", icon: KeyRound },
];

export function Sidebar() {
  const pathname = usePathname();

  function isActive(href: string) {
    return pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
  }

  return (
    <>
      {/* ── Desktop hover-expand rail ────────────────────────────────────── */}
      <aside className="hidden md:block w-14 shrink-0 relative z-40">
        <div
          className={cn(
            "group/rail absolute inset-y-0 left-0 w-14 hover:w-56",
            "bg-sidebar border-r border-border overflow-hidden",
            "transition-[width] duration-150 ease-out",
            "flex flex-col",
          )}
        >
          <nav className="flex-1 py-2 flex flex-col gap-0.5">
            {navItems.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-label={label}
                className={cn(
                  "flex items-center h-10 mx-2 rounded-md transition-colors",
                  isActive(href)
                    // Supabase-style active: neutral elevated bg, no colour cast,
                    // no left strip. Brand colour is reserved for CTAs.
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
              >
                {/* Icon square — fixed 40×40, centers icon in the collapsed rail */}
                <span className="size-10 flex items-center justify-center shrink-0">
                  <Icon className="h-4 w-4" />
                </span>
                {/* Label — hidden by opacity when the rail is collapsed; the
                    panel's overflow-hidden alone leaves an 8px sliver that
                    would show the first character peeking past each icon. */}
                <span className="text-sm whitespace-nowrap pr-3 opacity-0 group-hover/rail:opacity-100 transition-opacity duration-150">
                  {label}
                </span>
              </Link>
            ))}
          </nav>
        </div>
      </aside>

      {/* ── Mobile bottom nav (<md) — unchanged ──────────────────────────── */}
      <MobileBottomNav navItems={navItems} isActive={isActive} />
    </>
  );
}

function MobileBottomNav({
  navItems,
  isActive,
}: {
  navItems: { href: string; label: string; icon: React.ComponentType<{ className?: string }> }[];
  isActive: (href: string) => boolean;
}) {
  const router = useRouter();
  async function signOut() {
    await auth.signOut();
    router.push("/auth/login");
    router.refresh();
  }
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-center border-t border-border bg-background">
      {navItems.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={cn(
            "flex flex-1 flex-col items-center gap-1 py-3 text-[10px] font-medium transition-colors",
            isActive(href) ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Icon className={cn("h-5 w-5", isActive(href) && "stroke-[2.5]")} />
          {label}
        </Link>
      ))}
      <button
        className="flex flex-1 flex-col items-center gap-1 py-3 text-[10px] font-medium text-muted-foreground"
        onClick={signOut}
      >
        <LogOut className="h-5 w-5" />
        Sign out
      </button>
    </nav>
  );
}
