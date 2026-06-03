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

// Top header strip — sits above sidebar+main, full width.
// Left:  ScopeCall horizontal logo (mark + wordmark), theme-aware swap.
// Right: ⌘K hint, profile menu (with theme switcher + sign out).
//
// The `orgId` prop is intentionally accepted (and currently unused). It used
// to drive a breadcrumb chip + DEV/STAGING/PROD env pill in the header; both
// were removed in favour of a cleaner brand-only left rail. We keep the prop
// so call sites don't need to change and so a future "switch org" menu can
// land here without touching the caller in dashboard/providers.tsx.
export function TopHeader({ orgId: _orgId }: { orgId?: string }) {
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    auth.getUser().then((u) => setUserEmail(u?.email ?? null));
  }, []);

  return (
    <header className="h-12 flex items-center px-3 border-b border-border bg-background shrink-0">
      {/* Horizontal logo — mark + wordmark in one SVG. Two files in public/
          so the CSS-only swap below works without JS hydration delay:
            - scopecall-horizontal-dark.svg → black wordmark, used in light theme
            - scopecall-horizontal.svg      → white wordmark, used in dark theme
          Sized at h-8 (32px) inside the h-12 (48px) header. The SVGs have a
          800×240 viewBox (~3.33:1 aspect) so this renders at ~107×32. */}
      <img
        src="/scopecall-horizontal-dark.svg"
        alt="ScopeCall"
        className="h-8 w-auto block dark:hidden"
      />
      <img
        src="/scopecall-horizontal.svg"
        alt="ScopeCall"
        className="h-8 w-auto hidden dark:block"
      />

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
