"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Coins, Home, List, LogOut, Copy } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { auth } from "@/lib/auth";
import { toast } from "sonner";

interface CommandPaletteProps {
  orgId?: string;
}

export function CommandPalette({ orgId }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // Open on ⌘K / Ctrl+K
  useEffect(() => {
    function down(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  function go(path: string) {
    router.push(path);
    setOpen(false);
  }

  async function copyOrgId() {
    if (!orgId) return;
    await navigator.clipboard.writeText(orgId);
    toast.success("Org ID copied");
    setOpen(false);
  }

  async function signOut() {
    await auth.signOut();
    router.push("/auth/login");
    router.refresh();
    setOpen(false);
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => go("/dashboard")}>
            <Home className="mr-2 h-4 w-4" />
            Overview
          </CommandItem>
          <CommandItem onSelect={() => go("/dashboard/cost")}>
            <Coins className="mr-2 h-4 w-4" />
            Cost
          </CommandItem>
          <CommandItem onSelect={() => go("/dashboard/traces")}>
            <List className="mr-2 h-4 w-4" />
            Traces
          </CommandItem>
          <CommandItem onSelect={() => go("/dashboard/alerts")}>
            <Bell className="mr-2 h-4 w-4" />
            Alerts
          </CommandItem>
        </CommandGroup>

        {orgId && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Copy">
              <CommandItem onSelect={copyOrgId}>
                <Copy className="mr-2 h-4 w-4" />
                Copy org ID
                <span className="ml-auto text-xs text-muted-foreground font-mono truncate max-w-[120px]">
                  {orgId}
                </span>
              </CommandItem>
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Account">
          <CommandItem onSelect={signOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
