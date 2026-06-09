"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  Bell,
  Check,
  ChevronDown,
  LayoutDashboard,
  List,
  LogOut,
  Menu,
  Settings,
  Wallet,
  X,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { auth, type AuthUser } from "@/lib/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFocusTrap } from "./_lib/use-focus-trap";
import {
  RANGE_KEYS,
  RANGE_LABELS,
  globalScopeQuery,
  useTimeRange,
  useTimeRangeControls,
} from "./_lib/use-time-range";

/**
 * Dashboard chrome — the narrative shell (originally prototyped as a static mockup).
 * Four primary destinations: Cost/Customers/Workflows/Prompts collapse into
 * Spend; Flow/Sessions/Compare collapse into Traces. The global scope + time
 * pills live here and write to the URL (see _lib/use-time-range), so every page
 * + drill inherits one window instead of carrying its own picker.
 *
 * Lives in the (app) route group, which is path-transparent — so these ARE the
 * canonical dashboard URLs (/dashboard, /dashboard/spend, …). Inherits auth +
 * org isolation + the shared QueryClient/OrgIdContext from the parent
 * DashboardDataProviders. This shell replaced the retired "classic" dashboard.
 */

const primary = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/spend", label: "Spend", icon: Wallet },
  { href: "/dashboard/traces", label: "Traces", icon: List },
  { href: "/dashboard/health", label: "Health", icon: Activity },
];
const secondary = [
  { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export default function V2Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);

  // Active when the path matches exactly (Overview) or is a sub-route (others).
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  // Carry the global window/scope across nav so it doesn't reset on each click.
  const scopeQuery = globalScopeQuery(sp);

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Escape closes the drawer; lock body scroll while it's open.
  useEffect(() => {
    if (!mobileOpen) return;
    drawerRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  // Trap Tab within the open drawer; restore focus to the trigger on close.
  useFocusTrap(mobileOpen, drawerRef);

  // `collapsible` = the desktop hover-rail (labels fade in on expand). The
  // mobile drawer passes false so its labels are always visible.
  const renderNav = (collapsible: boolean) => (
    <>
      <nav className="flex-1 py-2 flex flex-col gap-0.5">
        {primary.map((item) => (
          <NavLink
            key={item.href}
            {...item}
            scopeQuery={scopeQuery}
            active={isActive(item.href)}
            collapsible={collapsible}
          />
        ))}
      </nav>
      <div className="py-2 border-t border-border flex flex-col gap-0.5">
        {secondary.map((item) => (
          <NavLink
            key={item.href}
            {...item}
            scopeQuery={scopeQuery}
            active={isActive(item.href)}
            collapsible={collapsible}
          />
        ))}
      </div>
    </>
  );

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Global header — brand + scope/time, full width above the rail. */}
      <TopBar onOpenMenu={() => setMobileOpen(true)} />

      <div className="flex flex-1 min-h-0">
        {/* ── Desktop rail — collapsed icons, expands to labels on hover ──── */}
        {/* The spacer reserves 4rem so the fixed rail can overlay content as
            it expands (to w-56) without reflowing the charts beneath it. */}
        <div className="hidden md:block w-16 shrink-0">
          <aside
            aria-label="Primary"
            className={cn(
              "group fixed left-0 top-12 bottom-0 z-30 flex w-16 flex-col",
              "border-r border-border bg-sidebar overflow-hidden",
              "transition-[width] duration-200 ease-out hover:w-56 hover:shadow-xl focus-within:w-56",
            )}
          >
            {renderNav(true)}
          </aside>
        </div>

        {/* ── Mobile drawer ─────────────────────────────────────────────── */}
        <div
          className={cn("md:hidden fixed inset-0 z-50", !mobileOpen && "pointer-events-none")}
          aria-hidden={!mobileOpen}
        >
          <div
            className={cn(
              "absolute inset-0 bg-black/50 transition-opacity duration-200",
              mobileOpen ? "opacity-100" : "opacity-0",
            )}
            onClick={() => setMobileOpen(false)}
          />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            tabIndex={-1}
            className={cn(
              "absolute left-0 top-0 h-full w-64 bg-sidebar border-r border-border flex flex-col transition-transform duration-200 ease-out outline-none",
              mobileOpen ? "translate-x-0" : "-translate-x-full",
            )}
          >
            <div className="flex items-center justify-between pr-2">
              <Brand />
              <button
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors focus-ring"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {renderNav(false)}
          </aside>
        </div>

        {/* ── Main column ───────────────────────────────────────────────── */}
        <main className="flex-1 min-w-0 p-4 md:p-6 max-w-[1400px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="h-12 flex items-center px-3.5 shrink-0">
      {/* Real brand mark — the same asset the login page uses, so the chrome and
          auth screens stay cohesive. Pure-shape SVG on a transparent ground (not
          a tile) → needs no background/rounding and reads on both themes. alt=""
          because the adjacent wordmark is the accessible label. */}
      <img src="/scopecall-mark.svg" alt="" className="size-7 shrink-0" />
      <span className="ml-2.5 text-sm font-semibold whitespace-nowrap">ScopeCall</span>
    </div>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  scopeQuery,
  collapsible,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  scopeQuery: string;
  collapsible?: boolean;
}) {
  return (
    <Link
      href={`${href}${scopeQuery}`}
      aria-current={active ? "page" : undefined}
      title={collapsible ? label : undefined}
      // Collapse the hover-rail after a click. On navigate the link keeps DOM
      // focus, so focus-within would pin the rail open until you click away.
      // Blurring drops focus so it closes as soon as the mouse leaves; keyboard
      // Tab still expands it (focus-within fires again on the next focus).
      onClick={collapsible ? (e) => e.currentTarget.blur() : undefined}
      className={cn(
        "flex items-center gap-3 h-9 mx-2 px-2.5 rounded-md text-sm transition-colors focus-ring",
        active
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} />
      <span
        className={cn(
          "truncate",
          collapsible &&
            "opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        {label}
      </span>
    </Link>
  );
}

function TopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  return (
    <header className="h-12 shrink-0 border-b border-border bg-background/80 backdrop-blur flex items-center gap-2 px-3 sticky top-0 z-40">
      <button
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="md:hidden rounded-md p-1.5 -ml-1.5 text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors focus-ring"
      >
        <Menu className="h-4 w-4" />
      </button>

      {/* Brand lives in the header so the collapsed rail is pure icons. */}
      <Brand />
      <div className="mx-1 hidden md:block h-5 w-px bg-border" />

      {/* Scope + time — global, replaces every per-page picker (URL-backed). */}
      <ScopePill />
      <TimePill />

      {/* Push the account control to the far right of the bar. */}
      <div className="flex-1" />

      {/* Identity, theme switcher, sign out. */}
      <UserMenu />
    </header>
  );
}

/**
 * Account control — avatar (signed-in user's initial) opening a menu with the
 * identity, a theme switcher, and sign out. Ported from the retired top-header
 * when the cutover replaced the old chrome; without it the dashboard had no way
 * to see who you're signed in as or to log out. Auth goes through the `auth`
 * abstraction (Supabase / Auth.js / dev-bypass — selected at build time), so
 * this is provider-agnostic.
 */
function UserMenu() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    let active = true;
    auth.getUser().then((u) => {
      if (active) setUser(u);
    });
    return () => {
      active = false;
    };
  }, []);

  async function signOut() {
    await auth.signOut();
    router.push("/auth/login");
    router.refresh();
  }

  const email = user?.email ?? null;
  const initial = email?.[0]?.toUpperCase() ?? "?";
  const role = user?.role ? user.role[0].toUpperCase() + user.role.slice(1) : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="size-7 shrink-0 rounded-full bg-primary/20 text-foreground flex items-center justify-center text-xs font-semibold border border-border hover:bg-primary/30 transition-colors focus-ring"
      >
        {initial}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-64">
        {/* Identity block. */}
        <div className="px-2 py-2">
          <p className="text-sm font-medium truncate">{email ?? "Signed in"}</p>
          {role && <p className="text-xs text-muted-foreground">{role}</p>}
        </div>
        <DropdownMenuSeparator />

        {/* Theme switcher. Plain div for the heading, NOT DropdownMenuLabel:
            Base UI's MenuGroupLabel requires a surrounding MenuGroup context
            and crashes the menu on open if used standalone. */}
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

