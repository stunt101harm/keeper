# TxLINE API Feedback (running log)

Our experience building Keeper on the TxLINE devnet API — kept as a running log per the
submission requirements; edited into a final section before submitting.

## 2026-07-18 (build day 1)

**Liked**

- **The free-tier auth chain worked first try with our own keypair.** Guest JWT → Token-2022
  ATA → `subscribe(1, 4)` (0 TxL) → `/token/activate` with the nacl-signed
  `txSig:leagues:jwt` message. The `tx-on-chain` runnable devnet examples are accurate — we
  adapted `subscription_free_tier.ts` and had a working `X-Api-Token` in minutes.
- **`TXLineStablePriceDemargined` is exactly what a market maker wants as fair value.** The
  de-vig is done server-side by the StablePrice engine, so the consensus probability vector is
  directly usable as a pricing anchor — we renormalize defensively and that's it.
- **Historical odds density is outstanding.** `/odds/updates/{epochDay}/{hour}/{interval}`
  returned ~1 in-running odds tick *per second* for a completed semifinal — dense enough to
  reconstruct a faithful replay of the whole match and backtest quoting logic against real
  World Cup price action. This single endpoint is what makes a post-deadline judge demo of a
  live-data agent possible at all.
- **Proof retention on devnet.** Validation proofs and `daily_scores_roots` PDAs for a
  days-old match still fetch and verify — replay-based verification demos stay reproducible.

**Friction**

- **Historical odds are time-bucketed, not fixture-scoped.** Reconstructing one match means
  sweeping every 5-minute bucket across its time window and filtering by `FixtureId` (~30
  requests for a match). A `/odds/historical/{fixtureId}` mirroring the (undocumented but
  excellent) `/scores/historical/{fixtureId}` would remove the sweep entirely.
- **Suspension is encoded as empty `Prices`/`Pct` arrays** on an otherwise normal odds record
  — easy to mis-handle as malformed data. A docs callout (or an explicit `Suspended` flag)
  would help.
- **The odds record schema is under-documented.** `SuperOddsType` values, `PriceNames`
  ordering, the ×1000 price scaling, and the demargined-vs-raw bookmaker distinction we
  learned by probing snapshots, not from the docs.
- **`X-Api-Token` requirement is discoverable only through the examples.** Every data endpoint
  403s with the guest JWT alone; the docs read as if the JWT might suffice for the free tier.
- **`weeks` must be a multiple of 4** — the on-chain error surfaces only from example-code
  validation, not the endpoint docs.

_(entries appended as the build continues)_
