# Wave-2 integration contracts (temporary — deleted after integration)

Binding interface agreements between the four wave-2 build agents. Code against
these shapes exactly; report divergence needs in your final report instead of
improvising.

## Config (already in src/config.ts — do not edit that file)

- `config.mode: 'live' | 'replay' | 'auto'`
- `config.solana.anchorTarget: 'program' | 'memo'` (default memo until the program ships)
- `config.solana.programId?: string` (env `KEEPER_PROGRAM_ID`)

## New server API (owned by agent M, consumed by agent D2)

- `GET /api/recordings` → `{ recordings: [{ file: string, fixture: FixtureInfo | null, ticks: number, bytes: number }] }`
  (every `data/*.jsonl` recording, meta line parsed; excludes events/anchors blotters)
- `GET /api/recordings/:file` → raw JSONL download (basename-validated, recordings only)
- `POST /api/replay/select` body `{ file: string }` → switches the active replay
  source to that recording (engine reset + state reset for the old fixture).
  Only valid when the effective source is replay; 409 otherwise.
- `GET /api/state` gains:
  - `activeSource: 'live' | 'replay'` (what the orchestrator is currently running)
  - `onchain?: { programId: string, network: 'devnet', books: Record<fixtureId, {
      address: string, latestRoot: string, seqEnd: number, epochCount: number,
      status: 'open' | 'settled', provenGoals?: [number, number], winner?: 'p1' | 'draw' | 'p2',
      settleSig?: string, explorerUrl: string }> }`
    (M exposes a `setOnchainProvider(fn)` hook on the server/state layer; the
    chain module registers the provider at startup — agent P documents the
    provider function shape in its report; integration wires them.)

## StatusEvent (src/types.ts — unchanged)

`mode` continues to reflect the *effective* source ('live' | 'replay') so the
dashboard badge just works; auto mode simply flips it at transitions.

## keeper_book program (agent P)

- PDA `["book", fixture_id i64 LE]`. Devnet. Instructions:
  `init_book(fixture_id, epoch_day, participant1_is_home)`,
  `record_epoch(root, seq_start, seq_end, inventory_micro [i64;3], mtm_pnl_micro)`
  (authority-gated, seq_start must equal stored seq_end — continuity enforced on-chain),
  `settle_book(epoch_day, payload: StatValidationInput)` — permissionless,
  CPIs TxLINE `validate_stat_v2`, gates: leaves are keys [1,2] in order, every
  leaf period == 100, `payload.fixture_summary.fixture_id == book.fixture_id`,
  epoch_day ∈ {stored, stored+1}. Stores proven goals + winner, status = settled.
- TS client `src/chain/book.ts` + auto-settler wired to engine `SettlementEvent`.
- `ANCHOR_TARGET=program` routes the anchorer's epoch commits to `record_epoch`
  instead of Memo (memo path stays intact as fallback).