const ENV_OPTIONS: { value: string | null; label: string; dot: string }[] = [
  { value: null, label: "All environments", dot: "bg-muted-foreground" },
  { value: "production", label: "Production", dot: "bg-emerald-400" },
  { value: "staging", label: "Staging", dot: "bg-amber-400" },
  { value: "development", label: "Development", dot: "bg-sky-400" },
];

function ScopePill() {
  const { env } = useTimeRange();
  const { setEnv } = useTimeRangeControls();
  const current = ENV_OPTIONS.find((o) => o.value === (env ?? null)) ?? ENV_OPTIONS[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 text-xs text-foreground border border-border rounded-md px-2.5 py-1 hover:bg-surface-hover transition-colors focus-ring">
        <span className={cn("size-1.5 rounded-full", current.dot)} />
        {current.label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {ENV_OPTIONS.map((o) => (
          <DropdownMenuItem
            key={o.label}
            onClick={() => setEnv(o.value)}
            className="justify-between"
          >
            <span className="flex items-center gap-2">
              <span className={cn("size-1.5 rounded-full", o.dot)} />
              {o.label}
            </span>
            {o.value === (env ?? null) && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TimePill() {
  const { rangeKey, label } = useTimeRange();
  const { setRange } = useTimeRangeControls();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 text-xs text-foreground border border-border rounded-md px-2.5 py-1 hover:bg-surface-hover transition-colors focus-ring">
        {label}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        {RANGE_KEYS.map((key) => (
          <DropdownMenuItem key={key} onClick={() => setRange(key)} className="justify-between">
            {RANGE_LABELS[key]}
            {key === rangeKey && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
