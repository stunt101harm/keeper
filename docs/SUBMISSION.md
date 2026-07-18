# Submission form material (Earn) — paste-ready

**Deadline: July 19, 2026, 23:59 UTC.** Fill the Earn listing with the blocks below.

## Links

- **Public repo**: https://github.com/stunt101harm/keeper
- **Application access**: https://keeper.h-dhaliwal2250.workers.dev
- **Demo video**: _(add Loom/YouTube link — ≤5:00, script in docs/DEMO.md)_

## Core idea (short)

Keeper is an autonomous in-play market maker for World Cup 1X2 outcomes. It ingests
TxLINE's demargined StablePrice consensus and live score streams, quotes continuous
two-way prices with an Avellaneda–Stoikov-style engine (inventory-aware, volatility-
adjusted, arbitrage-free across the outcome set), manages its own risk, and settles at
full time — with no human in the loop. Its entire book lives on-chain: a purpose-built
Solana program records the blotter's merkle roots with an on-chain continuity guarantee,
and settlement is permissionless and proof-gated — the program only settles by CPI into
TxLINE's own on-chain verifier with the real match proof, so the outcome is cryptographically
proven, never self-reported.

## Technical highlights

- **Deterministic trading core**: the engine is a pure reducer — same tick stream ⇒
  byte-identical book (property-tested). No wall clock, no RNG; freezes and timeouts run
  on feed time so replays are exact at any speed.
- **Defensible math** (docs/MODEL.md): sum-neutral inventory skew on net exposure makes
  the 3-outcome quote set arbitrage-free by construction; two deterministic fill legs
  (adverse-selection stress leg + fluid-limit benign flow); P&L decomposed into spread
  capture / inventory drift / settlement so luck is visible.
- **Fully on-chain book** (`keeper_book`, devnet `BhstTkGhG1LLPYBt3E3n4PTZ3v1V6ukNHYvQ88rgvTHS`):
  typed per-fixture accounts, 30-second epoch commits with on-chain seq-continuity, and
  CPI-proof-gated permissionless settlement via TxLINE `validate_stat_v2`. Tamper checks:
  `scripts/verify-anchors.ts` (blotter vs chain), `scripts/verify-txline-proof.ts`
  (TxLINE proofs recomputed byte-exact to the daily-roots PDA).
- **Autonomous lifecycle**: auto mode discovers fixtures from TxLINE, flips itself to live
  ingestion for in-play matches, records every tick, settles on-chain after full time,
  and returns to replaying its recordings — the deployed instance did this unattended.
- **Empirics**: 7 real matches reconstructed from TxLINE historical data — positive P&L
  in 7/7, spread capture positive in all (docs/BACKTEST.md, incl. parameter sweep).
- **Production**: 123 tests, typed end-to-end, structured logs, health/metrics, ops
  kill-switch, Docker, deployed on Cloudflare Containers; judge-testable after the
  tournament via the built-in replay of real recordings.

## TxLINE endpoints used

Auth (`/auth/guest/start`, on-chain `subscribe` + `/api/token/activate`);
`/api/fixtures/snapshot`; `/api/odds/snapshot/{id}`, `/api/odds/stream`,
`/api/odds/updates/{epochDay}/{hour}/{interval}`; `/api/scores/snapshot/{id}`,
`/api/scores/stream`, `/api/scores/historical/{id}`;
`/api/scores/stat-validation` + on-chain `validate_stat_v2` CPI and the
`daily_scores_roots` PDAs. Full verified semantics: docs/TXLINE.md.

## Feedback (summary — full log in docs/FEEDBACK.md)

Loved: the demargined StablePrice feed is exactly a market maker's fair-value input;
~1 tick/second historical odds buckets make faithful replays and backtests possible;
the on-chain verifier is production-grade (typed errors, return-data verdict, ~200k CU)
— we built real trustless settlement on it. Friction: period-scoped 1X2 variants
(`MarketPeriod "half=1"`) interleave under the same SuperOddsType and will poison a naive
consensus filter; historical odds are time-bucketed rather than fixture-scoped; suspension
is encoded as empty price arrays; `X-Api-Token` requirement and `weeks % 4 == 0` are only
discoverable from example code; `validate_stat_v2` requires strategies to cover every
proven leaf (`IncompleteStatCoverage` 6071, undocumented).

## Eligibility / team

Solo builder: harm (stunt101harm). Prize receipt via Earn.
