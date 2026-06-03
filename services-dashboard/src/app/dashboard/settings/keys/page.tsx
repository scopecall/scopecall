"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Info, KeyRound, Plus, Trash2 } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useApiError } from "@/hooks/use-api-error";
import { useOrgId } from "@/lib/org-context";
import {
  useAPIKeys,
  useCreateAPIKey,
  useRevokeAPIKey,
  type APIKeyScope,
  type APIKeyView,
  type CreateKeyResponse,
} from "@/lib/queries/use-api-keys";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/shared/relative-time";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { card, statusPill, typography } from "@/lib/design";
import { cn } from "@/lib/utils";

// API Keys page — the missing piece in the first-run loop.
//
// The contract this page must honour:
//
//   1. The raw token is rendered EXACTLY ONCE, in the success modal after
//      Create. After the user dismisses the modal, the token is gone — the
//      server only ever stored a SHA-256 hash and the public prefix.
//
//   2. Revoke is a soft-delete (flips revoked = true server-side). The row
//      stays in the list with a strikethrough so the user can see history.
//      Re-keying a system means create-then-revoke (overlap), not
//      revoke-then-create — there's no recovery path from an accidental
//      revoke if you don't have the raw token elsewhere.
//
//   3. Auth: the Go API gates create/revoke on `principalClass == "owner"`,
//      i.e. owner or admin Auth.js role. Viewers see the list but the Create
//      button + Revoke action 403 if they try anyway. The page doesn't gate
//      on the client because role isn't on the client without an extra fetch
//      — the API is the source of truth, and the UI surfaces 403s via the
//      shared useApiError toast.

/** Retention window for revoked keys, in days. Kept in sync with the API's
 *  default (services-go/api/internal/apikeys/cleanup.go:DefaultRetentionDays).
 *  Operators who override via API_KEY_RETENTION_DAYS env get a slightly
 *  stale copy text here — acceptable tradeoff for now; a future improvement
 *  is surfacing the actual window via /api/v1/sdk/health or similar. */
const REVOKED_RETENTION_DAYS = 30;

type Tab = "active" | "revoked";

