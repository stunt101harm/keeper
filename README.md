# Keeper

**An autonomous in-play market maker for World Cup outcomes, powered by TxLINE.**

Keeper quotes continuous two-way prices (back/lay) on live 1X2 match outcomes for all World Cup fixtures. It ingests TxLINE's real-time consensus odds and score streams, computes a de-vigged fair value, and quotes around it with an inventory-aware, volatility-adjusted spread — fully autonomously, with no human in the loop. Every quote, fill, and settlement is anchored on Solana devnet, producing a tamper-evident audit trail of the maker's entire book.

Built for the **TxLINE World Cup Hackathon** (agent track).

## How it works

```
                ┌────────────────────────────────────────────────┐
                │                    KEEPER                      │
 TxLINE odds ──▶│ Ingest ──▶ Fair Value ──▶ Quoting ──▶ Quotes  │──▶ Dashboard (SSE)
 TxLINE scores ▶│  layer      (de-vig,      engine      bid/ask │
 TxLINE proofs ▶│  + recorder  volatility)  (A-S style)         │──▶ Solana devnet
                │                 │            ▲                 │    (audit anchors)
                │                 ▼            │                 │
                │             Execution ──▶ Risk manager         │
                │             simulator     (caps, freezes,      │
                │             (fills, P&L)   kill-switch)        │
                └────────────────────────────────────────────────┘
```

- **Fair value** — TxLINE consensus odds are de-vigged into an implied probability vector; an EWMA of tick-to-tick log-odds changes estimates in-play volatility.
- **Quoting** — Avellaneda–Stoikov-inspired: reservation price skewed by inventory, half-spread widened by volatility, quotes pulled entirely during goal/VAR freeze windows.
- **Execution** — deterministic fill simulation: a resting quote fills when the consensus mid crosses it (models informed flow). Inventory and mark-to-market P&L tracked per outcome; positions settle from TxLINE final scores.
- **Risk** — per-match inventory caps, stale-feed kill-switch, max-drawdown stop. Autonomous means safe to leave running.
- **Solana** — quote/fill/settlement events are hashed and anchored on devnet; TxLINE's own validation proofs are verified against their on-chain program.
- **Replay** — every live tick is recorded; the full agent runs against recorded feeds at 1×–10× speed, so it is fully demonstrable (and judge-testable) after the tournament ends.

## Status

🚧 Hackathon build in progress — see the [epic issue](../../issues/1) for the implementation plan and task breakdown.

## TxLINE endpoints used

- `POST /auth/guest/start` — guest JWT auth
- Fixtures — World Cup fixture metadata
- Odds — StablePrice snapshots, historical updates, live stream
- Scores — snapshots + live score events
- Validation proofs — on-chain verification against TxLINE's Solana devnet program

## License

MIT
