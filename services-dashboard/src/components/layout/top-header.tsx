"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { LogOut } from "lucide-react";
import { SavedViewsMenu } from "@/components/layout/saved-views-menu";
import { useTheme } from "next-themes";
import { auth } from "@/lib/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// Top header strip — Supabase-style. Sits above sidebar+main, full width.
// Left:  ScopeCall wordmark (logo gradient) + breadcrumb (org context).
// Right: ⌘K hint, profile menu (with theme switcher + sign out).
export function TopHeader({ orgId }: { orgId?: string }) {
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    auth.getUser().then((u) => setUserEmail(u?.email ?? null));
  }, []);

  // Compact org label: short hash of orgId, or fallback. Real org names land
  // here once the orgs table is queryable from the dashboard.
  const orgLabel = orgId ? orgId.replace(/^org_/, "").slice(0, 8) : "—";

  return (
    <header className="h-12 flex items-center px-3 border-b border-border bg-background shrink-0">
      {/* Logo mark — vector SVG at public/scopecall-mark.svg. Vector means it
          stays crisp at 1× and 2× DPR without shipping a separate retina asset.
          Sized at h-9 (36px) inside an h-12 (48px) header — leaves 6px
          breathing room top/bottom and lets the dot-grid be legible. */}
      <img
        src="/scopecall-mark.svg"
        alt="ScopeCall"
        className="h-9 w-9"
      />

      {/* Breadcrumb chevron */}
      <span className="mx-3 text-muted-foreground/40 select-none">/</span>

      {/* Org chip */}
      <BreadcrumbChip label={orgLabel} title="Organization" />

      {/* Env pill — colour-coded from NEXT_PUBLIC_ENV (defaults to DEV). */}
      <EnvPill />

      <div className="flex-1" />

      {/* Right cluster */}
      <SavedViewsMenu />
      <kbd className="hidden lg:inline-flex items-center gap-1 text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5 mx-3">
        ⌘K
      </kbd>
      <UserMenu userEmail={userEmail} />
    </header>
  );
}

function EnvPill() {
  // NEXT_PUBLIC_ envs are baked at build time. Default to DEV when unset so
  // localhost / first-run installs don't show a confusing "PROD" badge.
  const env = (process.env.NEXT_PUBLIC_ENV ?? "DEV").toUpperCase();
  // Colour intensity rises with environment criticality so PROD reads as
  // "be careful here", DEV as "safe to break things".
  // Theme-aware: -400 text vanished on the light cream surface. -700 / -300
  // dark contrasts cleanly in both themes. (Round-6 user-reported.)
  const palette: Record<string, string> = {
    PROD:    "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
    STAGING: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20",
    DEV:     "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
  };
  const cls = palette[env] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span className={cn("ml-2 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border", cls)}>
      {env}
    </span>
  );
}

function BreadcrumbChip({ label, title }: { label: string; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs text-foreground border border-border rounded font-mono"
    >
      {label}
    </span>
  );
}

function UserMenu({ userEmail }: { userEmail: string | null }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  async function signOut() {
    await auth.signOut();
    router.push("/auth/login");
    router.refresh();
  }

  const initial = userEmail?.[0]?.toUpperCase() ?? "?";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="size-8 rounded-full bg-primary/20 text-foreground flex items-center justify-center text-xs font-semibold border border-border hover:bg-primary/30 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {initial}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-64">
        {/* Identity block */}
        <div className="px-2 py-2">
          <p className="text-sm font-medium truncate">{userEmail ?? "Signed in"}</p>
          {userEmail && (
            <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
          )}
        </div>
        <DropdownMenuSeparator />

        {/* Theme switcher — radio group with persistent selection.
            Note: a plain div is used for the section heading instead of
            DropdownMenuLabel, because Base UI's MenuGroupLabel requires a
            surrounding MenuGroup context (it calls setLabelId from that
            context) and crashes the menu on open if used standalone. */}
        <div className="px-1.5 pt-1.5 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Theme
        </div>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
