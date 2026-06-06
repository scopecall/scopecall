"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Bookmark, BookmarkPlus, Loader2, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useSavedViews,
  useCreateSavedView,
  useDeleteSavedView,
  type SavedView,
} from "@/lib/queries/use-saved-views";
import { cn } from "@/lib/utils";
import { useOrgId } from "@/lib/org-context";

// Pages that don't carry meaningful filter state — saving a bookmark for
// "/dashboard" doesn't really add value, just clutters the menu. Hide the
// Save button on these. (Easy to relax later if users ask.)
const SAVE_BLOCKED_PATHS = new Set(["/dashboard"]);

// SavedViewsMenu — bookmark dropdown in the top header. Lets a team save the
// current URL (path + query) as a named view that everyone in the org can use.
// Per-org sharing was deliberate: the high-value views are *team*-curated
// ("prod-error board"), not personal bookmarks.
export function SavedViewsMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const orgId = useOrgId();
  const [creating, setCreating] = useState(false);

  // Gate the fetch on orgId. Other queries do this via their `enabled` arg;
  // useSavedViews defaults to enabled. Without this gate, the menu fires a
  // request during the transient pre-auth render and eats a 401+retry.
  const viewsQ = useSavedViews(!!orgId);
  const create = useCreateSavedView();
  const del = useDeleteSavedView();

  const views = viewsQ.data ?? [];
  const currentQuery = search.toString();

  // Suggest a default name based on the page + a couple of distinctive filter
  // params, so the user usually just hits Enter.
  function suggestName(): string {
    const last = pathname.split("/").filter(Boolean).pop() ?? "view";
    const base = last.charAt(0).toUpperCase() + last.slice(1);
    const params = new URLSearchParams(currentQuery);
    const hints: string[] = [];
    for (const k of ["status", "model", "feature", "environment"]) {
      const v = params.get(k);
      if (v) hints.push(`${k}:${v}`);
    }
    return hints.length ? `${base} — ${hints.join(", ")}` : base;
  }

  async function handleSave() {
    setCreating(true);
    try {
      const defaultName = suggestName();
      const name = window.prompt("Name this view (visible to your whole org):", defaultName);
      if (!name) return;
      await create.mutateAsync({ name: name.trim(), path: pathname, query_string: currentQuery });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      window.alert(`Couldn't save view:\n${msg}`);
    } finally {
      setCreating(false);
    }
  }

  function openView(v: SavedView) {
    const url = v.query_string ? `${v.path}?${v.query_string}` : v.path;
    router.push(url);
  }

  async function handleDelete(v: SavedView, ev: React.MouseEvent) {
    ev.stopPropagation();
    ev.preventDefault();
    if (!window.confirm(`Delete view "${v.name}"?`)) return;
    try {
      await del.mutateAsync(v.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      window.alert(`Couldn't delete:\n${msg}`);
    }
  }

  const canSaveHere = !SAVE_BLOCKED_PATHS.has(pathname);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Saved views"
        title="Saved views"
        className="size-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Bookmark className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-72">
        {/* Save action — disabled on pages without meaningful state. */}
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSaveHere || creating}
          className={cn(
            "w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md",
            canSaveHere && !creating
              ? "hover:bg-muted text-foreground"
              : "text-muted-foreground cursor-not-allowed",
          )}
        >
          {creating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <BookmarkPlus className="size-4" />
          )}
          Save current view
        </button>
        {!canSaveHere && (
          <p className="px-2 pb-2 text-[11px] text-muted-foreground">
            Apply filters on Traces, Cost, or Sessions, then come back here.
          </p>
        )}

        <DropdownMenuSeparator />

        {viewsQ.isLoading ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">Loading views…</div>
        ) : views.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No saved views yet. Filter a page and save it as a team bookmark.
          </div>
        ) : (
          <>
            <div className="px-1.5 pt-1.5 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Org views ({views.length})
            </div>
            <div className="max-h-80 overflow-y-auto">
              {views.map((v) => (
                <DropdownMenuItem
                  key={v.id}
                  onClick={() => openView(v)}
                  className="group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{v.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate font-mono">
                      {v.path}{v.query_string ? "?…" : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Delete ${v.name}`}
                    onClick={(e) => handleDelete(v, e)}
                    // focus-visible:opacity-100 makes the button visible to
                    // keyboard users who tab into it — without it, the
                    // button is invisible while focused. (a11y S-3.)
                    className="size-6 flex items-center justify-center text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:text-red-400 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </DropdownMenuItem>
              ))}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
