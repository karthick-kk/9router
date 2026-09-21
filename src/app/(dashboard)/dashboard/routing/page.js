"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Area,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Card, Select, Input, Toggle, SegmentedControl, CardSkeleton } from "@/shared/components";
import TrajectoryTimeline from "./components/TrajectoryTimeline";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "all", label: "All" },
];

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "trajectories", label: "Trajectories" },
  { value: "models", label: "Models" },
];

// "All combos" sentinel for the combo filter (Select reserves "" for its own placeholder).
const ALL_COMBOS = "__all__";

const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

function PlaceholderRow({ label }) {
  return (
    <Card>
      <div className="flex h-32 items-center justify-center text-sm text-text-muted">{label}</div>
    </Card>
  );
}

export default function RoutingPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <RoutingContent />
    </Suspense>
  );
}

function RoutingContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && TABS.some((t) => t.value === tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/routing?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Tabs + period selector on same row (mirrors the Usage page) */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={TABS}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        {activeTab !== "trajectories" && (
          <SegmentedControl
            options={PERIODS}
            value={period}
            onChange={setPeriod}
            size="sm"
            className="w-full sm:w-auto"
          />
        )}
      </div>

      {activeTab === "overview" && <OverviewTab period={period} />}
      {activeTab === "trajectories" && <TrajectoriesTab />}
      {activeTab === "models" && <ModelsTab period={period} />}
    </div>
  );
}

/* ------------------------------- Overview ------------------------------- */

function OverviewTab({ period }) {
  const [combo, setCombo] = useState(ALL_COMBOS);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    const qs = new URLSearchParams({ period });
    if (combo && combo !== ALL_COMBOS) qs.set("combo", combo);
    fetch(`/api/routing/overview?${qs.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (id !== seq.current || !json) return; // stale response on rapid switch
        setData(json);
      })
      .catch(() => {})
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [period, combo]);

  const combos = data?.combos || [];
  const available = data?.available || [];
  const comboOptions = [
    { value: ALL_COMBOS, label: `All combos${available.length > 1 ? ` (${available.length})` : ""}` },
    ...available.map((c) => ({ value: c, label: c })),
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-[280px]">
          <Select
            label="Combo"
            options={comboOptions}
            value={combo}
            onChange={(e) => setCombo(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <PlaceholderRow label="Loading..." />
      ) : combos.length === 0 ? (
        <PlaceholderRow label="No routing data for this period yet" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {combos.map((c) => (
            <ComboCard key={c.combo} combo={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ComboCard({ combo }) {
  const series = combo.series || [];
  const hasSeries = series.length > 0;
  return (
    <Card padding="sm" className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <code className="truncate font-mono text-sm font-medium" title={combo.combo}>
          {combo.combo}
        </code>
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary shrink-0">
          {combo.strategy}
        </span>
      </div>

      <p className="text-xs text-text-muted tabular-nums">
        {combo.requests} req · {(combo.promptTokens || 0).toLocaleString()} in /{" "}
        {(combo.completionTokens || 0).toLocaleString()} out · {fmtCost(combo.cost)} ·{" "}
        {((combo.errorRate || 0) * 100).toFixed(1)}% err · avg{" "}
        {combo.avgLatencyMs != null ? `${combo.avgLatencyMs}ms` : "—"}
      </p>

      <p className="text-xs tabular-nums">
        <span className={combo.saved >= 0 ? "text-success" : "text-danger"}>
          {fmtCost(combo.saved)} saved ({combo.savedPct}%)
        </span>
        <span className="text-text-muted"> vs {combo.capableModel} · capable {combo.capableShare}%</span>
      </p>

      {hasSeries ? (
        <ResponsiveContainer width="100%" height={160}>
          <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`gradCost-${combo.combo}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmtCost}
              width={50}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value, name) => [fmtCost(value), name === "cost" ? "Spend" : "Saved"]}
            />
            <Legend wrapperStyle={{ fontSize: "11px" }} />
            <Area
              type="monotone"
              dataKey="cost"
              stroke="#f59e0b"
              strokeWidth={2}
              fill={`url(#gradCost-${combo.combo})`}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line type="monotone" dataKey="saved" stroke="#22c55e" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-16 items-center justify-center text-xs text-text-muted">
          No daily series yet
        </div>
      )}
    </Card>
  );
}

/* ----------------------------- Trajectories ----------------------------- */