export default function APIKeysPage() {
  useDocumentTitle("API Keys");
  const orgId = useOrgId();
  const keys = useAPIKeys(orgId ?? "", !!orgId);
  useApiError(keys.error);

  const [tab, setTab] = useState<Tab>("active");
  const [showCreate, setShowCreate] = useState(false);
  const [createdToken, setCreatedToken] = useState<CreateKeyResponse | null>(null);

  // Partition once per render. The list is small (handful of keys per org),
  // so two array filters are cheaper + simpler than two queries.
  const { active, revoked } = useMemo(() => {
    const a: APIKeyView[] = [];
    const r: APIKeyView[] = [];
    for (const k of keys.data ?? []) (k.revoked ? r : a).push(k);
    return { active: a, revoked: r };
  }, [keys.data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className={typography.pageH1}>API Keys</h1>
        {/* The Generate button only makes sense on the Active tab — generating
            a key from inside the Revoked view would be a UX rugpull. Hide it
            cleanly when the user is on Revoked. */}
        {tab === "active" && (
          <Button
            onClick={() => setShowCreate((s) => !s)}
            variant={showCreate ? "outline" : "default"}
            size="sm"
          >
            <Plus className="h-4 w-4" />
            {showCreate ? "Cancel" : "Generate key"}
          </Button>
        )}
      </div>

      <p className={typography.helpText}>
        Keys authenticate the SDK to the ingest endpoint. In v0.1.1 every
        dashboard-minted key includes <span className="font-mono">ingest:write</span>;
        the <span className="font-mono">traces:read</span> scope is opt-in
        and grants additional access to the read API. Treat keys like
        passwords — anyone with one can write trace data to your org.
      </p>

      {/* Tab strip — Supabase-style segmented control with counts. Counts
          come from the partition above so they update instantly after a
          revoke (which moves the row from Active to Revoked). */}
      <div role="tablist" aria-label="Key state" className="inline-flex border border-border rounded-md p-0.5 bg-muted/40">
        <TabButton
          label="Active"
          count={active.length}
          selected={tab === "active"}
          onClick={() => setTab("active")}
        />
        <TabButton
          label="Revoked"
          count={revoked.length}
          selected={tab === "revoked"}
          onClick={() => setTab("revoked")}
        />
      </div>

      {/* Create form lives on the Active tab; collapses on tab switch so
          partially-typed names don't survive a revoke-tab side trip. */}
      {tab === "active" && showCreate && (
        <CreateKeyForm
          orgId={orgId ?? ""}
          onCreated={(resp) => {
            setCreatedToken(resp);
            setShowCreate(false);
          }}
        />
      )}

      {/* New-key reveal banner stays visible on both tabs — if a user revokes
          something while the banner is up they shouldn't lose the new token. */}
      {createdToken && (
        <NewKeyDialog
          response={createdToken}
          onDismiss={() => setCreatedToken(null)}
        />
      )}

      {tab === "revoked" && revoked.length > 0 && <RevokedRetentionBanner />}

      <KeysList
        orgId={orgId ?? ""}
        keys={tab === "active" ? active : revoked}
        mode={tab}
        loading={keys.isLoading}
        error={keys.error}
      />
    </div>
  );
}

function TabButton({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "px-3 py-1 text-xs font-medium rounded transition-colors inline-flex items-center gap-1.5",
        selected
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <span
        className={cn(
          "text-[10px] tabular-nums px-1 rounded",
          selected ? "bg-muted text-foreground" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function RevokedRetentionBanner() {
  return (
    <div className="border border-border rounded-md bg-muted/40 px-3 py-2.5 flex items-start gap-2">
      <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <p className="text-xs text-muted-foreground">
        Revoked keys are kept for{" "}
        <span className="font-medium text-foreground">{REVOKED_RETENTION_DAYS} days</span>{" "}
        for audit, then permanently deleted. Pre-existing revoked keys without
        a recorded revoke time stay until you remove them manually.
      </p>
    </div>
  );
}

// ─── Create form ─────────────────────────────────────────────────────────

function CreateKeyForm({
  orgId,
  onCreated,
}: {
  orgId: string;
  onCreated: (resp: CreateKeyResponse) => void;
}) {
  const [name, setName] = useState("");
  // Default to ingest-only: the typical caller is an SDK shipping events.
  // Read access is an explicit opt-in because it broadens the blast radius
  // of a leaked key from "spam our ingest" to "exfiltrate our trace data."
  const [allowRead, setAllowRead] = useState(false);
  const create = useCreateAPIKey(orgId);
  useApiError(create.error);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const scopes: APIKeyScope[] = allowRead
      ? ["ingest:write", "traces:read"]
      : ["ingest:write"];
    const resp = await create.mutateAsync({ name, scopes });
    setName("");
    setAllowRead(false);
    onCreated(resp);
  }

  return (
    <form onSubmit={submit} className={cn(card.panel, "p-4 space-y-3")}>
      <div>
        <label htmlFor="key-name" className="text-xs font-medium block mb-1">
          Name <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <input
          id="key-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. backend-prod"
          maxLength={80}
          className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <p className={cn(typography.helpText, "mt-1")}>
          A label only — purely for your reference in this list.
        </p>
      </div>

      {/* Scope picker. v0.1.1 UI surfaces only the read opt-in; every key
          minted from the dashboard today includes ingest:write as baseline
          so the typical caller (an SDK shipping trace events) just works.
          True two-way scoping — letting an operator mint a read-only key
          with no ingest:write — is supported by the backend (the wire
          protocol accepts any scope combination, the Rust ingest enforces
          ingest:write independently of the Go API's traces:read check)
          but isn't exposed in this form yet. v0.1.2 adds the second
          checkbox + the corresponding form-state guard ("at least one
          scope required"). Tracked as the first item in the post-launch
          fast-follow. */}
      <div className="space-y-2">
        <label className="text-xs font-medium block">Permissions</label>
        <div className="flex items-center gap-2 text-sm">
          <span className={cn(statusPill.base, statusPill.ok)}>ingest:write</span>
          <span className={typography.helpText}>
            on every key (v0.1.1); read-only keys arrive in v0.1.2
          </span>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={allowRead}
            onChange={(e) => setAllowRead(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Also allow read API access (<span className="font-mono text-xs">traces:read</span>)
            <span className={cn(typography.helpText, "block")}>
              Grants this key the same read access the dashboard has:
              traces, costs, prompts, sessions, saved views, alerts, and
              the rest of the dashboard API surface. Leave off for
              SDK-only keys — that&apos;s the safer default.
            </span>
          </span>
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? "Generating…" : "Generate key"}
        </Button>
      </div>
    </form>
  );
}

// ─── New-key dialog (one-time reveal) ─────────────────────────────────────

function NewKeyDialog({
  response,
  onDismiss,
}: {
  response: CreateKeyResponse;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(response.raw_token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silent */
    }
  }
  return (
    // Modal-ish surface, not a real <dialog> — the page is single-task so an
    // inline emphasized card is enough. Border-amber telegraphs "this is the
    // one moment to copy" without the dread of a destructive red.
    <div className="border-2 border-amber-500/60 bg-amber-500/10 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-2">
        <KeyRound className="h-4 w-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Copy your new key now</h2>
          <p className={cn(typography.helpText, "mt-0.5")}>
            ScopeCall only stores a hash — we can&apos;t show you this token
            again after you dismiss this banner.
          </p>
        </div>
      </div>
      <div className="relative">
        <pre className="font-mono text-xs bg-background border border-border rounded-md px-3 py-2.5 overflow-x-auto">
          {response.raw_token}
        </pre>
        <button
          onClick={copy}
          className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-background border border-border hover:bg-muted transition-colors"
        >
          {copied ? (
            <><Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /> Copied</>
          ) : (
            <><Copy className="h-3 w-3" /> Copy</>
          )}
        </button>
      </div>
      <div className="flex justify-end">
        <Button onClick={onDismiss} variant="outline" size="sm">
          I&apos;ve saved it — dismiss
        </Button>
      </div>
    </div>
  );
}

// ─── List ────────────────────────────────────────────────────────────────

function KeysList({
  orgId,
  keys,
  mode,
  loading,
  error,
}: {
  orgId: string;
  keys: APIKeyView[] | undefined;
  mode: Tab;
  loading: boolean;
  error: Error | null;
}) {
  if (loading) {
    return (
      <div className={cn(card.panel, "p-4 space-y-2")}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (error) return <ErrorState title="Failed to load keys" />;
  if (!keys || keys.length === 0) {
    // Two distinct empty states: pre-first-key (Active, no history) is a
    // call-to-action; "no revoked keys" (Revoked tab) is informational.
    return mode === "active" ? (
      <EmptyState
        icon={KeyRound}
        title="No active keys"
        description="Generate your first key to start sending trace data from the SDK."
      />
    ) : (
      <EmptyState
        icon={KeyRound}
        title="No revoked keys"
        description="Revoked keys land here for the retention window before auto-delete."
      />
    );
  }
  return (
    <div className={cn(card.panel, "overflow-hidden")}>
      <table className="w-full text-sm">
        <thead className="bg-muted/40 border-b border-border">
          <tr className="text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            <th className="px-4 py-2">Name</th>
            <th className="px-4 py-2">Prefix</th>
            <th className="px-4 py-2">Scopes</th>
            <th className="px-4 py-2">Created</th>
            {/* Mode-aware columns: Active shows "Last used" because that's
                actionable signal; Revoked shows when the key was revoked
                and how long until it auto-deletes. The Status column is
                redundant on tabbed views (everything in Active is active,
                everything in Revoked is revoked) so we drop it. */}
            {mode === "active" ? (
              <th className="px-4 py-2">Last used</th>
            ) : (
              <>
                <th className="px-4 py-2">Revoked</th>
                <th className="px-4 py-2">Auto-delete</th>
              </>
            )}
            <th className="px-4 py-2 w-10" />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <KeyRow key={k.id} orgId={orgId} k={k} mode={mode} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyRow({
  orgId,
  k,
  mode,
}: {
  orgId: string;
  k: APIKeyView;
  mode: Tab;
}) {
  const revoke = useRevokeAPIKey(orgId);
  useApiError(revoke.error);

  // Revoked rows are dimmed — they're audit history, not operational state.
  const dim = k.revoked ? "opacity-60" : "";
  return (
    <tr className={cn("border-b border-border last:border-0", dim)}>
      <td className="px-4 py-2 font-medium">
        {k.name ?? <span className="text-muted-foreground italic">unnamed</span>}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
        {k.key_prefix ? `${k.key_prefix}…` : "—"}
      </td>
      <td className="px-4 py-2">
        {k.scopes.length === 0 ? (
          // Empty array on the wire = legacy NULL on the server = the key
          // predates the scopes column and is treated as fully-privileged.
          // Surface that explicitly rather than as an empty cell so the
          // operator can decide whether to rotate it.
          <span
            className={cn(statusPill.base, statusPill.warn)}
            title="Pre-scopes key — has full access. Rotate when convenient."
          >
            legacy
          </span>
        ) : (
          <span className="inline-flex flex-wrap gap-1">
            {k.scopes.map((s) => (
              <span
                key={s}
                className={cn(
                  statusPill.base,
                  // ingest:write is the safest scope and the default;
                  // traces:read grants read access to the entire dashboard
                  // API surface (not just literal traces) — broader blast
                  // radius, so it earns the info tone.
                  s === "traces:read" ? statusPill.info : statusPill.neutral,
                  "font-mono text-[9px]",
                )}
              >
                {s}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-muted-foreground">
        <RelativeTime date={k.created_at} />
      </td>

      {mode === "active" ? (
        <td className="px-4 py-2 text-muted-foreground">
          {k.last_used_at ? <RelativeTime date={k.last_used_at} /> : "—"}
        </td>
      ) : (
        <>
          <td className="px-4 py-2 text-muted-foreground">
            {k.revoked_at ? <RelativeTime date={k.revoked_at} /> : "—"}
          </td>
          <td className="px-4 py-2 text-muted-foreground">
            <AutoDeleteCountdown revokedAt={k.revoked_at} />
          </td>
        </>
      )}

      <td className="px-4 py-2 text-right">
        {mode === "active" && (
          <button
            onClick={() => {
              if (confirm(`Revoke "${k.name ?? k.key_prefix ?? k.id}"?\n\nApps using this key will start failing immediately — the dashboard pushes a 5-minute revocation marker to the auth cache so both ingest and the API stop accepting it now.`)) {
                revoke.mutate(k.id);
              }
            }}
            disabled={revoke.isPending}
            className="text-muted-foreground hover:text-red-700 dark:hover:text-red-300 transition-colors p-1"
            aria-label="Revoke key"
            title="Revoke key"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </td>
    </tr>
  );
}

/** Shows "in 27d" / "in 4h" / "any moment" until the cleanup goroutine
 *  permanently deletes a revoked key. Returns "—" for rows where
 *  revoked_at is NULL (legacy revoked rows that predate the column;
 *  cleanup deliberately skips these). */
function AutoDeleteCountdown({ revokedAt }: { revokedAt: string | null }) {
  if (!revokedAt) {
    return (
      <span title="No revoke timestamp recorded — this row stays until removed manually.">
        —
      </span>
    );
  }
  const revokedMs = new Date(revokedAt).getTime();
  const deletionMs = revokedMs + REVOKED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const remainingMs = deletionMs - Date.now();

  if (remainingMs <= 0) {
    // Cleanup runs hourly — between the threshold crossing and the next
    // tick the row is technically still here. Be honest about that.
    return <span className="text-amber-700 dark:text-amber-300">any moment</span>;
  }
  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return <span>in {days}d</span>;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  return <span>in {hours}h</span>;
}
