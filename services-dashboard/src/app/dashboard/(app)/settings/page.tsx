"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Check, Copy, Info, KeyRound, Plus, Trash2 } from "lucide-react";
import { useOrgId } from "@/lib/org-context";
import { useApiError } from "@/hooks/use-api-error";
import {
  useAPIKeys,
  useCreateAPIKey,
  useRevokeAPIKey,
  type APIKeyScope,
  type APIKeyView,
  type CreateKeyResponse,
} from "@/lib/queries/use-api-keys";
import { RelativeTime } from "@/components/shared/relative-time";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "../_components/confirm-dialog";

// v2 Settings → API Keys.
//
// Ports the retired API-keys page into the v2 chrome, reusing
// the same data layer (use-api-keys) and the same hard contract:
//
//   1. The raw token is shown EXACTLY ONCE, in the reveal banner after Create.
//      The server only ever stored a SHA-256 hash + public prefix.
//   2. Revoke is a soft-delete; the row stays under the Revoked tab (struck
//      through) for the retention window so re-keying is auditable.
//   3. Create/revoke are gated server-side on owner/admin; viewers get a 403
//      surfaced through the shared useApiError toast (no client role gate).

/** Retention window for revoked keys, in days. Kept in sync with the API's
 *  default (services-go/api/internal/apikeys/cleanup.go:DefaultRetentionDays). */
const REVOKED_RETENTION_DAYS = 30;

const PANEL = "rounded-xl ring-1 ring-foreground/10 bg-card";

type Tab = "active" | "revoked";

