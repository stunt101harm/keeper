# Keeper

**An autonomous in-play market maker for World Cup outcomes, powered by TxLINE.**

🔴 **Live demo: <https://keeper.h-dhaliwal2250.workers.dev>** — replaying the real
England v Argentina semifinal (actual TxLINE tick data) at 10× on Cloudflare Containers,
anchoring its book to Solana devnet as it runs.

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
- **Solana, both directions**: the anchorer merkle-hashes every engine event and posts the
  root to devnet via Memo every 30 s (`scripts/verify-anchors.ts` proves the blotter wasn't
  rewritten — flip one byte and it fails); `scripts/verify-txline-proof.ts` verifies
  TxLINE's stat proofs against their on-chain program, byte-exact.
- **Replay**: every live tick is recorded; the identical binary replays recordings at
  1–10×, which is how the deployed demo runs after the tournament ends.

## Measured results (real data)

On the recorded England v Argentina semifinal (4,643 real TxLINE ticks): **92.9% two-sided
quote uptime**, 317 fills, max net exposure 1.67 of cap 10, zero circuit-breaker
false-fires, settled 1–2. P&L +2.60 stake units = spread capture +2.04, inventory drift
+0.53, settlement residual +0.03. Reproduce: `npx tsx scripts/stats.ts`.

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
