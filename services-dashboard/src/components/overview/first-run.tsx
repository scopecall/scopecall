"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Sparkles } from "lucide-react";
import { useSDKHealth } from "@/lib/queries/use-sdk-health";
import { cn } from "@/lib/utils";

// FirstRunDashboard — takes over the Overview when an org has zero traces.
// Goal: a new install lands here, follows three steps, and sees their first
// trace appear in seconds. Beats the previous EmptyStateHint, which was a
// terse two-card block buried under the KPI strip.
//
// Three things this needs to nail:
//   1. The user MUST see that we're actively watching. The polling pulse
//      under "Waiting for your first call..." is load-bearing — it tells
//      the user the page isn't broken.
//   2. The install snippet MUST be one click to copy. No three-tab dance.
//   3. When the first call lands, the transition out should be smooth —
//      reload the page (or let React Query refetch) so the user sees their
//      data, not a "click here to continue" friction step.

interface Props {
  orgId: string;
  /** Called when the SDK health flips from no-calls to has-calls.
   *  Parent uses this to refresh the dashboard data. */
  onFirstCall?: () => void;
}

// Single-language quickstart. This surface had drifted from the actual
// SDK shape — the Python option offered an SDK that doesn't
// ship yet, and the Node snippet used a constructor pattern (`ScopeCall(...)`)
// that the v0.1.1 SDK doesn't export. The current SDK API is `init(...)` +
// `sdk.instrument(openai)` + `sdk.trace(...)`. Show ONLY what works today.
//
// Python comes back to this UI when the SDK reaches OpenAI/Anthropic parity
// (v0.3.x roadmap). Until then, surfacing a fake tab teaches users to copy
// code that fails — the single worst quickstart UX in a devtool.
type Tab = "node";

const SNIPPETS: Record<Tab, { lang: string; install: string; code: string }> = {
  node: {
    lang: "Node / TypeScript",
    install: "npm install @scopecall/scopecall-js openai",
    code: `import OpenAI from "openai";
import { init } from "@scopecall/scopecall-js";

// One-time init at app startup. Pick a key from Settings → API Keys.
const sdk = init({
  apiKey: process.env.SCOPECALL_API_KEY!,
  // Self-hosted: point at your INGEST service (Rust, port 8080).
  // NOT the dashboard API (Go, port 8081) — events go to ingest first,
  // the dashboard reads from the API afterward.
  endpoint: "http://localhost:8080/v1/ingest",
});

// Instrument your OpenAI client — calls are now traced automatically.
const openai = new OpenAI();
sdk.instrument(openai);

await sdk.trace("hello-world", async () => {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hello!" }],
  });
  console.log(res.choices[0].message.content);
});`,
  },
};