export default function V2SettingsPage() {
  const orgId = useOrgId();
  const keys = useAPIKeys(orgId ?? "", !!orgId);
  useApiError(keys.error, keys.refetch);

  const [tab, setTab] = useState<Tab>("active");
  const [showCreate, setShowCreate] = useState(false);
  const [createdToken, setCreatedToken] = useState<CreateKeyResponse | null>(null);

  // Partition once per render — the list is small (a handful of keys per org).
  const { active, revoked } = useMemo(() => {
    const a: APIKeyView[] = [];
    const r: APIKeyView[] = [];
    for (const k of keys.data ?? []) (k.revoked ? r : a).push(k);
    return { active: a, revoked: r };
  }, [keys.data]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-[11px] text-muted-foreground">
          API keys today — pricing tables, redaction rules &amp; org members are on the way.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">API Keys</h2>
          </div>
          {/* Generate only makes sense on Active — hide it on the Revoked tab. */}
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

        <p className="text-[11px] text-muted-foreground max-w-2xl leading-relaxed">
          Keys authenticate the SDK to the ingest endpoint. Every dashboard-minted key
          includes <span className="font-mono">ingest:write</span>; the{" "}
          <span className="font-mono">traces:read</span> scope is opt-in and grants
          additional access to the read API. Treat keys like passwords — anyone with
          one can write trace data to your org.
        </p>

        {/* Segmented Active / Revoked control with live counts. */}
        <div
          role="tablist"
          aria-label="Key state"
          className="inline-flex rounded-lg ring-1 ring-foreground/10 bg-muted/30 p-0.5"
        >
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

        {tab === "active" && showCreate && (
          <CreateKeyForm
            orgId={orgId ?? ""}
            onCreated={(resp) => {
              setCreatedToken(resp);
              setShowCreate(false);
            }}
          />
        )}

        {/* Reveal banner persists across tab switches so a revoke side-trip
            never costs the user the one-time token. */}
        {createdToken && (
          <NewKeyReveal response={createdToken} onDismiss={() => setCreatedToken(null)} />
        )}

        {tab === "revoked" && revoked.length > 0 && <RetentionNote />}

        <KeysList
          orgId={orgId ?? ""}
          keys={tab === "active" ? active : revoked}
          mode={tab}
          loading={keys.isPending}
          error={keys.isError}
        />
      </section>
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
        "px-3 py-1 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5 focus-ring",
        selected
          ? "bg-surface-active text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
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

function RetentionNote() {
  return (
    <div className={cn(PANEL, "px-3 py-2.5 flex items-start gap-2 bg-muted/20")}>
      <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <p className="text-[11px] text-muted-foreground">
        Revoked keys are kept for{" "}
        <span className="font-medium text-foreground">{REVOKED_RETENTION_DAYS} days</span> for
        audit, then permanently deleted. Pre-existing revoked keys without a recorded revoke
        time stay until you remove them manually.
      </p>
    </div>
  );
}

// ─── Create form ───────────────────────────────────────────────────────────

function CreateKeyForm({
  orgId,
  onCreated,
}: {
  orgId: string;
  onCreated: (resp: CreateKeyResponse) => void;
}) {
  const [name, setName] = useState("");
  // Default to ingest-only: the typical caller is an SDK shipping events. Read
  // access is an explicit opt-in because it broadens a leaked key's blast
  // radius from "spam our ingest" to "exfiltrate our trace data".
  const [allowRead, setAllowRead] = useState(false);
  const create = useCreateAPIKey(orgId);
  useApiError(create.error);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const scopes: APIKeyScope[] = allowRead ? ["ingest:write", "traces:read"] : ["ingest:write"];
    const resp = await create.mutateAsync({ name, scopes });
    setName("");
    setAllowRead(false);
    onCreated(resp);
  }

  return (
    <form onSubmit={submit} className={cn(PANEL, "p-4 space-y-3")}>
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
          className="w-full bg-background ring-1 ring-foreground/10 rounded-md px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <p className="text-[11px] text-muted-foreground mt-1">
          A label only — purely for your reference in this list.
        </p>
      </div>

      <div className="space-y-2">
        <span className="text-xs font-medium block">Permissions</span>
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded px-1.5 py-0.5 text-[10px] font-mono ring-1 ring-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            ingest:write
          </span>
          <span className="text-[11px] text-muted-foreground">on every key</span>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={allowRead}
            onChange={(e) => setAllowRead(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
          />
          <span>
            Also allow read API access (
            <span className="font-mono text-xs">traces:read</span>)
            <span className="block text-[11px] text-muted-foreground">
              Grants this key the same read access the dashboard has: traces, costs,
              prompts, sessions, saved views, alerts, and the rest of the dashboard API
              surface. Leave off for SDK-only keys — that&apos;s the safer default.
            </span>
          </span>
        </label>
      </div>

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? "Generating…" : "Generate key"}
        </Button>
      </div>
    </form>
  );
}

// ─── One-time token reveal ───────────────────────────────────────────────────

function NewKeyReveal({
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
    <div className="rounded-xl ring-2 ring-amber-500/60 bg-amber-500/10 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <KeyRound className="h-4 w-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Copy your new key now</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            ScopeCall only stores a hash — we can&apos;t show you this token again after you
            dismiss this banner.
          </p>
        </div>
      </div>
      <div className="relative">
        <pre className="font-mono text-xs bg-background ring-1 ring-foreground/10 rounded-md px-3 py-2.5 overflow-x-auto">
          {response.raw_token}
        </pre>
        <button
          onClick={copy}
          className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-background ring-1 ring-foreground/10 hover:bg-surface-hover transition-colors focus-ring"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy
            </>
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

// ─── List ────────────────────────────────────────────────────────────────────

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
  error: boolean;
}) {
  if (loading) {
    return (
      <div className={cn(PANEL, "p-4 space-y-2")}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-8 rounded-md bg-muted/30 animate-pulse" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className={cn(PANEL, "p-10 text-center")}>
        <p className="text-sm font-medium">Couldn&apos;t load keys</p>
        <p className="text-[11px] text-muted-foreground mt-1">
          The read API didn&apos;t respond. Retry in a moment.
        </p>
      </div>
    );
  }
  if (!keys || keys.length === 0) {
    // Pre-first-key (Active) is a call-to-action; "no revoked" is informational.
    return (
      <div className={cn(PANEL, "p-10 text-center")}>
        <div className="size-10 rounded-full bg-muted/40 flex items-center justify-center mx-auto mb-3">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">
          {mode === "active" ? "No active keys" : "No revoked keys"}
        </p>
        <p className="text-[11px] text-muted-foreground mt-1 max-w-sm mx-auto">
          {mode === "active"
            ? "Generate your first key to start sending trace data from the SDK."
            : "Revoked keys land here for the retention window before auto-delete."}
        </p>
      </div>
    );
  }
  return (
    <div className={cn(PANEL, "overflow-hidden")}>
      <table className="w-full text-sm">
        <thead className="bg-muted/30 border-b border-border">
          <tr className="text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            <th className="px-4 py-2">Name</th>
            <th className="px-4 py-2">Prefix</th>
            <th className="px-4 py-2">Scopes</th>
            <th className="px-4 py-2">Created</th>
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

function KeyRow({ orgId, k, mode }: { orgId: string; k: APIKeyView; mode: Tab }) {
  const revoke = useRevokeAPIKey(orgId);
  useApiError(revoke.error);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const keyLabel = k.name ?? k.key_prefix ?? k.id;

  return (
    <tr className={cn("border-b border-border last:border-0", k.revoked && "opacity-60")}>
      <td className="px-4 py-2 font-medium">
        {k.name ?? <span className="text-muted-foreground italic">unnamed</span>}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
        {k.key_prefix ? `${k.key_prefix}…` : "—"}
      </td>
      <td className="px-4 py-2">
        {k.scopes.length === 0 ? (
          // Empty array = legacy NULL scopes = pre-scopes key, fully privileged.
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-mono ring-1 ring-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
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
                  "rounded px-1.5 py-0.5 text-[10px] font-mono ring-1",
                  // traces:read grants read access to the whole dashboard API
                  // surface — broader blast radius, so it gets the info tone.
                  s === "traces:read"
                    ? "ring-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                    : "ring-foreground/15 bg-muted/40 text-muted-foreground",
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
          <>
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={revoke.isPending}
              className="rounded text-muted-foreground hover:text-red-700 dark:hover:text-red-300 transition-colors p-1 focus-ring"
              aria-label="Revoke key"
              title="Revoke key"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              destructive
              icon={<Trash2 />}
              title={`Revoke “${keyLabel}”?`}
              description="Apps using this key will start failing immediately — a 5-minute revocation marker is pushed to the auth cache so both ingest and the API stop accepting it now."
              confirmLabel="Revoke key"
              busy={revoke.isPending}
              onConfirm={() => revoke.mutate(k.id, { onSuccess: () => setConfirmOpen(false) })}
            />
          </>
        )}
      </td>
    </tr>
  );
}

/** "in 27d" / "in 4h" / "any moment" until the cleanup goroutine deletes a
 *  revoked key. Returns "—" for legacy rows with NULL revoked_at (cleanup
 *  deliberately skips those). */
function AutoDeleteCountdown({ revokedAt }: { revokedAt: string | null }) {
  if (!revokedAt) {
    return (
      <span title="No revoke timestamp recorded — this row stays until removed manually.">—</span>
    );
  }
  const deletionMs = new Date(revokedAt).getTime() + REVOKED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const remainingMs = deletionMs - Date.now();
  if (remainingMs <= 0) {
    return <span className="text-amber-700 dark:text-amber-300">any moment</span>;
  }
  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return <span>in {days}d</span>;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  return <span>in {hours}h</span>;
}
