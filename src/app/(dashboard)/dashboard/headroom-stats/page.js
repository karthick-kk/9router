"use client";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/shared/components";

function formatNumber(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function StatBox({ label, value, sub }) {
  return (
    <div className="flex flex-col items-center p-3 rounded-lg bg-surface-2 min-w-[120px]">
      <span className="text-2xl font-bold text-primary">{value}</span>
      <span className="text-xs text-text-muted mt-1">{label}</span>
      {sub && <span className="text-xs text-text-muted">{sub}</span>}
    </div>
  );
}

export default function HeadroomStatsPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/headroom-stats", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStats(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-text-muted">Loading headroom stats...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <div className="p-4 text-center">
            <p className="text-red-400">Failed to load headroom stats: {error}</p>
            <p className="text-xs text-text-muted mt-2">
              Make sure headroom is running and accessible at the configured URL.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  const compressionsByStrategy = stats?.compressions_by_strategy || {};
  const tokensSavedByStrategy = stats?.tokens_saved_by_strategy || {};
  const router = stats?.router?.route_counts || {};
  const proxyInbound = stats?.proxy_inbound || {};
  const compressRequests = proxyInbound?.by_path?.["/v1/compress"] || 0;
  const totalCompressions = Object.values(compressionsByStrategy).reduce((a, b) => a + b, 0);
  const totalTokensSaved = Object.values(tokensSavedByStrategy).reduce((a, b) => a + b, 0);
  const cacheEntries = stats?.compression?.ccr_entries || 0;
  const cacheRetrievals = stats?.compression?.ccr_retrievals || 0;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Headroom Compression Stats</h1>
          <p className="text-sm text-text-muted mt-1">
            Real-time compression metrics from the headroom container
          </p>
        </div>
        <button
          onClick={fetchStats}
          className="px-3 py-1.5 text-xs rounded border border-border hover:bg-surface-2"
        >
          Refresh
        </button>
      </div>

      {/* Summary Stats */}
      <Card>
        <div className="p-4">
          <h2 className="text-sm font-semibold text-text-muted mb-3">Overview</h2>
          <div className="flex flex-wrap gap-3">
            <StatBox label="Compress Calls" value={compressRequests} />
            <StatBox label="Compressions" value={totalCompressions} />
            <StatBox label="Tokens Saved" value={formatNumber(totalTokensSaved)} />
            <StatBox label="Cache Entries" value={cacheEntries} />
            <StatBox label="Cache Retrievals" value={cacheRetrievals} />
          </div>
        </div>
      </Card>

      {/* Compressions by Strategy */}
      <Card>
        <div className="p-4">
          <h2 className="text-sm font-semibold text-text-muted mb-3">Compressions by Strategy</h2>
          {Object.keys(compressionsByStrategy).length === 0 ? (
            <p className="text-xs text-text-muted">No compressions yet</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(compressionsByStrategy)
                .sort(([, a], [, b]) => b - a)
                .map(([strategy, count]) => (
                  <div key={strategy} className="flex items-center justify-between text-sm">
                    <span className="font-mono">{strategy}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-text-muted">{count} compressions</span>
                      {tokensSavedByStrategy[strategy] && (
                        <span className="text-primary font-medium">
                          {formatNumber(tokensSavedByStrategy[strategy])} tokens saved
                        </span>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </Card>

      {/* Router Decisions */}
      <Card>
        <div className="p-4">
          <h2 className="text-sm font-semibold text-text-muted mb-3">Router Decisions</h2>
          {Object.keys(router).length === 0 ? (
            <p className="text-xs text-text-muted">No routing data yet</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {Object.entries(router)
                .sort(([, a], [, b]) => b - a)
                .map(([decision, count]) => (
                  <div key={decision} className="flex items-center justify-between text-sm p-2 rounded bg-surface-2">
                    <span className="text-text-muted">{decision.replace(/_/g, " ")}</span>
                    <span className="font-mono font-medium">{formatNumber(count)}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </Card>

      {/* Inbound Request Breakdown */}
      <Card>
        <div className="p-4">
          <h2 className="text-sm font-semibold text-text-muted mb-3">Inbound Requests</h2>
          <div className="flex items-center gap-4 text-sm mb-3">
            <span>Total: <strong>{proxyInbound.total || 0}</strong></span>
            <span>Completed: <strong>{proxyInbound.completed || 0}</strong></span>
            <span>Active: <strong>{proxyInbound.active || 0}</strong></span>
          </div>
          {proxyInbound.by_path && (
            <div className="space-y-1">
              {Object.entries(proxyInbound.by_path)
                .sort(([, a], [, b]) => b - a)
                .map(([path, count]) => (
                  <div key={path} className="flex items-center justify-between text-xs">
                    <span className="font-mono text-text-muted">{path}</span>
                    <span>{count}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
