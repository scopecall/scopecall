"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Bell,
  BellRing,
  CheckCircle2,
  ChevronRight,
  DollarSign,
  ExternalLink,
  Gauge,
  Plus,
  Trash2,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useAlertEventTraces,
  useAlertEvents,
  useAlertRules,
  useCreateAlertRule,
  useDeleteAlertRule,
  useToggleAlertRule,
  type AlertEvent,
  type AlertRule,
  type ChannelType,
  type RuleType,
} from "@/lib/queries/use-alerts";
import { useApiError } from "@/hooks/use-api-error";
import { RelativeTime } from "@/components/shared/relative-time";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "../_components/confirm-dialog";

// v2 Alerts.
//
// Ports the retired standalone Alerts page into the v2 chrome on the same data
// layer (use-alerts). The evaluator runs server-side every minute; this page is
// purely the control surface: define rules, toggle them, and triage fires.
//
// One v2-specific affordance: an event's offending traces deep-link to
//   /dashboard/traces?trace=<trace_id>
// which the traces page reads on mount to auto-open the detail drawer (see the
// openTraceId initializer + URL-sync there). Classic linked to a standalone
// /dashboard/traces/<id> route; v2 has no such route — the drawer is the detail.

const PANEL = "rounded-xl ring-1 ring-foreground/10 bg-card";
const INPUT =
  "w-full bg-background ring-1 ring-foreground/10 rounded-md px-3 py-1.5 text-sm h-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

const RULE_LABEL: Record<RuleType, string> = {
  cost_spike: "Cost spike",
  error_rate: "Error rate",
  latency_p99: "P99 latency",
};

const RULE_META: Record<RuleType, { icon: LucideIcon; blurb: string; placeholder: string }> = {
  cost_spike: { icon: DollarSign, blurb: "Total spend over the window", placeholder: "10" },
  error_rate: { icon: AlertTriangle, blurb: "% of calls that errored", placeholder: "5" },
  latency_p99: { icon: Gauge, blurb: "99th-percentile response time", placeholder: "2000" },
};

// Window presets cover the useful spectrum: tight burst-detection windows up to
// a rolling day. Custom values outside these still validate (60s – 86400s).
const WINDOW_PRESETS: { label: string; value: number }[] = [
  { label: "5m", value: 300 },
  { label: "10m", value: 600 },
  { label: "30m", value: 1800 },
  { label: "1h", value: 3600 },
  { label: "6h", value: 21600 },
  { label: "24h", value: 86400 },
];

// Render a rule's threshold/value in its native unit. cost_spike is dollars;
// error_rate is a percentage; latency_p99 is milliseconds.
function fmtValue(type: RuleType, v: number): string {
  switch (type) {
    case "cost_spike":
      return money(v);
    case "error_rate":
      return `${v.toFixed(2)}%`;
    case "latency_p99":
      return `${Math.round(v).toLocaleString()}ms`;
  }
}

