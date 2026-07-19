# Keeper — demo narration script (read-aloud)

Spoken lines are plain text. **[Bracketed lines = what's on screen — don't read.]**
Target ≤ 5:00. Pace: unhurried; the visuals carry the detail.

---

## Section 1 — Intro (0:00–0:30)

**[Screen: README architecture diagram, or just the dashboard header]**

This is Keeper — an autonomous market maker for in-play World Cup betting markets,
built on TxLINE's data feed.

In-play markets reprice every second, and someone has to quote both sides
continuously. Doing that manually doesn't scale to a hundred and four World Cup
matches. Keeper does it with no human in the loop: it prices, quotes, manages risk,
and settles — and its entire book lives on Solana, so anyone can audit what it did.

---

## Section 2 — Replay walkthrough (0:30–2:30)

**[Screen: localhost:8790 — France v England replaying at 10×]**

What you're watching is real data: France versus England from last night — a
ten-goal thriller that Keeper actually traded live. Every tick was recorded, and
the same binary replays it at ten times speed. That's also how you can test it
after the tournament ends.

The line is TxLINE's demargined consensus — that's our fair value. The band around
it is Keeper's bid and ask. The engine is Avellaneda-Stoikov style: inventory skews
the price, volatility widens the spread — and the quote set is arbitrage-free across
all three outcomes by construction.

**[Wait for a goal — freeze band appears]**

There's a goal. The books suspend, and Keeper freezes instantly — then re-enters
wide and tightens back as the market settles. All of that runs on feed time, so the
replay is deterministic: same ticks in, same book out, byte for byte. It's a
property test in the repo.

**[Scroll to book panel — point at the P&L decomposition]**

Down here, the part I'd show a trading desk: we split P&L into spread capture,
inventory drift, and settlement. A lucky final score can't masquerade as skill.
This match: spread capture earned one point six seven, and carried a drawdown of
about one point two from inventory drift through ten goals — profitable the honest
way. We backtested seven real matches — positive in all seven, spread capture
positive in every single one.

---

## Section 3 — On-chain (2:30–3:45)

**[Screen: chain panel — click the France–England book "account" link → explorer]**

Now the part that makes this different. Keeper's book doesn't just hash to the
chain — it lives there. A purpose-built Solana program holds one account per match:
the blotter's merkle root, inventory, and P&L, updated every thirty seconds, with
sequence continuity enforced on-chain — the audit trail provably has no gaps.

**[Terminal: npx tsx scripts/show-book.ts 18257865]**

And here's last night's match, settled on-chain — proven final score, four–six.
Nobody typed that in. Settlement is permissionless, and it only succeeds by calling
into TxLINE's own on-chain verifier with the real match proof. Keeper cannot
self-report an outcome. Twenty minutes after full time, it settled itself.

**[Terminal: verify-anchors demo-blotter → MATCH, then the sed one-liner, re-run → MISMATCH]**

Here's the tamper check. Every anchor verifies... now I flip a single digit in the
blotter... and verification fails. The track record can't be rewritten.

**[Terminal: npx tsx scripts/verify-txline-proof.ts 18257865 1195 1,2]**

And it goes both ways — we independently verify the feed we trade on, byte-exact
against TxLINE's on-chain roots.

---

## Section 4 — Live, right now (3:45–4:30)

**[Screen: keeper.h-dhaliwal2250.workers.dev — Spain v Argentina tab, LIVE badge]**

And this is not a simulation — this is the World Cup final, live, right now.
Keeper found this fixture in TxLINE's feed on its own, flipped itself to live
ingestion half an hour before kickoff, and it's quoting the final as I speak —
recording every tick and anchoring its book on-chain. Last night it did the same
for France–England, start to finish, and settled itself. Nobody touched anything.

---

## Section 5 — Close (4:30–5:00)

**[Screen: curl /health, click HALT → badge flips → RESUME]**

Production-wise: one Docker image on Cloudflare, a hundred and twenty-six tests —
including determinism and no-arbitrage as property tests — health and metrics
endpoints, and exactly one human control: the kill switch.

Keeper — an autonomous market maker whose entire book is an on-chain fact.
Data by TxLINE. Settlement proven by TxLINE's own program. Thanks for watching.

---

*Timing check: ~640 spoken words ≈ 4:40 at 135 wpm — leaves ~20s of slack for
the goal moment in Section 2.*
