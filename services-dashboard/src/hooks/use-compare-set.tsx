"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// Compare is binary by design — "A vs B" is the mental model. Selecting a 3rd
// trace replaces the oldest (FIFO) rather than silently being ignored. This
// makes the limit visible: the user sees the displaced trace's checkmark
// disappear at the same instant they click the new one.
const MAX_COMPARE = 2;

// Persisted via localStorage so the user can mark a trace, navigate elsewhere
// (e.g. into a trace tree to confirm it's the right one), then come back and
// mark another. Survives full page reloads, scoped to this browser only.
const STORAGE_KEY = "scopecall:compare-set:v1";

function loadFromStorage(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_COMPARE)
      : [];
  } catch {
    return [];
  }
}

function saveToStorage(ids: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* quota exceeded — silent ignore */
  }
}

export interface CompareSetAPI {
  ids: string[];
  has: (id: string) => boolean;
  /** Toggle membership. If at capacity and `id` is new, FIFO-swaps the oldest. */
  toggle: (id: string) => void;
  clear: () => void;
  count: number;
  max: number;
  isFull: boolean;
}

const CompareSetContext = createContext<CompareSetAPI | null>(null);

// Provider holds the single source of truth for compare state. Mount it inside
// DashboardProviders so the Traces page button + the CompareTray (which sits
// outside the page tree) share the same state. Without this, each component's
// useState was independent — clicks didn't propagate same-tab, which was the
// "until refresh" bug.
export function CompareSetProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<string[]>([]);

  // Hydrate from localStorage on mount. Not via lazy initialiser to keep
  // SSR markup deterministic.
  useEffect(() => {
    setIds(loadFromStorage());
  }, []);

  // Cross-tab sync — if user marks in tab A, tab B reflects on next storage event.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setIds(loadFromStorage());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      // Unmark — remove and we're done.
      if (prev.includes(id)) {
        const next = prev.filter((x) => x !== id);
        saveToStorage(next);
        return next;
      }
      // Mark — FIFO-swap the oldest if at capacity. Keeps the selection visible
      // and intuitive without a hard "can't add" block.
      const next = prev.length >= MAX_COMPARE
        ? [...prev.slice(1), id]
        : [...prev, id];
      saveToStorage(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setIds([]);
    saveToStorage([]);
  }, []);

  const api = useMemo<CompareSetAPI>(() => ({
    ids,
    has: (id) => ids.includes(id),
    toggle,
    clear,
    count: ids.length,
    max: MAX_COMPARE,
    isFull: ids.length >= MAX_COMPARE,
  }), [ids, toggle, clear]);

  return <CompareSetContext.Provider value={api}>{children}</CompareSetContext.Provider>;
}

export function useCompareSet(): CompareSetAPI {
  const ctx = useContext(CompareSetContext);
  if (!ctx) {
    throw new Error("useCompareSet must be used inside <CompareSetProvider>");
  }
  return ctx;
}
