# Routing Intelligence Design

## Problem

Combo routing decisions are invisible after the fact. The Jev classifier logs
one line per decision (`Picked <model> (conf 0.82)`) and discards the rest of
the response (per-model probabilities, fail-open cause, classifier latency).
Composite-stage logs a richer per-turn payload but log-only, and nothing
survives a container restart. There is no way to answer the fine-tuning
question "which turns did the router get wrong, and why", and no single place
that ties per-combo spend to whether the combo is doing its job. The Usage
page's `ComboEfficiencyCard` shows the savings math once, aggregated, with no
context for why.

## Goals

- Persist a structured **routing decision record** for every combo request
  across all strategies: `jev`, `composite-stage`, `adaptive`, `fallback`,
  `round-robin`, `fusion`.
- Backfill the **outcome** (served model, success/failure, failover, latency)
  so decision → outcome linkage exists — the core fine-tuning primitive.
- Add one new dashboard page, **Routing**, with three tabs: Overview
  (spend + routing quality side by side), Trajectories (per-session, per-turn
  decision timeline with filters), Models (live health + adaptive state +
  historical spend per model).
- Migrate the combo-efficiency savings math into the Routing page
  (per-combo, trended) and **delete** the now-duplicated `ComboEfficiencyCard`
  and `/api/usage/combo-efficiency` route from the Usage page.
- Keep the `usageHistory.meta` `{combo, comboStrategy}` tagging — the Routing
  page's per-combo cost/tokens/error-rate data is built on it.

## Non-Goals

- No changes to routing behavior itself (Jev call, composite tiers, adaptive
  sampling, failover loop are untouched apart from adding the capture call).
- No persistence of in-memory adaptive state or health-ticker state (they die
  on restart; the Models tab shows "live now" for those columns and
  historical data for cost/latency).
- No conversation-body capture: only a short preview of the user turn the
  classifier saw (~200 chars). No headers, no full messages.
- No new retention UI beyond the cap setting; no export feature.
- Not a general observability replacement — the Usage page's Details tab and
  `requestDetails` capture are unchanged.

## Data model

### New table `routingDecisions`

Added to `TABLES` in `src/lib/db/schema.js` (auto-`ALTER TABLE` on boot via
`syncSchemaFromTables`; `SCHEMA_VERSION` bump with pre-change backup, same as
prior schema changes).

| Column   | Type  | Notes |
|----------|-------|-------|
| `id`     | TEXT  | pk (uuid, `usageHistory` pattern) |
| `timestamp` | INTEGER | decision time, indexed |
| `combo`  | TEXT  | combo name |
| `strategy` | TEXT | `jev` / `composite-stage` / `adaptive` / `fallback` / `round-robin` / `fusion` |
| `sessionId` | TEXT | `comboSessionId` identity (same resolution composite-stage uses); nullable for single-shot requests |
| `turn`   | INTEGER | per-session turn counter (fresh user turn = 1, tool-step continuations increment) |
| `source` | TEXT | `jev` / `classifier` / `classifier-cached` / `picker-default` / `stage` / `adaptive` / `static` / `fusion-judge` |
| `reason` | TEXT | `classified`, `ranked`, `thompson-sampled`, or fail-open cause: `no-api-key`, `timeout`, `http-<status>`, `no-usable-choice`, `below-gate-held`, … |
| `picked` | TEXT | model that went first in the resulting order |
| `confidence` | REAL | Jev confidence / composite tier confidence; NULL for fallback/round-robin |
| `scores` | TEXT (JSON) | the "why" payload: Jev `probabilities` map; composite stage score + 4 signals; adaptive pseudo-counts snapshot; `{}` otherwise |
| `preview` | TEXT | first ~200 chars of the user turn the classifier saw |
| `classifierMs` | INTEGER | classifier call latency (currently measured nowhere) |
| `outcome` | TEXT (JSON) | backfilled post-response: `{ served, success, fellOver, fellOverTo, status, latencyMs }`; NULL until backfilled |

### Capture points (fail-open; a record failure never affects routing)

1. `open-sse/services/combo/jev.js` `orderModelsByJev` — decision,
   `classifierMs` (time the fetch), confidence, probabilities, preview.
   Returns the record id alongside the model order.
2. `open-sse/services/combo/composite-stage.js` `decideTier` — tier,
   confidence, source/reason, stage score, signals, escalation flag.
3. `open-sse/services/combo/adaptive.js` — Thompson-sampled pick +
   adaptive-state snapshot into `scores`.
4. Fallback / round-robin / fusion — minimal records (no classifier) so every
   combo has a trace; fusion judge pick uses `source: fusion-judge`.

All writes go through a new repo,
`src/lib/db/repos/routingDecisionsRepo.js`: `recordDecision(rec)`,
`backfillOutcome(id, outcome)`, `queryTrajectories(filters)`,
`queryOverview(period)`, `queryModels(period)`.

### Outcome backfill