// Compact window label for the rules table ("10m", "1h", "24h").
function fmtWindow(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// Spoken-form window for the live preview sentence ("10-minute", "1-hour").
function humanWindow(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  if (seconds % 60 === 0) return `${seconds / 60}-minute`;
  return `${seconds}-second`;
}

export default function V2AlertsPage() {
  const rules = useAlertRules();
  const events = useAlertEvents();
  useApiError(rules.error ?? events.error, rules.refetch);

  const [showCreate, setShowCreate] = useState(false);

  const ruleList = rules.data ?? [];
  const eventList = events.data ?? [];
  const openCount = eventList.filter((e) => !e.resolved_at).length;
  const enabledCount = ruleList.filter((r) => r.enabled).length;
  const resolvedCount = eventList.filter((e) => e.resolved_at).length;

  return (
    <div className="space-y-5">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg font-semibold">Alerts</h1>
            {openCount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300">
                <BellRing className="h-3 w-3 animate-pulse" />
                {openCount} firing
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" />
                All clear
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 max-w-xl">
            Watch spend, error rate and latency. We evaluate every minute and fire the moment a
            threshold is crossed.
          </p>
        </div>
        <Button
          onClick={() => setShowCreate((s) => !s)}
          variant={showCreate ? "outline" : "default"}
          size="sm"
        >
          <Plus className="h-4 w-4" />
          {showCreate ? "Cancel" : "New rule"}
        </Button>
      </div>

      {/* ── Stat strip ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={BellRing}
          label="Firing now"
          value={openCount}
          valueClass={openCount > 0 ? "text-red-600 dark:text-red-400" : undefined}
          loading={events.isPending}
        />
        <Stat
          icon={Bell}
          label="Active rules"
          value={enabledCount}
          sub={ruleList.length ? `of ${ruleList.length}` : undefined}
          loading={rules.isPending}
        />
        <Stat icon={Activity} label="Recent events" value={eventList.length} loading={events.isPending} />
        <Stat
          icon={CheckCircle2}
          label="Resolved"
          value={resolvedCount}
          valueClass={resolvedCount > 0 ? "text-emerald-600 dark:text-emerald-400" : undefined}
          loading={events.isPending}
        />
      </div>

      {showCreate && <CreateRuleForm onCreated={() => setShowCreate(false)} />}

      {/* ── Rules ────────────────────────────────────────────────────────── */}
      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          Rules
        </h2>
        <RulesList rules={ruleList} loading={rules.isPending} onOpenCreate={() => setShowCreate(true)} />
      </section>

      {/* ── Events feed ──────────────────────────────────────────────────── */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Recent events
          </h2>
          {events.isFetching && !events.isPending && (
            <span className="text-[10px] text-muted-foreground">refreshing…</span>
          )}
        </div>
        <EventsList events={eventList} loading={events.isPending} />
      </section>
    </div>
  );
}

// ─── Stat card ───────────────────────────────────────────────────────────────

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  valueClass,
  loading,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  sub?: string;
  valueClass?: string;
  loading: boolean;
}) {
  return (
    <div className={cn(PANEL, "px-4 py-3")}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      {loading ? (
        <div className="mt-1.5 h-7 w-12 rounded bg-muted/40 animate-pulse" />
      ) : (
        <div className={cn("mt-0.5 text-2xl font-semibold tabular-nums", valueClass)}>
          {value}
          {sub && <span className="text-xs font-normal text-muted-foreground ml-1.5">{sub}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Create form ─────────────────────────────────────────────────────────────

function CreateRuleForm({ onCreated }: { onCreated: () => void }) {
  const create = useCreateAlertRule();
  const [name, setName] = useState("");
  const [type, setType] = useState<RuleType>("cost_spike");
  const [threshold, setThreshold] = useState("");
  const [windowSeconds, setWindowSeconds] = useState(600);
  const [channelType, setChannelType] = useState<ChannelType>("none");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const t = parseFloat(threshold);
    if (!name.trim()) return setErr("Give the rule a name.");
    if (!Number.isFinite(t) || t <= 0) return setErr("Enter a threshold greater than zero.");
    if (windowSeconds < 60 || windowSeconds > 86400) return setErr("Window must be 1 minute – 24 hours.");
    if (channelType === "slack" && !webhookUrl.trim()) return setErr("Add the Slack webhook URL.");
    try {
      await create.mutateAsync({
        name: name.trim(),
        type,
        threshold: t,
        window_seconds: windowSeconds,
        channel_type: channelType,
        channel_config: channelType === "slack" ? { webhook_url: webhookUrl.trim() } : {},
        enabled: true,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create the rule.");
    }
  }

  return (
    <form onSubmit={submit} className={cn(PANEL, "p-4 space-y-4")}>
      <h3 className="text-sm font-semibold">New alert rule</h3>

      {/* Metric picker — cards so the choice (and its meaning) is obvious. */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium">Metric</span>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {(Object.keys(RULE_META) as RuleType[]).map((rt) => {
            const m = RULE_META[rt];
            const active = type === rt;
            return (
              <button
                key={rt}
                type="button"
                onClick={() => setType(rt)}
                aria-pressed={active}
                className={cn(
                  "flex items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors focus-ring",
                  active
                    ? "ring-2 ring-primary bg-primary/5"
                    : "ring-1 ring-foreground/10 hover:bg-surface-hover",
                )}
              >
                <m.icon
                  className={cn("h-4 w-4 mt-0.5 shrink-0", active ? "text-primary" : "text-muted-foreground")}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{RULE_LABEL[rt]}</span>
                  <span className="block text-[11px] text-muted-foreground leading-tight">{m.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Name + unit-aware threshold. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Prod cost spike"
            maxLength={80}
            className={INPUT}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">Threshold</span>
          <div className="relative">
            {type === "cost_spike" && (
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
            )}
            <input
              type="number"
              step="any"
              min="0"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder={RULE_META[type].placeholder}
              className={cn(
                INPUT,
                type === "cost_spike" && "pl-6",
                (type === "error_rate" || type === "latency_p99") && "pr-10",
              )}
            />
            {type === "error_rate" && (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                %
              </span>
            )}
            {type === "latency_p99" && (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                ms
              </span>
            )}
          </div>
        </label>
      </div>

      {/* Evaluation window presets. */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium">Evaluation window</span>
        <div className="inline-flex flex-wrap gap-0.5 rounded-lg ring-1 ring-foreground/10 bg-muted/30 p-0.5">
          {WINDOW_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setWindowSeconds(p.value)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors tabular-nums focus-ring",
                windowSeconds === p.value
                  ? "bg-surface-active text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-surface-hover",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Channel. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium">Notify</span>
          <select
            value={channelType}
            onChange={(e) => setChannelType(e.target.value as ChannelType)}
            className={INPUT}
          >
            <option value="none">Log only (store events)</option>
            <option value="slack">Slack webhook</option>
          </select>
        </label>
        {channelType === "slack" && (
          <label className="block space-y-1">
            <span className="text-xs font-medium">Slack webhook URL</span>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              className={INPUT}
            />
          </label>
        )}
      </div>

      {/* Live preview — restate the rule in plain language before they commit. */}
      <div className="rounded-lg bg-muted/30 ring-1 ring-foreground/10 px-3 py-2 text-[12px] text-muted-foreground flex items-start gap-2">
        <Zap className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-500" />
        <span>
          Fire when{" "}
          <strong className="font-medium text-foreground">
            {type === "cost_spike" ? "total spend" : type === "error_rate" ? "the error rate" : "P99 latency"}
          </strong>{" "}
          exceeds{" "}
          <strong className="font-medium text-foreground">
            {Number.isFinite(parseFloat(threshold)) && parseFloat(threshold) > 0
              ? fmtValue(type, parseFloat(threshold))
              : "a threshold"}
          </strong>{" "}
          in any <strong className="font-medium text-foreground">{humanWindow(windowSeconds)}</strong> window,
          then{" "}
          <strong className="font-medium text-foreground">
            {channelType === "slack" ? "post to Slack" : "log an event"}
          </strong>
          .
        </span>
      </div>

      {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create rule"}
        </Button>
      </div>
    </form>
  );
}

// ─── Rules list ──────────────────────────────────────────────────────────────

function RulesList({
  rules,
  loading,
  onOpenCreate,
}: {
  rules: AlertRule[];
  loading: boolean;
  onOpenCreate: () => void;
}) {
  if (loading) {
    return (
      <div className={cn(PANEL, "p-4 space-y-2")}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 rounded-md bg-muted/30 animate-pulse" />
        ))}
      </div>
    );
  }
  if (rules.length === 0) {
    return (
      <div className={cn(PANEL, "p-10 text-center")}>
        <div className="size-10 rounded-full bg-muted/40 flex items-center justify-center mx-auto mb-3">
          <Bell className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No alert rules yet</p>
        <p className="text-[11px] text-muted-foreground mt-1 max-w-sm mx-auto">
          Define a rule for cost spikes, error-rate jumps, or latency regressions. We evaluate every
          minute and fire the moment a threshold is crossed.
        </p>
        <div className="mt-4">
          <Button size="sm" onClick={onOpenCreate}>
            <Plus className="h-4 w-4" />
            New rule
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className={cn(PANEL, "overflow-hidden")}>
      <div className="max-h-[28rem] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/30 border-b border-border sticky top-0 z-10">
          <tr className="text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            <th className="px-4 py-2">Rule</th>
            <th className="px-4 py-2">Metric</th>
            <th className="px-4 py-2 text-right">Threshold</th>
            <th className="px-4 py-2 text-right">Window</th>
            <th className="px-4 py-2">Channel</th>
            <th className="px-4 py-2 text-center w-32">Status</th>
            <th className="px-4 py-2 w-10" />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} />
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function RuleRow({ rule: r }: { rule: AlertRule }) {
  const toggle = useToggleAlertRule();
  const del = useDeleteAlertRule();
  useApiError(toggle.error ?? del.error);
  const Icon = RULE_META[r.type].icon;
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-2.5 font-medium">{r.name}</td>
      <td className="px-4 py-2.5">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {RULE_LABEL[r.type]}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">{fmtValue(r.type, r.threshold)}</td>
      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtWindow(r.window_seconds)}</td>
      <td className="px-4 py-2.5">
        {r.channel_type === "slack" ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Webhook className="h-3.5 w-3.5" />
            Slack
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center justify-center gap-2">
          <Switch
            checked={r.enabled}
            disabled={toggle.isPending}
            onChange={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
            label={`${r.enabled ? "Pause" : "Enable"} ${r.name}`}
          />
          <span
            className={cn(
              "text-[11px] w-11",
              r.enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
            )}
          >
            {r.enabled ? "Active" : "Paused"}
          </span>
        </div>
      </td>
      <td className="px-4 py-2.5 text-right">
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={del.isPending}
          className="rounded p-1 -m-1 text-muted-foreground hover:text-red-500 transition-colors disabled:opacity-50 focus-ring"
          title="Delete rule"
          aria-label={`Delete ${r.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          destructive
          icon={<Trash2 />}
          title={`Delete “${r.name}”?`}
          description="This rule will stop evaluating immediately and be permanently removed. This can't be undone."
          confirmLabel="Delete rule"
          busy={del.isPending}
          onConfirm={() => del.mutate(r.id, { onSuccess: () => setConfirmOpen(false) })}
        />
      </td>
    </tr>
  );
}

// iOS-style toggle. role="switch" + aria-checked keeps it accessible.
function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus-ring",
        checked ? "bg-emerald-500" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// ─── Events feed ─────────────────────────────────────────────────────────────

function EventsList({ events, loading }: { events: AlertEvent[]; loading: boolean }) {
  if (loading) {
    return (
      <div className={cn(PANEL, "p-4 space-y-2")}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-10 rounded-md bg-muted/30 animate-pulse" />
        ))}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className={cn(PANEL, "p-10 text-center")}>
        <div className="size-10 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <p className="text-sm font-medium">All quiet</p>
        <p className="text-[11px] text-muted-foreground mt-1 max-w-sm mx-auto">
          No alerts have fired. Events appear here in real time when a rule crosses its threshold.
        </p>
      </div>
    );
  }
  return (
    <div className={cn(PANEL, "divide-y divide-border overflow-x-hidden overflow-y-auto max-h-[32rem]")}>
      {events.map((e) => (
        <EventItem key={e.id} event={e} />
      ))}
    </div>
  );
}

// One event row, expandable to reveal the offending traces. The traces fetch is
// lazy (only when expanded) so the feed itself stays cheap.
function EventItem({ event: e }: { event: AlertEvent }) {
  const [expanded, setExpanded] = useState(false);
  const isOpen = !e.resolved_at;
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full px-4 py-3 flex items-center gap-3 text-left row-interactive"
      >
        <ChevronRight
          className={cn("h-4 w-4 text-muted-foreground shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <span
          className={cn("size-2 rounded-full shrink-0", isOpen ? "bg-red-500 animate-pulse" : "bg-emerald-500")}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{e.rule_name}</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium ring-1",
                isOpen
                  ? "ring-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                  : "ring-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              )}
            >
              {isOpen ? "OPEN" : "RESOLVED"}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{e.message}</p>
        </div>
        <div className="text-right text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
          <RelativeTime date={e.fired_at} />
          {e.resolved_at && (
            <span className="block">
              resolved <RelativeTime date={e.resolved_at} />
            </span>
          )}
        </div>
      </button>
      {expanded && <EventSampleTraces eventId={e.id} />}
    </div>
  );
}

function EventSampleTraces({ eventId }: { eventId: string }) {
  const { data, isPending, error } = useAlertEventTraces(eventId);

  if (isPending) {
    return (
      <div className="px-4 pb-3 pl-[3.25rem] space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 rounded-md bg-muted/30 animate-pulse" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <p className="px-4 pb-3 pl-[3.25rem] text-[11px] text-red-600 dark:text-red-400">
        Couldn&apos;t load sample traces — retry in a moment.
      </p>
    );
  }
  const traces = data?.traces ?? [];
  if (traces.length === 0) {
    return (
      <p className="px-4 pb-3 pl-[3.25rem] text-[11px] text-muted-foreground italic">
        No matching traces in the evaluation window — the metric was driven by rollup data only.
      </p>
    );
  }
  const windowMin = data?.window_seconds ? Math.round(data.window_seconds / 60) : 0;

  return (
    <div className="px-4 pb-3 pl-[3.25rem]">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        Top {traces.length} offending trace{traces.length === 1 ? "" : "s"}
        {windowMin > 0 && ` · last ${windowMin}m before fire`}
      </p>
      <div className="rounded-lg ring-1 ring-foreground/10 divide-y divide-border overflow-hidden bg-background/40">
        {traces.map((t) => (
          <Link
            key={t.trace_id + t.span_id}
            href={`/dashboard/traces?trace=${t.trace_id}`}
            className="group flex items-center gap-3 px-3 py-2 text-xs row-interactive"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-foreground/90 truncate">{t.trace_id.slice(0, 12)}…</span>
                <TraceStatusPill status={t.status} />
              </div>
              <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                {t.feature_name ? `${t.feature_name} · ` : ""}
                {t.model}
              </p>
            </div>
            <div className="text-right text-[10px] text-muted-foreground tabular-nums shrink-0">
              <div>
                {money(t.cost_usd)} · {t.latency_ms.toLocaleString()}ms
              </div>
              {t.error_count > 0 && <div className="text-red-500">{t.error_count} err</div>}
            </div>
            <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 group-hover:text-foreground transition-colors" />
          </Link>
        ))}
      </div>
    </div>
  );
}

function TraceStatusPill({ status }: { status: string }) {
  const tone =
    status === "error"
      ? "ring-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
      : status === "timeout" || status === "rate_limited"
        ? "ring-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "ring-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium ring-1", tone)}>{status}</span>;
}
