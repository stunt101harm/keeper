# Keeper — Quoting Model

The trading core is a **deterministic reducer**: state advances only via `onTick(tick)`, no
wall-clock reads, no RNG. Same tick stream ⇒ identical book, byte for byte. All prices are
**probabilities** in (0,1); decimal odds (1/p) exist only at the presentation edge.

Keeper is a *market-relative* maker: it quotes around a de-vigged consensus (TxLINE
StablePrice-Demargined), the way an ETF market maker quotes around NAV. The fill simulation's
counterparty is the price source itself — stated openly as a simulation assumption; the informed
leg is deliberately the worst case (every crossing fill is adversely selected).

## 1. Fair value

TxLINE's `TXLineStablePriceDemargined` feed already removes the vig; we renormalize defensively:

```
p_i = Pct_i / Σ_j Pct_j          i ∈ {home, draw, away}
```

Guards: all three legs present, finite, Pct > 0; otherwise the tick is treated as suspended.
Records with empty `Prices`/`Pct` are suspension markers → quotes pulled.

## 2. Volatility

EWMA of tick-to-tick **logit** changes, per outcome, with hardening:

```
x_i = logit(clamp(p_i, 0.01, 0.99))
d_i = clamp(x_i − x_i_prev, −0.5, +0.5)        (winsorized)
σ²_logit,i ← λ·σ²_logit,i + (1−λ)·d_i²,        λ = 2^(−1/H),  H = ewmaHalfLifeTicks (25)
σ_logit,i clamped to [0.005, 0.2]
```

Updates are **skipped** during freeze windows and on the first tick after reopen (a suspension
gap is one repricing, not variance). Pricing uses the probability-space mapping:

```
σ_i = σ_logit,i · p_i·(1−p_i)
```

## 3. Reservation price (inventory skew, sum-neutral)

Inventory risk lives only in the component orthogonal to (1,1,1) — a balanced book is cash.
With signed inventory q and **net exposure** `u_i = q_i − mean(q)`:

```
s_i    = γ · σ_i² · u_i               (raw skew, γ = 20)
r_i    = p_i − (s_i − mean(s))        (sum-neutral: Σ r_i = 1 identically)
r_i clamped to [0.01, 0.99]
```

γ calibration rule: skew at full cap ≈ one typical half-spread — γ·σ²·Q_cap ≈ δ_min at
σ ≈ 0.005, Q_cap = 10.

## 4. Spread and quotes

```
δ_i  = clamp(δ_min + k·σ_i, δ_min, δ_max) · w(t)     δ_min = 0.005, δ_max = 0.04, k = 1.5
bid_i = r_i − δ_i,   ask_i = r_i + δ_i
```

`w(t)` is the re-entry widener: `reentryWidenMult` (2×) immediately after a freeze, decaying
linearly to 1 over `reentryDecayTicks` (25).

Because Σr = 1: Σask = 1 + Σδ ≥ 1 + 3δ_min and Σbid ≤ 1 − 3δ_min — **arbitrage-free by
construction**, with 3δ_min as the explicit overround (the standard bookmaker convention).
After decimal-odds rounding (ask odds rounded down, bid odds up — the spread-widening
direction), the published implied sums are re-checked against margin m = `arbMargin` (0.01);
violations shift all three quotes uniformly.

Quoting cutoffs: no new quotes on an outcome with p outside [0.03, 0.97] (goal hazard stays
~constant while premium → 0; and a 0.005 spread at p = 0.01 publishes as odds 67 vs 200). The
risk-reducing side stays quoted if inventory is held. No quotes during the first `warmupTicks`
(20) while σ warms up.

## 5. Fills (deterministic, two legs)

**Informed leg** — the consensus mid crossing a resting quote fills it at our price:
mid ≤ bid ⇒ we buy; mid ≥ ask ⇒ we sell. At most one fill per outcome-side per tick;
re-quoting waits for the next tick. Every such fill is adversely selected by construction —
this is the stress leg.

**Benign leg** — the deterministic fluid limit of the Avellaneda–Stoikov exponential arrival
intensity λ(δ) = A·e^(−kδ). Per outcome-side accumulator:

```
I ← I + A·exp(−k_f·δ_i)        A = benignA (0.12), k_f = benignK (250)
I ≥ 1  ⇒  one clip fills AT our quote, no mid move, I ← I − 1
```

Tighter spreads earn more benign flow — the spread-revenue vs adverse-selection tradeoff that
makes γ, k, δ genuinely tunable. Target ≈ 3:1 benign:informed fill count.

## 6. Event handling

- **Freeze**: goal (30 s), red card (20 s), VAR (until resolution + 10 s, cap 120 s) — all in
  **feed time** (tick timestamps), never the machine clock, so replay determinism holds at any
  speed. During freeze: quotes pulled, no fills, no σ updates.
- **Price circuit breaker**: |Δlogit| > max(5σ_logit, 0.5) on any leg pulls quotes and starts a
  goal-length freeze — covers books repricing before the event message lands (the feed race).
  That tick's fill check is skipped.
- **Stale feed**: no odds tick for 10 s of feed time ⇒ halt (all quotes pulled) until flow resumes.

## 7. Risk state machine

`idle → quoting ⇄ frozen`, with overlays:
- **reduce_only**: |u_i| ≥ cap (10) on any outcome — only risk-reducing sides quoted.
- **flatten** (drawdown): equity (realized + MTM) drops ≥ 5 from its high-water mark —
  reduce-only until settlement.
- **halted**: stale feed or manual ops halt (`POST /api/halt` — the one intended human control).
- **settled**: on `fulltime`, outcomes resolve 0/1 and the book realizes.

## 8. P&L accounting

Marked against the same de-vigged p used for fair value. Decomposed cumulatively:

- **spreadCapture** = Σ_fills side·(mid_at_fill − fill_price)·size — what quoting earns
- **inventoryDrift** = Σ_ticks q·Δmid — what holding earned/lost
- **settlementResidual** = settlement value − final marks

Invariant: spreadCapture + inventoryDrift + settlementResidual = realized + MTM P&L at every
tick (unit-tested). The dashboard charts all three against a do-nothing baseline, so a lucky
final score reads as inventory drift, not skill.

## 9. Known approximations (disclosed)

- Multiplicative renormalization retains a favourite-longshot bias; the p ∈ [0.03, 0.97] cutoff
  truncates the worst region.
- Marking at consensus mid overstates liquidation value (exit costs a spread); settlement
  closes the gap at full time.
- The benign-flow leg is a fluid-limit model, not order-book data — its parameters (A, k_f) are
  tuned to a 3:1 benign:informed ratio on recorded World Cup data.
