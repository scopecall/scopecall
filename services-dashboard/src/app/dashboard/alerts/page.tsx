"use client";

import { useState } from "react";
import { Bell, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import {
  useAlertEvents,
  useAlertEventTraces,
  useAlertRules,
  useCreateAlertRule,
  useDeleteAlertRule,
  useToggleAlertRule,
  type AlertEvent,
  type RuleType,
  type ChannelType,
} from "@/lib/queries/use-alerts";
import { useApiError } from "@/hooks/use-api-error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/shared/relative-time";
import { ErrorState } from "@/components/shared/error-state";
import { card, statusPill } from "@/lib/design";
import { EmptyState } from "@/components/shared/empty-state";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

const RULE_LABEL: Record<RuleType, string> = {
  cost_spike: "Cost spike (USD)",
  error_rate: "Error rate (%)",
  latency_p99: "P99 latency (ms)",
};

// Display the rule's threshold/value in the right unit. cost_spike values are
// dollars, the rest are dimensionless / ms.
function fmtValue(type: RuleType, v: number): string {
  switch (type) {
    case "cost_spike": return money(v);
    case "error_rate": return `${v.toFixed(2)}%`;
    case "latency_p99": return `${Math.round(v)}ms`;
  }
}

export default function AlertsPage() {
  useDocumentTitle("Alerts");
  const rules = useAlertRules();
  const events = useAlertEvents();
  useApiError(rules.error ?? events.error);

  const [showCreate, setShowCreate] = useState(false);

  const openCount = (events.data ?? []).filter((e) => !e.resolved_at).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Alerts</h1>
          {openCount > 0 && (
            <span className={cn(statusPill.base, statusPill.error)}>
              {openCount} firing
            </span>
          )}
        </div>
        <Button onClick={() => setShowCreate(!showCreate)} variant={showCreate ? "outline" : "default"} size="sm">
          <Plus className="h-4 w-4" />
          {showCreate ? "Cancel" : "New rule"}
        </Button>
      </div>

      {showCreate && <CreateRuleForm onCreated={() => setShowCreate(false)} />}

      <RulesList onOpenCreate={() => setShowCreate(true)} />

      <div className="pt-2">
        <h2 className="text-sm font-semibold mb-2">Recent events</h2>
        <EventsList />
      </div>
    </div>
  );
}

