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

## 3:30–4:15 — The on-chain story (the climax)

1. Chain panel: point at the **keeper_book program** card — book account, latest root,
   "anchored through seq N", epoch count. "The book doesn't hash to the chain — it *lives*
   there. A program account per match, updated every 30 seconds, and the program enforces
   sequence continuity on-chain: the audit trail provably has no gaps."
2. The settled book: "Here's last night's France v England book — **settled on-chain, and
   not by us**: settlement is permissionless and only succeeds by CPI into TxLINE's own
   on-chain verifier with the real match proof. The proven final score decides the winner.
   Keeper *cannot* self-report an outcome." Click the settle tx → explorer.
3. Tamper check, terminal: `npx tsx scripts/verify-anchors.ts` → all MATCH; flip one byte
   in `data/events.jsonl`, re-run → MISMATCH exit 1. "A provable track record."
4. "And we verify the feed we trade on, independently:"
   `npx tsx scripts/verify-txline-proof.ts 18241006 962 1,2` → byte-exact against the
   on-chain daily roots.

## 4:15–5:00 — Autonomy + production readiness + close

- "Last night nobody touched it: the deployed instance discovered France v England from
  the fixtures feed, flipped itself to live ingestion 30 minutes before kickoff, traded
  the whole match, recorded every tick, and settled its book on-chain after full time.
  That's what autonomous means here." (If footage exists: 5s clip of the LIVE badge
  during the match.)
- Backtest slide/scroll: docs/BACKTEST.md table — "positive P&L in all seven real matches
  we reconstructed, spread capture positive in every one — and the decomposition is
  exactly how we'd catch it if that were luck."
- `curl /health`, `POST /api/halt` flipping the badge — "the one human control."
- Close: "Keeper — an autonomous market maker whose entire book is an on-chain fact.
  Data by TxLINE, settlement proven by TxLINE's own program."

## Recording checklist

- [ ] Server running in replay mode, recording loaded, dashboard warm (no cold-start jank)
- [ ] Explorer tab pre-loaded (devnet cluster param!)
- [ ] Terminal pre-sized, commands in shell history
- [ ] Mic check; kill notifications
- [ ] Under 5:00 hard (submission requirement)