export function FirstRunDashboard({ orgId, onFirstCall }: Props) {
  // useState kept (not a constant) so adding Python / Go / other tabs later
  // doesn't reshape this component — only the SNIPPETS map + the Tab union
  // need touching.
  const [tab, setTab] = useState<Tab>("node");
  const [copied, setCopied] = useState<"install" | "code" | null>(null);

  // Poll SDK health to detect the first call. When has_calls flips true,
  // trigger onFirstCall so the parent can reload data.
  //
  // CRITICAL: this MUST run inside useEffect with a fired-once ref guard.
  // Calling onFirstCall() from render is a React anti-pattern that double-
  // fires in Strict Mode and — when the dashboard's "last 24h" window has
  // no data but the SDK-health 7-day window does — produces a persistent
  // refetch storm. Reproducer was the exact reseed shape the user just
  // loaded (30d data, latest call < 1d old but >0d, parent's default
  // range = last 24h).
  const { data } = useSDKHealth(orgId, !!orgId);
  const firedRef = useRef(false);
  useEffect(() => {
    if (data?.has_calls && onFirstCall && !firedRef.current) {
      firedRef.current = true;
      onFirstCall();
    }
  }, [data?.has_calls, onFirstCall]);

  const snip = SNIPPETS[tab];

  async function copy(text: string, kind: "install" | "code") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — silent */
    }
  }

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      {/* Hero ─────────────────────────────────────────────────────────── */}
      <div className="px-6 py-6 border-b border-border bg-gradient-to-b from-brand/5 to-transparent">
        <div className="flex items-center gap-3 mb-2">
          <div className="size-9 rounded-full bg-brand/15 border border-brand/30 flex items-center justify-center">
            <Sparkles className="h-4 w-4 text-brand" />
          </div>
          <h1 className="text-xl font-semibold">Welcome to ScopeCall</h1>
        </div>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Pick a language, copy the snippet, run it once. Your first trace lands
          here in seconds — this page updates automatically.
        </p>
        {/* role="status" + aria-live="polite" tells screen readers this is
            an active status indicator. Without it, the polling pulse is
            inert decoration to assistive tech. (a11y review.) */}
        <div
          role="status"
          aria-live="polite"
          className="mt-4 inline-flex items-center gap-2 text-xs text-muted-foreground bg-background/60 border border-border rounded-full px-3 py-1.5"
        >
          <Loader2 className="h-3 w-3 animate-spin text-brand" aria-hidden="true" />
          <span>Watching for your first call…</span>
        </div>
      </div>

      {/* Three steps as a semantic <ol> so screen readers follow the
          narrative (Step 1 → Step 2 → Step 3) rather than three unrelated
          paragraphs. The list-style is suppressed visually with `list-none`
          + the bordered card design. (a11y review.) */}
      <ol className="list-none">

      {/* Step 1: language picker — only Node ships today, so collapse the
          tab strip into an inline label. Once Python (or others) ships, the
          tablist UI returns naturally — just re-render when SNIPPETS has
          more than one key. */}
      {Object.keys(SNIPPETS).length > 1 && (
        <li className="px-6 py-5 border-b border-border">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
            Step 1 — pick a language
          </p>
          <div role="tablist" aria-label="Language" className="inline-flex border border-border rounded-md p-0.5 bg-muted/40">
            {(Object.keys(SNIPPETS) as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-current={tab === t ? "true" : undefined}
                onClick={() => setTab(t)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded transition-colors",
                  tab === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {SNIPPETS[t].lang}
              </button>
            ))}
          </div>
        </li>
      )}

      {/* Step 1 (only-Node mode): install ────────────────────────────── */}
      <li className="px-6 py-5 border-b border-border">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Step 1 — install
        </p>
        <div className="relative">
          <pre className="font-mono text-xs bg-background/60 border border-border rounded-md px-3 py-2.5 overflow-x-auto">
            {snip.install}
          </pre>
          <button
            onClick={() => copy(snip.install, "install")}
            className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-background border border-border hover:bg-muted transition-colors"
          >
            {copied === "install" ? (
              <><Check className="h-3 w-3 text-emerald-400" /> Copied</>
            ) : (
              <><Copy className="h-3 w-3" /> Copy</>
            )}
          </button>
        </div>
      </li>

      {/* Step 2: code ────────────────────────────────────────────────── */}
      <li className="px-6 py-5">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Step 2 — make a call
        </p>
        <div className="relative">
          <pre className="font-mono text-xs bg-background/60 border border-border rounded-md px-3 py-3 overflow-x-auto leading-relaxed">
            {snip.code}
          </pre>
          <button
            onClick={() => copy(snip.code, "code")}
            className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-background border border-border hover:bg-muted transition-colors"
          >
            {copied === "code" ? (
              <><Check className="h-3 w-3 text-emerald-400" /> Copied</>
            ) : (
              <><Copy className="h-3 w-3" /> Copy</>
            )}
          </button>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Need an API key?{" "}
          <a href="/dashboard/settings/keys" className="text-brand hover:underline">
            Create one
          </a>
          . Stuck?{" "}
          <a href="https://scopecall.com/docs/quickstart" className="text-brand hover:underline">
            Read the quickstart
          </a>
          .
        </p>
      </li>
      </ol>
    </div>
  );
}