function RulesList({ onOpenCreate }: { onOpenCreate: () => void }) {
  const { data, isLoading } = useAlertRules();
  const toggle = useToggleAlertRule();
  const del = useDeleteAlertRule();

  if (isLoading) {
    return (
      <div className="border border-border rounded-md p-4 space-y-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }
  const rules = data ?? [];
  if (rules.length === 0) {
    return (
      <div className={card.dashed}>
        <EmptyState
          icon={Bell}
          title="No alert rules yet"
          description="Define a rule for cost spikes, error-rate jumps, or latency regressions. We'll watch every minute and fire when a threshold is crossed."
          action={{ label: "New rule", onClick: onOpenCreate }}
        />
      </div>
    );
  }

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Threshold</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Window</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Channel</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground w-32">Status</th>
            <th className="px-3 py-2 w-10"></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className="border-b border-border last:border-0">
              <td className="px-3 py-2.5 font-medium">{r.name}</td>
              <td className="px-3 py-2.5 text-muted-foreground">{RULE_LABEL[r.type]}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtValue(r.type, r.threshold)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{r.window_seconds}s</td>
              <td className="px-3 py-2.5 text-muted-foreground">{r.channel_type === "none" ? "—" : r.channel_type}</td>
              <td className="px-3 py-2.5 text-right">
                <button
                  onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border",
                    r.enabled
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : "border-border text-muted-foreground",
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", r.enabled ? "bg-emerald-400" : "bg-muted-foreground")} />
                  {r.enabled ? "Enabled" : "Paused"}
                </button>
              </td>
              <td className="px-3 py-2.5 text-right">
                <button
                  onClick={() => { if (confirm(`Delete rule "${r.name}"?`)) del.mutate(r.id); }}
                  className="text-muted-foreground hover:text-red-400 transition-colors"
                  title="Delete rule"
                  aria-label="Delete rule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateRuleForm({ onCreated }: { onCreated: () => void }) {
  const create = useCreateAlertRule();
  const [name, setName] = useState("");
  const [type, setType] = useState<RuleType>("cost_spike");
  const [threshold, setThreshold] = useState("");
  const [windowSeconds, setWindowSeconds] = useState("600");
  const [channelType, setChannelType] = useState<ChannelType>("none");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const t = parseFloat(threshold);
    const w = parseInt(windowSeconds, 10);
    if (!name.trim()) { setErr("Name is required"); return; }
    if (!Number.isFinite(t)) { setErr("Threshold must be a number"); return; }
    if (!Number.isFinite(w) || w < 60 || w > 86400) { setErr("Window must be between 60 and 86400 seconds"); return; }
    if (channelType === "slack" && !webhookUrl.trim()) { setErr("Slack webhook URL is required"); return; }
    try {
      await create.mutateAsync({
        name: name.trim(),
        type,
        threshold: t,
        window_seconds: w,
        channel_type: channelType,
        channel_config: channelType === "slack" ? { webhook_url: webhookUrl.trim() } : {},
        enabled: true,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create rule");
    }
  }

  // Threshold hint depends on the rule type so users know what unit to enter.
  const thresholdHint =
    type === "cost_spike" ? "USD (e.g. 10 = $10)" :
    type === "error_rate" ? "percent (e.g. 5 = 5%)" :
    "milliseconds (e.g. 2000)";

  return (
    <form onSubmit={submit} className="border border-border rounded-md p-4 bg-card space-y-3">
      <h3 className="text-sm font-semibold">New alert rule</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Prod error rate"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm h-9 focus:outline-none focus:border-ring"
          />
        </Field>
        <Field label="Type">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as RuleType)}
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm h-9 focus:outline-none focus:border-ring"
          >
            <option value="cost_spike">Cost spike (sum over window)</option>
            <option value="error_rate">Error rate (% over window)</option>
            <option value="latency_p99">P99 latency (ms over window)</option>
          </select>
        </Field>
        <Field label="Threshold" hint={thresholdHint}>
          <input
            type="number"
            step="any"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm h-9 focus:outline-none focus:border-ring"
          />
        </Field>
        <Field label="Window (seconds)" hint="60 – 86400">
          <input
            type="number"
            value={windowSeconds}
            onChange={(e) => setWindowSeconds(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm h-9 focus:outline-none focus:border-ring"
          />
        </Field>
        <Field label="Channel">
          <select
            value={channelType}
            onChange={(e) => setChannelType(e.target.value as ChannelType)}
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm h-9 focus:outline-none focus:border-ring"
          >
            <option value="none">None (store events only)</option>
            <option value="slack">Slack webhook</option>
          </select>
        </Field>
        {channelType === "slack" && (
          <Field label="Slack webhook URL">
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/..."
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm h-9 focus:outline-none focus:border-ring"
            />
          </Field>
        )}
      </div>
      {err && <p className="text-sm text-red-400">{err}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create rule"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-muted-foreground italic">{hint}</span>}
    </label>
  );
}

function EventsList() {
  const { data, isLoading } = useAlertEvents();
  if (isLoading) {
    return (
      <div className="border border-border rounded-md p-4 space-y-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }
  const events = data ?? [];
  if (events.length === 0) {
    return (
      <div className={card.dashed}>
        <EmptyState
          icon={CheckCircle2}
          title="All quiet"
          description="No alerts have fired. Events show up here in real time when a rule crosses its threshold."
        />
      </div>
    );
  }
  return (
    <ul className="border border-border rounded-md divide-y divide-border bg-card">
      {events.map((e) => <EventItem key={e.id} event={e} />)}
    </ul>
  );
}

// EventItem renders one alert event with an expandable section for the
// sample offending traces. The traces fetch is lazy — only fires when the
// row is expanded — so the events list itself stays cheap.
function EventItem({ event: e }: { event: AlertEvent }) {
  const [expanded, setExpanded] = useState(false);
  const isOpen = !e.resolved_at;
  return (
    <li className="bg-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/40 transition-colors"
      >
        <span className="text-muted-foreground shrink-0">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <span
          className={cn(
            "size-2 rounded-full shrink-0",
            isOpen ? "bg-red-400 animate-pulse" : "bg-emerald-400",
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{e.rule_name}</span>
            <span className={cn(statusPill.base, isOpen ? statusPill.error : statusPill.ok)}>
              {isOpen ? "OPEN" : "RESOLVED"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{e.message}</p>
        </div>
        <div className="text-right text-xs text-muted-foreground whitespace-nowrap shrink-0">
          <RelativeTime date={e.fired_at} />
          {e.resolved_at && <span className="block">resolved <RelativeTime date={e.resolved_at} /></span>}
        </div>
      </button>
      {expanded && <EventSampleTraces eventId={e.id} />}
    </li>
  );
}

// EventSampleTraces fetches and renders the top offending traces from the
// rule's evaluation window. Mounted only when the parent row is expanded,
// so we don't hammer the API for events the user never inspects.
function EventSampleTraces({ eventId }: { eventId: string }) {
  const { data, isLoading, error } = useAlertEventTraces(eventId);

  if (isLoading) {
    return (
      <div className="px-4 pb-3 pl-12 space-y-2">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-4 pb-3 pl-12">
        <ErrorState
          variant="inline"
          title="Couldn't load sample traces"
          error={error}
        />
      </div>
    );
  }
  const traces = data?.traces ?? [];
  if (traces.length === 0) {
    return (
      <p className="px-4 pb-3 pl-12 text-xs text-muted-foreground italic">
        No matching traces in the evaluation window — the metric may have
        been driven by aggregated rollup data only.
      </p>
    );
  }
  const windowMin = data?.window_seconds ? Math.round(data.window_seconds / 60) : 0;

  return (
    <div className="px-4 pb-3 pl-12">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        Top {traces.length} offending trace{traces.length === 1 ? "" : "s"}
        {windowMin > 0 && ` · last ${windowMin}m before fire`}
      </p>
      <div className="border border-border rounded-md divide-y divide-border bg-background/40">
        {traces.map((t) => (
          <Link
            key={t.trace_id + t.span_id}
            href={`/dashboard/traces/${t.trace_id}?span=${t.span_id}`}
            className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-muted/40 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-foreground/90 truncate">{t.trace_id.slice(0, 12)}…</span>
                <span className={cn(
                  statusPill.base,
                  t.status === "error" ? statusPill.error :
                  t.status === "timeout" ? statusPill.warn :
                  statusPill.ok,
                )}>
                  {t.status}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                {t.feature_name ? `${t.feature_name} · ` : ""}{t.model}
              </p>
            </div>
            <div className="text-right text-[10px] text-muted-foreground tabular-nums shrink-0">
              <div>{money(t.cost_usd)} · {t.latency_ms}ms</div>
              {t.error_count > 0 && <div className="text-red-400">{t.error_count} err</div>}
            </div>
            <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}
