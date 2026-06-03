"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Radio as RadioIcon, Search as SearchIcon } from "lucide-react";
import { useTraces } from "@/lib/queries/use-traces";
import { useBreakdown, type BreakdownDimension } from "@/lib/queries/use-breakdown";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useOrgId } from "@/lib/org-context";
import { LoadingState } from "@/components/shared/loading-state";
import { EmptyStateRow } from "@/components/shared/empty-state";
import { DateRangePicker, type DateRange } from "@/components/shared/date-range-picker";
import { RelativeTime } from "@/components/shared/relative-time";
import { StatusBadge } from "@/components/shared/status-badge";
import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight, GitCompare, SlidersHorizontal } from "lucide-react";
import { useCompareSet } from "@/hooks/use-compare-set";
import { cn } from "@/lib/utils";

// Sentinel value used by FilterDropdown for the "Any X" option — Base UI Select
// requires every SelectItem to have a non-empty string value, and we need a way
// to express "no filter".
const ANY = "__any__";

interface FilterDropdownProps {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  options: string[];
  width?: string;
}

function FilterDropdown({ label, value, onChange, options, width = "w-40" }: FilterDropdownProps) {
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v == null || v === ANY ? undefined : v)}>
      <SelectTrigger className={cn(width, "h-8 text-sm")}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>Any {label.toLowerCase()}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>{o}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const STATUS_OPTIONS = ["success", "error", "timeout", "rate_limited"];

// Pull distinct keys from a breakdown response — used to populate the dynamic
// filter dropdowns (Model/Provider/Feature/Environment) from real data in window.
function keysFrom(data: { rows: { key: string }[] } | undefined): string[] {
  return (data?.rows ?? []).map((r) => r.key).filter((k) => k !== "");
}

function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from, to };
}

// Parse from/to URL params into a DateRange, falling back to the default
// 24-hour window on any parse failure. Critical for drill-ins from
// /dashboard/cost, charts, regressions-panel, and insights-strip: those
// callers attach ISO timestamps as ?from=...&to=... and expect the Traces
// page to land inside that window — without this, the user clicks a 30-day
// spike and the Traces page silently shows them the last 24h instead. This
// was caught by external review on the 7th pass; six internal reviews missed
// it.
function rangeFromSearchParams(sp: URLSearchParams): DateRange {
  const fromStr = sp.get("from");
  const toStr = sp.get("to");
  if (!fromStr || !toStr) return defaultRange();
  const fromMs = Date.parse(fromStr);
  const toMs = Date.parse(toStr);
  // Invalid date strings produce NaN; reject silently rather than throwing.
  // Also reject inverted ranges (from > to) — almost certainly a caller bug
  // and using them would produce confusing empty result sets.
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
    return defaultRange();
  }
  return { from: new Date(fromMs), to: new Date(toMs) };
}

type StatusFilter = "success" | "error" | "timeout" | "rate_limited";

