# Keeper — demo narration script (2:30–3:00 cut)

Spoken lines are plain text. **[Bracketed = on screen, don't read.]**
~380 words ≈ 2:45 at a normal pace.

---

## 1 — Hook (0:00–0:20)

**[Screen: dashboard, France v England replay]**

This is Keeper — an autonomous market maker for in-play World Cup markets, built
on TxLINE. It prices, quotes, manages risk, and settles — no human in the loop —
and its entire book lives on Solana, so anyone can audit what it did.

## 2 — The engine (0:20–1:10)

**[Same screen — point at the chart]**

This is real data — France–England last night, a ten-goal match Keeper traded
live, replayed at ten-x. The line is TxLINE's demargined consensus — our fair
value. The band is our bid and ask: inventory skews it, volatility widens it,
and the quote set is arbitrage-free by construction.

**[A goal — freeze band]**

There's a goal — Keeper freezes instantly, re-enters wide, tightens back. All on
feed time, so replays are deterministic: same ticks in, identical book out.

**[Book panel]**

And P&L is split three ways — spread capture, inventory drift, settlement — so a
lucky score can't look like skill. Seven real matches backtested: profitable in
all seven, spread capture positive in every one.

## 3 — On-chain (1:10–2:05)

**[Terminal: npx tsx scripts/show-book.ts 18257865]**

Here's the part that's different. Every thirty seconds the book's merkle root
goes into a Solana program — one account per match, continuity enforced on-chain.
And here's last night's match: settled on-chain, proven final score, four–six.
Nobody typed that in — settlement only succeeds by calling TxLINE's own on-chain
verifier with the real match proof. Keeper can't self-report an outcome. It
settled itself twenty minutes after full time.

**[verify-anchors → MATCH; sed one digit; re-run → MISMATCH]**

Tamper check: everything verifies... I flip one digit in the blotter... and it
fails. The track record can't be rewritten.

## 4 — Live + close (2:05–2:45)

**[Screen: keeper.h-dhaliwal2250.workers.dev — Spain v Argentina, LIVE badge]**

And this is not a simulation — this is the World Cup final, live, right now.
Keeper found the fixture itself, went live before kickoff on its own, and it's
quoting the final as I speak — anchoring its book on-chain the whole way.

One Docker image, a hundred twenty-six tests, one human control — a kill switch.
Keeper: an autonomous market maker whose book is an on-chain fact. Data by
TxLINE, settlement proven by TxLINE's own program. Thanks for watching.