The chat handler (`src/sse/handlers/chat.js`) receives the decision record id
from the strategy function and, after the response completes, calls
`backfillOutcome` with: served model (from the executor result), success,
whether `handleComboChat`'s failover loop advanced past the first pick
(exposed as a result field), HTTP status, total latency. One `UPDATE` by id.
The `turn` value comes from the existing combo session map
(`open-sse/services/combo/session-state.js`, keyed `comboName:sessionId`):
composite-stage already increments `turnCounter` there; **all** combo
strategies will increment it on the fresh-user-turn path (the map is
strategy-agnostic — Jev simply doesn't use its tier fields today). Requests
with no resolvable session id get `turn = 1`.

### Retention

Bounded ring: on insert, delete oldest rows beyond `routingDecisionsMaxRecords`
(default **5000**, min 500), same mechanism as `requestDetails` pruning.
Estimated ~1.5 KB/row → ~7.5 MB at cap. Setting lives in
`settingsRepo.js` `DEFAULT_SETTINGS` and the profile page next to the
observability settings. Capture is always on (no enable flag) — the ring is
trivial and off-by-default would leave the page empty.

## API surface

One new dashboard-guarded family, all read-only:

1. `GET /api/routing/overview?period=&combo=`
   Per combo: requests, tokens in/out, cost, error rate, avg latency; plus the
   efficiency series (actual cost, capable-baseline cost, saved $/%,
   cheap-vs-capable turn share) bucketed over the period for the trend chart.
   Computed from `usageHistory` (`meta.combo`) + `routingDecisions.outcome`
   (latency). Periods: `today, 24h, 7d, 30d, 60d, all` (same constants as
   Usage).
2. `GET /api/routing/trajectories?combo=&limit=&minConf=&maxConf=&failoverOnly=&failOpenOnly=`
   Recent sessions for the combo (grouped by `sessionId`, most recent first),
   each with its decision records in turn order. `limit` = sessions, default
   50, max 200. Bounded by the ring — no heavy pagination.
3. `GET /api/routing/models?period=`
   Per model across all combos: live health-ticker status
   (`comboHealth.isModelOffline`) + adaptive snapshot
   (`adaptive-state.getAdaptiveStats`) + historical cost/tokens/error rate
   from `usageHistory`. The only HTTP exposure of those two in-memory
   stores.

## Dashboard page

New sidebar entry **Routing** → `src/app/(dashboard)/dashboard/routing/page.js`
(client component, Tailwind + the existing shared components; charts follow
the Usage page's existing chart approach).

### Overview tab
- Period + combo selectors.
- Spend row per combo: requests, tokens, cost, error rate, avg latency.
- Routing-quality row (migrated efficiency card, per-combo and trended):
  actual vs capable-baseline cost, saved $/% over time, cheap-vs-capable turn
  share.
- No duplication of the Usage page's global totals/by-provider charts.

### Trajectories tab
- Combo picker → recent sessions list → vertical turn timeline.
- Each turn card: turn #, timestamp, strategy/source/reason, picked model,
  confidence with per-model probability bars (Jev), tier/score/signals
  (composite), ~200-char preview, outcome badge
  (`served X ✓ 1.2s` / `fell over to Y` / `failed 503` /
  `classifier unavailable — held order`).
- Filters for the tuning workflow: confidence range, failovers only,
  fail-opens only.

### Models tab
- One row per model: live health status, adaptive success/failures/penalty,
  avg latency (live columns, in-memory), cost/tokens/errors over the period
  (historical columns).

## Deletions (no duplication)

- `ComboEfficiencyCard` in `src/shared/components/UsageStats.js` and its
  render site — removed from the Usage page.
- `src/app/api/usage/combo-efficiency/route.js` — deleted; its math moves
  server-side into `/api/routing/overview`.
- The `meta` tagging (`saveUsageStats` combo/comboStrategy) stays — it is
  the per-combo cost source, not a UI feature.

## Error handling

- Capture calls are wrapped so any failure (DB down, serialization) logs a
  warn and returns without affecting routing.
- `backfillOutcome` on a missing id is a no-op (row pruned between decision
  and completion is possible at the 5k cap; harmless).
- Routes return 200 with empty collections when a period has no data (the
  page renders empty-state copy, like the current efficiency card).

## Testing

Vitest, existing patterns:

- `routingDecisionsRepo`: insert + ring prune (oldest deleted past cap),
  backfill update, query grouping.
- Capture: Jev success / low-conf-rank / fail-open (timeout, no key, bad
  choice) each produce a record with correct `source`/`reason` and never
  throw out of routing; composite + adaptive captures; DB write failure
  swallowed.
- Routes: overview aggregation (incl. capable-baseline math), trajectory
  grouping and filters.
- Page: no unit tests (consistent with the rest of the dashboard); verified
  live in-browser after deploy.

Full unit suite checked against the known pre-existing-failure baseline
(~124); zero new failures required.
