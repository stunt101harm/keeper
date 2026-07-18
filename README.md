# Keeper

**An autonomous in-play market maker for World Cup outcomes, powered by TxLINE.**

🔴 **Live demo: <https://keeper.h-dhaliwal2250.workers.dev>** — running in **auto mode** on
Cloudflare Containers: it flips itself to live ingestion whenever a World Cup match is
in-play and replays real recorded TxLINE tick data at 10× otherwise — anchoring its book
into an on-chain program as it runs.

Keeper quotes continuous two-way prices on live 1X2 match outcomes. It ingests TxLINE's
demargined StablePrice consensus and score streams, computes fair value, and quotes around it
with an inventory-aware, volatility-adjusted spread — fully autonomously. Every quote, fill,
and settlement is merkle-hashed and anchored on Solana devnet, making the maker's track
record tamper-evident; and Keeper verifies TxLINE's own on-chain validation proofs for the
data it trades on. Built for the TxLINE World Cup Hackathon (agent track).

## How it works

```
 TxLINE odds ──▶ Ingest ──▶ Fair Value ──▶ Quoting engine ──▶ Quotes (bid/ask) ─▶ Dashboard (SSE)
 TxLINE scores ▶ layer      (renorm,       (A-S style,                        └─▶ Solana devnet
 TxLINE proofs ▶ + recorder  EWMA vol)      sum-neutral skew)                      (audit anchors)
                                 │              ▲
                                 ▼              │
                             Execution ──▶ Risk manager
                             simulator     (caps, freezes, breaker, kill-switch)
                             (2-leg fills, P&L decomposition, settlement)
```

- **The trading core is a deterministic reducer** — state advances only via ticks, no wall
  clock, no RNG. Same input stream ⇒ identical book, byte for byte (unit-tested).
- **Quoting** ([docs/MODEL.md](docs/MODEL.md)): Avellaneda–Stoikov-inspired reservation
  price with a *sum-neutral* inventory skew on net exposure, making the three-outcome quote
  set arbitrage-free by construction (Σask ≥ 1 + 3δ_min). Spreads widen with EWMA
  volatility; goal/VAR/red-card freezes and a price-jump circuit breaker run on feed time.
- **Fills**: two deterministic legs — informed (consensus mid crossing a resting quote:
  pure adverse selection, the stress case) and benign (fluid-limit of the A-S exponential
  arrival intensity: spread-sensitive uninformed flow).
- **P&L decomposition**: spread capture / inventory drift / settlement residual tracked
  separately, so a lucky final score can't masquerade as skill.
- **Risk**: net-exposure caps (reduce-only), drawdown flatten, stale-feed halt, ops
  kill-switch (`POST /api/halt`) — autonomous means safe to leave running.
- **Autonomous lifecycle**: in auto mode the orchestrator discovers fixtures from TxLINE
  itself, flips to live ingestion 30 min before kickoff, back to replay after the match —
  and settles its own book on-chain after full time. No human input at any point.
- **Replay**: every live tick is recorded; the identical binary replays recordings at
  1–10×, which is how the deployed demo runs after the tournament ends (a header dropdown
  switches between seven recorded real matches).

## Fully on-chain: the `keeper_book` program

The book doesn't just hash to the chain — it *lives* there, in a purpose-built Anchor
program on devnet: **[`BhstTkGhG1LLPYBt3E3n4PTZ3v1V6ukNHYvQ88rgvTHS`](https://explorer.solana.com/address/BhstTkGhG1LLPYBt3E3n4PTZ3v1V6ukNHYvQ88rgvTHS?cluster=devnet)**
([source](program/programs/keeper_book/src/lib.rs)).

- **Typed book accounts** — one PDA per fixture holding the latest blotter merkle root,
  inventory, and mark-to-market P&L, updated every 30 s by `record_epoch`. The program
  enforces **seq continuity on-chain**: each epoch must start exactly where the last ended,
  so the audit trail provably has no gaps.
- **Proof-gated settlement** — `settle_book` is *permissionless* and can only settle by
  CPI into **TxLINE's own on-chain verifier** (`validate_stat_v2`) with a real match proof:
  the program checks finality (every proven stat carries the game-finalised period), binds
  the proof to the fixture, and derives the winner from the *proven* goals. Keeper cannot
  self-report an outcome; nobody can.
- **Live artifact**: the England v Argentina book —
  [11 epochs recorded, settled on-chain with the proven 1–2 score](https://explorer.solana.com/address/5CU5vsibB7UKqFz4c3bS1aHiBmvKnUMDwTYEYCW1p96F?cluster=devnet)
  ([settle tx](https://explorer.solana.com/tx/5b8GLm2CmVNR33iAbd5i8b2DS69TsEx9vKAhWT8vWiS2bA8Fm3jgdxrcgca9SUoWYJ7fdYAKtmoTn29gxexRaVZH?cluster=devnet)).
- **Tamper evidence**: `scripts/verify-anchors.ts` recomputes every epoch root from the
  local blotter and checks it against the on-chain events — flip one byte and it fails.
  `scripts/verify-txline-proof.ts` independently verifies TxLINE's proofs byte-exact
  (leaf hashing → 5-minute batch root → the `daily_scores_roots` PDA).

## Measured results (7 real matches)

Backtested over seven reconstructed real World Cup matches (R16 → semifinals, ~24k real
TxLINE ticks — full tables in [docs/BACKTEST.md](docs/BACKTEST.md)): **positive P&L in 7/7
matches** with quote uptime 73–97% and spread capture positive in every match (the
component that measures making markets, not getting lucky — the decomposition keeps the
two honest). Parameter-sensitivity sweep included. Reproduce: `npx tsx scripts/backtest.ts`.

## Run it

```bash
npm install
npm test                 # 70 tests: determinism, no-arb, P&L identity, risk scenarios
npx tsx src/index.ts     # replay mode on the committed real recording → localhost:8790
```

Live mode (requires TxLINE credentials in `.env` — see `.env.example`):

```bash
KEEPER_MODE=live npx tsx src/index.ts   # streams, quotes, records, anchors autonomously
```

Docker: `docker build -t keeper . && docker run -p 8790:8790 keeper`
Deploy: `npx wrangler deploy` (Cloudflare Containers; secrets via `wrangler secret put`).

## TxLINE integration

All endpoints, verified semantics, and payload schemas: [docs/TXLINE.md](docs/TXLINE.md).
Our API feedback log: [docs/FEEDBACK.md](docs/FEEDBACK.md). The quoting model with
parameter justifications: [docs/MODEL.md](docs/MODEL.md).

## License

MIT
