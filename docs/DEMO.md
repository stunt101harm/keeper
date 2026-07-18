# Demo video script (≤ 5:00)

Target: judges score heavily on this. One take per section, screen-recorded (Loom), tight cuts.
Record at 1440p+, dashboard full-screen, terminal font ≥ 16pt.

## 0:00–0:30 — The problem

Slide or plain talking head over the TxLINE docs page:

> "In-play soccer markets reprice every second, and someone has to quote both sides
> continuously — that's a market maker. Doing it manually doesn't scale to 104 World Cup
> matches. Keeper is an autonomous in-play market maker built on TxLINE's consensus feed:
> it prices, quotes, manages risk, and settles — with no human in the loop — and it anchors
> its entire book on Solana so anyone can audit what it did."

## 0:30–1:00 — What it is (architecture)

README architecture diagram on screen. One breath per component:

> "TxLINE streams demargined consensus odds and score events. The trading core is a
> deterministic reducer — Avellaneda-Stoikov-style quoting around the consensus fair value:
> inventory skews the reservation price, volatility widens the spread, goals freeze quoting.
> Fills, P&L, and settlement are simulated deterministically. Every quote, fill, and
> settlement is merkle-hashed and anchored on Solana devnet. Same input stream, same book —
> byte for byte."

## 1:00–3:30 — The meat: live dashboard over a real recorded match

Replay of **France v England (Jul 18)** — or England v Argentina semi — at 10×.

Beats, in order (practice the cursor path):
1. Header: "This is a real World Cup match, TxLINE's actual tick stream, replayed at 10×.
   In live mode the same binary just points at the SSE streams — mode badge top right."
2. Money chart: "Blue line is TxLINE's demargined consensus — our fair value. The band is
   our bid/ask. Watch the spread breathe with volatility."
3. A goal: "Goal — books suspend, TxLINE marks it, Keeper freezes instantly, re-enters wide,
   and decays back as the market settles. The freeze runs on feed time, so this replays
   identically at any speed."
4. Fills + book: "Dots are fills. Notice inventory skewing our quotes away from risk — and
   the P&L decomposition: spread capture vs inventory drift vs settlement. We show them
   separately so a lucky final score can't masquerade as skill."
5. Risk: point at state badge history — "reduce-only at the exposure cap, stale-feed halt,
   drawdown flatten. Autonomous means safe to leave running."
6. Full time: settlement event, final P&L.

## 3:30–4:15 — The Solana story (both directions)

1. Chain panel: click an anchor tx → Solana explorer (devnet) showing the memo with the
   merkle root. "Every 30 seconds Keeper anchors its event log. Here's the tamper check:"
2. Terminal: `npx tsx scripts/verify-anchors.ts` → all MATCH. Flip one byte in
   `data/events.jsonl` (`sed` one-liner), re-run → MISMATCH, exit 1. "The blotter can't be
   rewritten after the fact — a provable track record."
3. "And it goes both ways — TxLINE anchors *their* data too:"
   `npx tsx scripts/verify-txline-proof.ts 18241006 962 1,2` → proof verifies against the
   on-chain daily roots. "We verify the feed we trade on."

## 4:15–5:00 — Production readiness + close

- `curl /health`, `/metrics`, `POST /api/halt` flipping the badge to HALTED and back.
- "One Docker image, deployed at <URL>, replay mode after the tournament so you can test it
  yourself. TypeScript, fully unit-tested — determinism, no-arbitrage across the outcome
  set, and the P&L identity are all property tests."
- Close: "Keeper — an autonomous market maker with an auditable book. Data by TxLINE,
  audit trail on Solana."

## Recording checklist

- [ ] Server running in replay mode, recording loaded, dashboard warm (no cold-start jank)
- [ ] Explorer tab pre-loaded (devnet cluster param!)
- [ ] Terminal pre-sized, commands in shell history
- [ ] Mic check; kill notifications
- [ ] Under 5:00 hard (submission requirement)