function TracesView() {
  useDocumentTitle("Traces");
  const router = useRouter();
  const searchParams = useSearchParams();
  const orgId = useOrgId();
  const compareSet = useCompareSet();
  // Initialize range from URL params (lazy init runs once on mount). We read
  // searchParams.toString() so any caller that linked here with ?from=&to=
  // lands inside that window. Later updates to range write back to the URL
  // via the sync effect below — keeping the URL the single source of truth
  // for shareable / bookmarkable Traces views.
  const [range, setRange] = useState<DateRange>(() =>
    rangeFromSearchParams(new URLSearchParams(searchParams.toString())),
  );

  // Filters — initialized from URL (so drill-ins from /dashboard/cost survive).
  const [status, setStatus] = useState<StatusFilter | undefined>(
    () => (searchParams.get("status") as StatusFilter | null) ?? undefined,
  );
  const [model, setModel] = useState<string | undefined>(() => searchParams.get("model") ?? undefined);
  const [featureName, setFeatureName] = useState<string | undefined>(
    () => searchParams.get("feature_name") ?? undefined,
  );
  const [provider, setProvider] = useState<string | undefined>(() => searchParams.get("provider") ?? undefined);
  const [environment, setEnvironment] = useState<string | undefined>(
    () => searchParams.get("environment") ?? undefined,
  );
  const [userId, setUserId] = useState<string | undefined>(() => searchParams.get("user_id") ?? undefined);
  // prompt_version filter — drill-in target from /dashboard/prompts. We don't
  // expose a dropdown for it (cardinality varies wildly per app); the chip
  // appears only when set via URL and is clearable.
  const [promptVersion, setPromptVersion] = useState<string | undefined>(
    () => searchParams.get("prompt_version") ?? undefined,
  );
  // Local input state for the user_id text field — committed on Enter/blur so we
  // don't refetch on every keystroke.
  const [userInput, setUserInput] = useState<string>(userId ?? "");
  // Free-text search. Input state is local; committed value (used by the query
  // and synced to the URL) updates 300ms after typing stops.
  const [searchInput, setSearchInput] = useState<string>(() => searchParams.get("q") ?? "");
  const [searchCommitted, setSearchCommitted] = useState<string | undefined>(
    () => searchParams.get("q") ?? undefined,
  );
  useEffect(() => {
    const t = setTimeout(() => {
      const v = searchInput.trim();
      setSearchCommitted(v === "" ? undefined : v);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);
  const searchRef = useRef<HTMLInputElement>(null);

  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  // Mobile filter visibility. Above md the toolbar is always visible; below md
  // it's collapsed behind a "Filters" button to keep the search + trace list
  // readable on phones.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Live tail — polls every 5s when active. Only meaningful when the range
  // ends near "now"; polling a historical window has no use.
  const [livePolling, setLivePolling] = useState(false);
  const rangeIncludesNow = range.to.getTime() > Date.now() - 60_000;
  // Index of the keyboard-selected row (-1 = nothing selected)
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const tableRef = useRef<HTMLTableSectionElement>(null);

  const enabled = !!orgId;

  // Populate dynamic filter options from the breakdown endpoint for the current
  // time window — so dropdowns only offer values that actually appear in scope.
  const breakdownArgs = { orgId: orgId ?? "", from: range.from, to: range.to } as const;
  const modelOpts = useBreakdown({ ...breakdownArgs, groupBy: "model", limit: 100 }, enabled);
  const providerOpts = useBreakdown({ ...breakdownArgs, groupBy: "provider", limit: 100 }, enabled);
  const featureOpts = useBreakdown({ ...breakdownArgs, groupBy: "feature", limit: 100 }, enabled);
  const envOpts = useBreakdown({ ...breakdownArgs, groupBy: "environment", limit: 100 }, enabled);

  const query = useTraces(
    {
      orgId: orgId ?? "",
      from: range.from,
      to: range.to,
      cursor,
      status,
      model,
      featureName,
      provider,
      userId,
      environment,
      promptVersion,
      q: searchCommitted,
      // Polling only kicks in when both: user opted in AND the range is "live".
      // No cursor when live — always show the latest page.
      refetchIntervalMs: livePolling && rangeIncludesNow && !cursor ? 5000 : undefined,
    },
    enabled,
  );
  const { data, isLoading } = query;

  useApiError(query.error, query.refetch);

  // Reset selection when page/filter/range/search changes
  useEffect(() => { setSelectedIdx(-1); }, [cursor, status, range, model, featureName, provider, environment, userId, promptVersion, searchCommitted]);

  // Sync filter state to URL so any view is shareable / bookmarkable.
  // router.replace (not push) — filter tweaks shouldn't pile up in history.
  // scroll: false — don't jump the page on URL update.
  useEffect(() => {
    const sp = new URLSearchParams();
    if (status)          sp.set("status", status);
    if (model)           sp.set("model", model);
    if (provider)        sp.set("provider", provider);
    if (featureName)     sp.set("feature_name", featureName);
    if (environment)     sp.set("environment", environment);
    if (userId)          sp.set("user_id", userId);
    if (promptVersion)   sp.set("prompt_version", promptVersion);
    if (searchCommitted) sp.set("q", searchCommitted);
    // Persist range too so the URL fully reproduces the view. Drill-in
    // callers pass ISO 8601 — we round-trip the same format. We always
    // write both keys (or neither): partial state (only `from` or only `to`)
    // would be re-parsed as the default range on the next mount, silently
    // discarding half the user's selection.
    sp.set("from", range.from.toISOString());
    sp.set("to",   range.to.toISOString());
    const next = sp.toString();
    const current = searchParams.toString();
    if (next !== current) {
      router.replace(next ? `?${next}` : "/dashboard/traces", { scroll: false });
    }
  }, [status, model, provider, featureName, environment, userId, promptVersion, searchCommitted, range, router, searchParams]);

  // "/" focuses the search input (skipping when already in an input/textarea).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Setting any filter resets pagination so we land on page 1 of the new view.
  function applyFilter<T extends string>(setter: (v: T | undefined) => void) {
    return (v: T | undefined) => {
      setter(v);
      setCursorStack([]);
      setCursor(undefined);
    };
  }

  function commitUserId() {
    const v = userInput.trim();
    applyFilter<string>(setUserId)(v === "" ? undefined : v);
  }

  const traces = data?.traces ?? [];

  // Build the trace-detail URL preserving the time range so:
  //  (a) the trace-tree query bounds its ClickHouse scan instead of probing,
  //  (b) refreshing / sharing the URL lands the recipient in the same range,
  //  (c) router.back() from detail → list returns to the same filter+range.
  // Round-3 review flagged the missing from/to as a performance + trust gap.
  const detailHref = useCallback((traceId: string, spanId: string): string => {
    const sp = new URLSearchParams();
    sp.set("span", spanId);
    sp.set("from", range.from.toISOString());
    sp.set("to",   range.to.toISOString());
    return `/dashboard/traces/${traceId}?${sp.toString()}`;
  }, [range]);

  const openSelected = useCallback(() => {
    const t = traces[selectedIdx];
    if (t) router.push(detailHref(t.trace_id, t.span_id));
  }, [traces, selectedIdx, router, detailHref]);

  // j / k / Enter keyboard nav — only when focus is not in an input/select
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, traces.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        openSelected();
      } else if (e.key === "Escape") {
        setSelectedIdx(-1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [traces.length, openSelected]);

  // Scroll selected row into view
  useEffect(() => {
    if (selectedIdx < 0 || !tableRef.current) return;
    const rows = tableRef.current.querySelectorAll("tr[data-idx]");
    const row = rows[selectedIdx] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  function onNext() {
    if (!data?.next_cursor) return;
    setCursorStack((s) => [...s, cursor ?? ""]);
    setCursor(data.next_cursor ?? undefined);
  }

  function onPrev() {
    const prev = [...cursorStack];
    const last = prev.pop();
    setCursorStack(prev);
    setCursor(last ?? undefined);
  }

  function onRangeChange(r: DateRange) {
    setRange(r);
    setCursorStack([]);
    setCursor(undefined);
  }

  const anyFilterActive = !!(status || model || featureName || provider || environment || userId || promptVersion || searchCommitted);
  // Count for the mobile "Filters" button badge. Excludes search since search
  // has its own always-visible input above the toolbar.
  const activeFilterCount = [status, model, featureName, provider, environment, userId, promptVersion]
    .filter(Boolean).length;

  function clearAllFilters() {
    setStatus(undefined);
    setModel(undefined);
    setFeatureName(undefined);
    setProvider(undefined);
    setEnvironment(undefined);
    setUserId(undefined);
    setUserInput("");
    setPromptVersion(undefined);
    setSearchInput("");
    setSearchCommitted(undefined);
    setCursorStack([]);
    setCursor(undefined);
  }

  return (
    <div className="space-y-4">
      {/* Header + date range */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Traces</h1>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            j/k to navigate · Enter to open · Esc to clear
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Live tail — pulsing green dot when active. Disabled (with hint)
              when the date range doesn't include "now", since polling a
              historical window achieves nothing. */}
          <button
            onClick={() => setLivePolling((p) => !p)}
            disabled={!rangeIncludesNow}
            title={!rangeIncludesNow ? "Live tail only works for ranges ending around now" : livePolling ? "Polling every 5s — click to pause" : "Click to poll every 5s"}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md border text-xs transition-colors",
              livePolling
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                : "border-input text-muted-foreground hover:text-foreground",
              !rangeIncludesNow && "opacity-50 cursor-not-allowed",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                livePolling ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground/50",
              )}
            />
            <RadioIcon className="h-3 w-3" />
            Live
          </button>
          <DateRangePicker value={range} onChange={onRangeChange} />
        </div>
      </div>

      {/* Search bar — span_id / trace_id / session_id / user_id exact-match
          plus input/output/error_message substring (owners only). */}
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          ref={searchRef}
          type="text"
          placeholder="Search by trace_id, span_id, session_id, user_id, or input/output text — press / to focus"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              (e.target as HTMLInputElement).blur();
              setSearchInput("");
            }
          }}
          className="w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm h-9 focus:outline-none focus:border-ring"
        />
        {searchInput && (
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground border border-border rounded px-1 py-0.5">esc</kbd>
        )}
      </div>

      {/* Mobile-only filter toggle. Below md the filter toolbar is hidden by
          default so phone users see search + the trace list cleanly. On md+
          this button doesn't render at all and the toolbar is always visible. */}
      <button
        type="button"
        onClick={() => setFiltersOpen((v) => !v)}
        className="md:hidden inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded-md bg-card hover:bg-muted/40 transition-colors"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Filters
        {activeFilterCount > 0 && (
          <span className="text-[10px] font-medium bg-brand text-white rounded px-1.5 py-0.5">
            {activeFilterCount}
          </span>
        )}
      </button>

      {/* Filter toolbar — flex-wrap on desktop. On mobile each control goes
          full-width via the grid override so the dropdowns are tappable. */}
      <div
        className={cn(
          // Visibility: toggled on mobile, always visible on md+
          filtersOpen ? "grid" : "hidden",
          "md:flex grid-cols-2 gap-2 md:items-center md:flex-wrap",
        )}
      >
        <FilterDropdown
          label="Status"
          value={status}
          onChange={applyFilter<string>((v) => setStatus(v as StatusFilter | undefined))}
          options={STATUS_OPTIONS}
          width="w-full md:w-36"
        />
        <FilterDropdown
          label="Model"
          value={model}
          onChange={applyFilter<string>(setModel)}
          options={keysFrom(modelOpts.data)}
          width="w-full md:w-44"
        />
        <FilterDropdown
          label="Provider"
          value={provider}
          onChange={applyFilter<string>(setProvider)}
          options={keysFrom(providerOpts.data)}
          width="w-full md:w-36"
        />
        <FilterDropdown
          label="Feature"
          value={featureName}
          onChange={applyFilter<string>(setFeatureName)}
          options={keysFrom(featureOpts.data)}
          width="w-full md:w-44"
        />
        <FilterDropdown
          label="Environment"
          value={environment}
          onChange={applyFilter<string>(setEnvironment)}
          options={keysFrom(envOpts.data)}
          width="w-full md:w-32"
        />
        <input
          type="text"
          placeholder="user_id"
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onBlur={commitUserId}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitUserId(); } }}
          className="rounded-md border border-input bg-background px-3 text-sm h-8 w-full md:w-36 focus:outline-none focus:border-ring"
        />
        {anyFilterActive && (
          <button
            onClick={clearAllFilters}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 md:ml-1 col-span-2"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Prompt-version chip — only renders when the URL carries
          ?prompt_version=… (e.g. arriving via drill-in from the Prompts page).
          We don't put it in the regular filter toolbar because the list of
          versions is per-app and unbounded — a dropdown there would be either
          empty or wrong. The chip is removable, which also clears the URL. */}
      {promptVersion && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-brand/30 bg-brand/10 text-xs">
          <span className="text-muted-foreground">Prompt version:</span>
          <span className="font-mono text-foreground">
            {promptVersion === "__null__" ? "(untagged)" : promptVersion}
          </span>
          <button
            onClick={() => setPromptVersion(undefined)}
            className="ml-auto text-muted-foreground hover:text-foreground underline underline-offset-2"
            aria-label="Clear prompt version filter"
          >
            Clear
          </button>
        </div>
      )}

      {/* Compare hint — shown only when the user hasn't marked anything yet
          AND hasn't dismissed it. Closes the discoverability gap: the ↔ icon
          on each row wasn't telling users what the feature was for. */}
      <CompareHint compareCount={compareSet.count} />

      {/* Table */}
      <div className="border border-border rounded-md overflow-hidden">
        <table role="grid" aria-label="Traces" className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th
                className="w-10 px-2 py-2 text-center text-[10px] font-medium text-muted-foreground uppercase tracking-wider"
                title="Mark up to 2 traces, then compare side-by-side"
              >
                ↔
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Time</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden sm:table-cell">Model</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground hidden md:table-cell">Latency</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground hidden md:table-cell">Cost</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden lg:table-cell">Span ID</th>
            </tr>
          </thead>
          <tbody ref={tableRef}>
            {isLoading
              ? Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-3 py-2.5">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              : traces.length === 0
              ? (
                  <EmptyStateRow
                    colSpan={7}
                    icon={SearchIcon}
                    title="No traces match"
                    description={
                      anyFilterActive
                        ? "Try clearing filters or widening the date range."
                        : "Traces appear here as your SDK streams calls. Widen the range, or check that your SDK is sending data."
                    }
                    action={
                      anyFilterActive
                        ? { label: "Clear all filters", onClick: clearAllFilters, variant: "secondary" }
                        : undefined
                    }
                  />
                )
              : traces.map((t, i) => {
                const marked = compareSet.has(t.trace_id);
                return (
                  <tr
                    key={t.span_id}
                    data-idx={i}
                    role="row"
                    aria-selected={selectedIdx === i}
                    aria-label={`Trace ${t.trace_id.slice(0, 12)} — press Enter to open`}
                    className={cn(
                      "border-b border-border last:border-0 cursor-pointer transition-colors",
                      selectedIdx === i
                        ? "bg-muted/50 outline outline-1 outline-primary/30"
                        : "hover:bg-muted/20"
                    )}
                    onClick={() => router.push(detailHref(t.trace_id, t.span_id))}
                    // No onMouseEnter — it fought keyboard navigation
                    // (any pointer drift over the table reassigned the j/k
                    // selection mid-traversal). a11y review S-2: pick one
                    // input modality as authoritative. Keyboard wins.
                  >
                    {/* Mark-for-compare toggle — stops propagation so it
                        doesn't navigate to the trace tree. Marks at trace
                        level (so a trace's multiple visible spans share state). */}
                    <td className="w-10 px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => compareSet.toggle(t.trace_id)}
                        title={marked ? "Unmark for compare" : "Mark for compare"}
                        aria-label={marked ? "Unmark for compare" : "Mark for compare"}
                        className={cn(
                          "size-6 rounded flex items-center justify-center transition-colors",
                          marked
                            ? "bg-primary/15 text-primary"
                            : "text-muted-foreground/50 hover:text-foreground hover:bg-muted/40",
                        )}
                      >
                        <GitCompare className="h-3.5 w-3.5" />
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                      <RelativeTime date={t.timestamp} />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs hidden sm:table-cell">{t.model}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums hidden md:table-cell">{t.latency_ms}ms</td>
                    <td className="px-3 py-2.5 text-right tabular-nums hidden md:table-cell">
                      ${t.cost_usd.toFixed(4)}
                    </td>
                    <td className="px-3 py-2.5 hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
                      <CopyButton value={t.span_id} />
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onPrev}
          disabled={cursorStack.length === 0}
        >
          <ChevronLeft className="h-4 w-4" />
          Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={!data?.next_cursor}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export default function TracesPage() {
  return (
    <Suspense fallback={<LoadingState variant="table" rows={8} />}>
      <TracesView />
    </Suspense>
  );
}

// CompareHint — one-time discoverability banner. Persists dismissal in
// localStorage so it doesn't nag, but reappears if the user clears storage
// (i.e. fresh install / different browser).
const COMPARE_HINT_DISMISS_KEY = "scopecall:compare-hint-dismissed:v1";

function CompareHint({ compareCount }: { compareCount: number }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.localStorage.getItem(COMPARE_HINT_DISMISS_KEY) === "1");
  }, []);
  function dismiss() {
    setDismissed(true);
    try { window.localStorage.setItem(COMPARE_HINT_DISMISS_KEY, "1"); } catch { /* ignore */ }
  }
  // Hide once dismissed OR once the user has discovered the feature by marking
  // at least one trace — at that point the floating tray takes over the role
  // of explaining the workflow.
  if (dismissed || compareCount > 0) return null;
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-md border border-dashed border-border bg-card/40 text-xs">
      <GitCompare className="h-3.5 w-3.5 text-brand shrink-0 mt-0.5" />
      <p className="flex-1 text-muted-foreground">
        <span className="text-foreground font-medium">Tip:</span>{" "}
        click the <span className="font-mono">↔</span> icon on two traces to compare them side-by-side.
        Useful for debugging &ldquo;why did this work and that one fail?&rdquo;
      </p>
      <button
        onClick={dismiss}
        className="text-muted-foreground hover:text-foreground text-[11px] underline underline-offset-2 shrink-0"
      >
        Got it
      </button>
    </div>
  );
}
