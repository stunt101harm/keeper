# Backtest — the engine on real World Cup data

**What this proves.** Keeper's engine was replayed over 7 complete, real
TxLINE recordings of 2026 World Cup knockout matches (round of 16 through the
semifinals) with a single fixed default parameter set — no per-match tuning.
Across every match it holds the three properties a market maker is judged on:

1. **Consistent two-sided uptime** (worst match: 73.2%), with downtime
   confined to deliberate risk responses (goal/VAR freezes, jump breakers,
   stale-feed halts) rather than model failure.
2. **Bounded inventory**: max |net exposure| ever observed is 8.00 stake
   units against a hard cap of 10 — the inventory-skew term does its job
   long before the reduce-only guardrail binds.
3. **Spread-capture-driven P&L** rather than one lucky directional match —
   the decomposition (spread / drift / settlement residual) is reported
   per match below, including the matches where it is *not* flattering.

Every number is deterministic and reproducible: `npx tsx scripts/backtest.ts`
re-derives this file from the committed recordings in `data/`. Recordings were
reconstructed from TxLINE historical endpoints (consensus 1X2 odds + full score
log) by `scripts/fetch-recording.ts`.

## Per-match results (default parameters)

| Match | Odds ticks | Uptime (2-sided) | Fills benign/informed | Freezes (breaker) / stale halts | Max \|u\| | Final | Total P&L | Spread / Drift / Settle |
|---|---:|---:|---:|---:|---:|---|---:|---:|
| Portugal v Spain | 3125 | 97.2% | 278 / 1 (278.0:1) | 1 (0) / 35 | 0.67 | 0-1 away | 2.5867 | 1.8273 / 0.7121 / 0.0474 |
| France v Morocco | 2413 | 93.0% | 202 / 2 (101.0:1) | 5 (0) / 37 | 1.00 | 2-1 home | 0.8447 | 1.2931 / -0.4484 / 0.0000 |
| Spain v Belgium | 3531 | 96.2% | 305 / 7 (43.6:1) | 3 (0) / 31 | 1.67 | 2-1 home | 2.7011 | 2.0097 / 0.6914 / 0.0000 |
| Norway v England | 3729 | 96.0% | 312 / 24 (13.0:1) | 6 (0) / 29 | 4.67 | 1-2 away | 6.8134 | 2.0250 / -0.8817 / 5.6701 |
| Argentina v Switzerland | 3487 | 95.5% | 296 / 24 (12.3:1) | 5 (1) / 40 | 8.00 | 3-1 home | 10.6449 | 1.8444 / -4.5992 / 13.3996 |
| France v Spain | 3138 | 73.2% | 263 / 5 (52.6:1) | 5 (2) / 34 | 2.00 | 0-2 away | 2.9790 | 1.6830 / 1.2725 / 0.0236 |
| England v Argentina | 3689 | 92.9% | 309 / 8 (38.6:1) | 5 (0) / 36 | 1.67 | 1-2 away | 2.6013 | 2.0439 / 0.5263 / 0.0312 |

P&L decomposition: **Spread** = Σ side·(mid − fill)·size (adverse-selection-adjusted
spread capture), **Drift** = Σ q·Δmid (inventory mark drift), **Settle** =
settlement value − final marks. Spread + Drift + Settle = realized + MTM P&L
identically. Units are stake units (clip size 1).

## Parameter sensitivity — England v Argentina

One representative match swept over gamma (risk aversion) × deltaMin (minimum
half-spread), 9 runs, everything else at defaults:

| gamma | deltaMin | Total P&L | Spread / Drift / Settle | Uptime | Max \|u\| | Fills (b:i) |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 0.003 | 5.0941 | 2.3413 / 2.7217 / 0.0312 | 92.9% | 3.33 | 516:40 |
| 10 | 0.005 | 2.6016 | 2.0442 / 0.5263 / 0.0312 | 92.9% | 1.67 | 309:8 |
| 10 | 0.008 | 1.4088 | 1.4088 / 0.0000 / 0.0000 | 92.9% | 0.00 | 144:0 |
| 20 | 0.003 | 4.4422 | 2.3381 / 2.0729 / 0.0312 | 92.9% | 2.67 | 516:40 |
| 20 | 0.005 | 2.6013 | 2.0439 / 0.5263 / 0.0312 | 92.9% | 1.67 | 309:8 |
| 20 | 0.008 | 1.4088 | 1.4088 / 0.0000 / 0.0000 | 92.9% | 0.00 | 144:0 |
| 40 | 0.003 | 4.8687 | 2.3251 / 2.4812 / 0.0623 | 92.9% | 3.00 | 515:40 |
| 40 | 0.005 | 2.6006 | 2.0432 / 0.5263 / 0.0312 | 92.9% | 1.67 | 309:8 |
| 40 | 0.008 | 1.4088 | 1.4088 / 0.0000 / 0.0000 | 92.9% | 0.00 | 144:0 |

Reading: deltaMin is the dominant lever — tighter spreads mean more fills, more
adverse selection and more inventory (hence more drift exposure); at
deltaMin=0.008 the book barely accumulates inventory at all and P&L is pure
benign-flow capture. Gamma only matters once inventory actually builds up
(visible in the deltaMin=0.003 column), which is exactly its design role. The
key robustness fact: **uptime is identical in all 9 cells** and total P&L stays
positive everywhere — the engine's behaviour is a property of its structure,
not of a tuned corner.

## Honest notes

- **Uptime is structural, not lucky**: worst-case two-sided uptime across all 7 matches is 73.2%. Downtime is the *designed* response to goals, VAR and feed gaps (freeze windows + stale-feed halts), not quoting failure.
- **Inventory stays bounded by construction**: max |net exposure| observed anywhere is 8.00 stake units vs a cap of 10 — the gamma-skew recentres the book long before the reduce-only cap is the binding constraint.
- **P&L across the sample**: 7/7 matches profitable, aggregate 29.1711 stake units. 7/7 recordings reach on-feed settlement.
- **Honest caveat — luck-dominated matches**: in 2 of 7 matches (Norway v England, Argentina v Switzerland) the inventory-drift or settlement-residual term exceeds spread capture in magnitude. Those totals are direction-taking luck (inventory that happened to be on the right side of late goals), not market-making skill — the same mechanism could have produced losses. Spread capture itself is positive in every match; the luck terms are the part we do not claim credit for.
- **Fill model caveat**: fills are simulated (informed = consensus crossing our quote; benign = deterministic intensity model calibrated to ~3:1). Absolute P&L therefore depends on the benign-flow assumption; the *robustness* claims (uptime, bounded inventory, breaker behaviour, sign of spread capture) do not.
