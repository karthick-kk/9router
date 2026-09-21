"use client";

import PropTypes from "prop-types";

// Small chip used for composite-stage details (tier, score, signals).
function Chip({ children, title }) {
  return (
    <code
      title={title}
      className="inline-flex max-w-full items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-text-muted dark:bg-white/5"
    >
      <span className="truncate">{children}</span>
    </code>
  );
}

// Outcome badge for one turn: green (served) / amber (failover) / red (failed) / grey (pending).
function OutcomeBadge({ outcome }) {
  if (!outcome) {
    return (
      <span className="inline-flex items-center rounded bg-black/5 px-1.5 py-0.5 text-[11px] font-medium text-text-muted dark:bg-white/5">
        pending
      </span>
    );
  }
  const latency = Number.isFinite(outcome.latencyMs) ? ` ${outcome.latencyMs}ms` : "";
  if (outcome.success && outcome.fellOver) {
    return (
      <span className="inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
        fell over → {outcome.served || outcome.fellOverTo || "?"}{latency}
      </span>
    );
  }
  if (outcome.success) {
    return (
      <span className="inline-flex items-center rounded bg-green-500/15 px-1.5 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
        served {outcome.served || "?"} ✓{latency}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400">
      failed {outcome.status || "?"}
    </span>
  );
}

// Relative-width probability bars for scores.probabilities ({model: weight}).
function ProbabilityBars({ probabilities }) {
  const entries = Object.entries(probabilities || {}).filter(([, v]) => Number.isFinite(v) && v > 0);
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map(([, v]) => v));
  return (
    <div className="flex flex-col gap-1">
      {entries
        .sort((a, b) => b[1] - a[1])
        .map(([model, value]) => {
          const short = model.split("/").pop();
          return (
            <div key={model} className="flex items-center gap-2" title={model}>
              <span className="w-28 truncate font-mono text-[11px] text-text-muted shrink-0">{short}</span>
              <div className="h-1 w-full overflow-hidden rounded bg-black/5 dark:bg-white/5">
                <div
                  className="h-full rounded bg-brand-500/70"
                  style={{ width: `${max > 0 ? Math.round((value / max) * 100) : 0}%` }}
                />
              </div>
              <span className="w-8 text-right font-mono text-[11px] text-text-muted tabular-nums shrink-0">
                {Math.round(value * 100)}%
              </span>
            </div>
          );
        })}
    </div>
  );
}

function TurnCard({ turn }) {
  const scores = turn.scores || {};
  const isComposite = turn.strategy === "composite-stage";
  const signals = scores.signals;
  const signalEntries = Array.isArray(signals)
    ? signals.map((s, i) => [String(i), s])
    : signals && typeof signals === "object"
      ? Object.entries(signals)
      : [];
  const hasCompositeChips = isComposite && (
    scores.classifierTier ||
    (scores.stageScore !== undefined && scores.stageScore !== null) ||
    signalEntries.length > 0
  );

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-border-subtle bg-surface p-3">
      {/* Header: #turn · time · strategy/source (reason) */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="font-semibold text-text-main">#{turn.turn}</span>
        <span className="text-text-muted">
          · {new Date(turn.timestamp).toLocaleTimeString()} · {turn.strategy}/{turn.source}
        </span>
        {turn.reason && (
          <span className="text-text-muted/70">({turn.reason})</span>
        )}
        <span className="ml-auto"><OutcomeBadge outcome={turn.outcome} /></span>
      </div>

      {/* Picked model */}
      {turn.picked && (
        <code className="block truncate font-mono text-sm text-text-main" title={turn.picked}>
          {turn.picked}
        </code>
      )}

      {/* Confidence bar */}
      {typeof turn.confidence === "number" && (
        <div className="flex items-center gap-2">
          <div className="h-1 w-full overflow-hidden rounded bg-black/5 dark:bg-white/5">
            <div
              className="h-full rounded bg-brand-500"
              style={{ width: `${Math.min(100, Math.max(0, turn.confidence * 100))}%` }}
            />
          </div>
          <span className="w-9 text-right font-mono text-[11px] text-text-muted tabular-nums shrink-0">
            {Math.round(turn.confidence * 100)}%
          </span>
        </div>
      )}

      {/* Per-model probabilities (Jev classification) */}
      {scores.probabilities && typeof scores.probabilities === "object" && (
        <ProbabilityBars probabilities={scores.probabilities} />
      )}

      {/* Composite-stage details: tier / stage score / signals */}
      {hasCompositeChips && (
        <div className="flex flex-wrap items-center gap-1">
          {scores.classifierTier && <Chip>{scores.classifierTier}</Chip>}
          {scores.stageScore !== undefined && scores.stageScore !== null && (
            <Chip title="Stage score">score {Number(scores.stageScore).toFixed(2)}</Chip>
          )}
          {signalEntries.map(([k, v]) => (
            <Chip key={k} title={k}>
              {k} {typeof v === "number" ? v : String(v)}
            </Chip>
          ))}
        </div>
      )}

      {/* Request preview */}
      {turn.preview && (
        <p className="text-xs text-text-muted italic truncate" title={turn.preview}>
          {turn.preview}
        </p>
      )}
    </div>
  );
}

export default function TrajectoryTimeline({ turns }) {
  if (!turns || turns.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-[10px] border border-dashed border-border-subtle p-8 text-sm text-text-muted">
        No turns
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {turns.map((turn) => (
        <TurnCard key={turn.id} turn={turn} />
      ))}
    </div>
  );
}

TrajectoryTimeline.propTypes = {
  turns: PropTypes.array,
};