function TrajectoriesTab() {
  const [combo, setCombo] = useState(ALL_COMBOS);
  const [minConf, setMinConf] = useState("");
  const [maxConf, setMaxConf] = useState("");
  const [failoverOnly, setFailoverOnly] = useState(false);
  const [failOpenOnly, setFailOpenOnly] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    const qs = new URLSearchParams({ limit: "50" });
    if (combo && combo !== ALL_COMBOS) qs.set("combo", combo);
    const min = parseFloat(minConf);
    if (minConf !== "" && Number.isFinite(min)) qs.set("minConf", String(min));
    const max = parseFloat(maxConf);
    if (maxConf !== "" && Number.isFinite(max)) qs.set("maxConf", String(max));
    if (failoverOnly) qs.set("failoverOnly", "true");
    if (failOpenOnly) qs.set("failOpenOnly", "true");
    fetch(`/api/routing/trajectories?${qs.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (id !== seq.current || !json) return; // stale response on rapid filter change
        setData(json);
        setSelectedId(null); // selection invalid across refetches; fall back to first session
      })
      .catch(() => {})
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [combo, minConf, maxConf, failoverOnly, failOpenOnly]);

  const sessions = data?.sessions || [];
  const combosList = data?.combos || [];
  const comboOptions = [
    { value: ALL_COMBOS, label: `All combos${combosList.length > 1 ? ` (${combosList.length})` : ""}` },
    ...combosList.map((c) => ({ value: c, label: c })),
  ];
  const selected =
    sessions.find((s) => (s.sessionId || `__req__${s.turns[0]?.id}`) === selectedId) || sessions[0] || null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-[240px]">
          <Select
            label="Combo"
            options={comboOptions}
            value={combo}
            onChange={(e) => setCombo(e.target.value)}
          />
        </div>
        <div className="w-24">
          <Input
            label="Min conf"
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={minConf}
            onChange={(e) => setMinConf(e.target.value)}
            placeholder="0"
          />
        </div>
        <div className="w-24">
          <Input
            label="Max conf"
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={maxConf}
            onChange={(e) => setMaxConf(e.target.value)}
            placeholder="1"
          />
        </div>
        <div className="flex flex-col gap-2 pb-1">
          <Toggle
            size="sm"
            checked={failoverOnly}
            onChange={setFailoverOnly}
            label="Failovers only"
          />
          <Toggle
            size="sm"
            checked={failOpenOnly}
            onChange={setFailOpenOnly}
            label="Fail-opens only"
          />
        </div>
      </div>

      {loading ? (
        <PlaceholderRow label="Loading..." />
      ) : sessions.length === 0 ? (
        <PlaceholderRow label="No routing decisions match these filters yet" />
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {/* Sessions list */}
          <Card padding="sm" className="flex min-w-0 shrink-0 flex-col gap-1 lg:w-72">
            <div className="px-1 py-1 border-b border-border-subtle">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                Sessions ({sessions.length})
              </span>
            </div>
            <div className="flex max-h-[480px] flex-col gap-0.5 overflow-y-auto">
              {sessions.map((s) => {
                const sid = s.sessionId || `__req__${s.turns[0]?.id}`;
                const last = s.turns[s.turns.length - 1];
                const active = selected && sid === (selected.sessionId || `__req__${selected.turns[0]?.id}`);
                return (
                  <button
                    key={sid}
                    onClick={() => setSelectedId(sid)}
                    className={`flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    }`}
                  >
                    <code className="min-w-0 truncate font-mono text-xs">
                      {s.sessionId ? s.sessionId.slice(-8) : "(no session)"}
                    </code>
                    <span className="shrink-0 text-[10px] tabular-nums">
                      {last && last.timestamp ? new Date(last.timestamp).toLocaleTimeString() : ""}
                      {" · "}
                      {s.turns.length}t
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Timeline */}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {selected && selected.turns.length > 0 && (
              <p className="text-xs text-text-muted">
                {selected.sessionId ? `session ${selected.sessionId.slice(-8)}` : "request without session"} —{" "}
                {selected.turns.length} {selected.turns.length === 1 ? "turn" : "turns"}
              </p>
            )}
            <TrajectoryTimeline turns={selected ? selected.turns : []} />
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------- Models -------------------------------- */

function ModelsTab({ period }) {
  const [models, setModels] = useState(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    fetch(`/api/routing/models?period=${period}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (id !== seq.current || !json) return; // stale response on rapid switch
        setModels(json.models || []);
      })
      .catch(() => {})
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [period]);

  if (loading) return <PlaceholderRow label="Loading..." />;
  if (!models || models.length === 0) return <PlaceholderRow label="No model usage for this period yet" />;

  return (
    <Card padding="sm" className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-xs">
        <thead>
          <tr className="border-b border-border-subtle text-left">
            <th className="py-2 pr-3 font-semibold text-text-muted">Model</th>
            <th className="py-2 pr-3 font-semibold text-text-muted">Status</th>
            <th className="py-2 pr-3 font-semibold text-text-muted">Adaptive</th>
            <th className="py-2 text-right font-semibold text-text-muted">Usage</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {models.map((m) => {
            const stats = m.inHealth?.stats || null;
            const offline = m.inHealth?.offline === true;
            return (
              <tr key={m.model} className="hover:bg-surface-2 transition-colors">
                <td className="py-2 pr-3 font-mono max-w-[240px] truncate" title={m.model}>
                  {m.model}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`block w-1.5 h-1.5 rounded-full ${offline ? "bg-danger" : "bg-success"}`} />
                    <span className={offline ? "text-danger" : "text-text-muted"}>
                      {offline ? "offline" : "online"}
                    </span>
                  </span>
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-text-muted tabular-nums">
                  {stats
                    ? `${stats.successes}✓ / ${stats.failures}✗ · ${stats.avgLatencyMs != null ? `${stats.avgLatencyMs}ms` : "—"} · pen ${stats.penalty}`
                    : "—"}
                </td>
                <td className="py-2 text-right whitespace-nowrap tabular-nums">
                  {m.requests} req · {fmtCost(m.cost)} · {((m.errorRate || 0) * 100).toFixed(1)}% err
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
