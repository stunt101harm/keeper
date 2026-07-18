//! keeper_book — Keeper's market-maker book, live on Solana devnet.
//!
//! Keeper is an autonomous in-play market maker on TxLINE World Cup data.
//! Off-chain it quotes 1X2 prices, fills flow, and appends every engine event
//! to a seq-stamped blotter. This program is the on-chain half:
//!
//! 1. `init_book`      — one PDA per fixture, keyed ["book", fixture_id LE].
//! 2. `record_epoch`   — the maker periodically commits a Merkle root over the
//!    blotter's next seq range plus its current inventory / mark-to-market.
//!    Continuity (`seq_start == stored seq_end`) is enforced ON-CHAIN, so the
//!    chain itself guarantees the anchored blotter has no gaps: you cannot
//!    skip an embarrassing range and keep anchoring.
//! 3. `settle_book`    — PROOF-GATED settlement. The book can only be settled
//!    against TxLINE's cryptographically proven final score, via CPI into
//!    TxLINE's own on-chain verifier (`validate_stat_v2`). No admin key, no
//!    "authority posts the result" — the result is whatever the proof proves.
//!
//! Settlement is PERMISSIONLESS by design: anyone (a judge, a rival, a cron
//! job) may call `settle_book`, because nothing the caller controls can change
//! the outcome. The caller supplies only a Merkle proof that TxLINE's program
//! either verifies against its own on-chain daily root or rejects (aborting
//! the whole transaction), plus which epoch-day root to check — and the
//! epoch-day is range-gated against book state. The proven leaf VALUES (final
//! goals for participant 1 and 2) decide the winner; the caller merely
//! delivers the envelope.
//!
//! The TxLINE interface below is a hand-verified port of the spike-tested
//! integration in the corner-case project (same author): byte-exact borsh
//! mirrors of the `txoracle` IDL types, the `validate_stat_v2` discriminator
//! lifted verbatim from the IDL, and the CPI + return-data pattern verified
//! against the live devnet program.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
    pubkey,
};

declare_id!("BhstTkGhG1LLPYBt3E3n4PTZ3v1V6ukNHYvQ88rgvTHS");

// ---------------------------------------------------------------------------
// TxLINE txoracle interface (devnet) — hand-verified, ported from corner-case
// ---------------------------------------------------------------------------

/// TxLINE txoracle program (devnet). Mainnet would be
/// `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`; a devnet-only pin is
/// deliberate — a cluster switch is a recompile, not a config knob.
pub const TXORACLE_ID: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

/// Anchor discriminator for `validate_stat_v2`, lifted verbatim from TxLINE's
/// IDL — not re-derived, so an upstream rename can't silently point us at a
/// different handler.
pub const VALIDATE_STAT_V2_DISCRIMINATOR: [u8; 8] = [208, 215, 194, 214, 241, 71, 246, 178];

/// Seed for TxLINE's daily scores Merkle-root accounts:
/// `["daily_scores_roots", epoch_day u16 LE]` under TXORACLE_ID.
pub const DAILY_SCORES_ROOTS_SEED: &[u8] = b"daily_scores_roots";

/// `ScoreStat.period` stamped on leaves proven from a `game_finalised` record
/// (StatusId 100). Spike-verified: halftime leaves carry 3, final leaves 100.
pub const FINAL_PERIOD: i32 = 100;

/// TxLINE stat keys: 1 = participant-1 goals, 2 = participant-2 goals.
pub const GOALS_P1_KEY: u32 = 1;
pub const GOALS_P2_KEY: u32 = 2;

/// The `NDimensionalStrategy` argument `validate_stat_v2` requires, as raw
/// borsh bytes appended verbatim after the payload (the exact pattern
/// corner-case uses for its stored strategy bytes). We hard-code a tautology
/// over BOTH goal leaves — `Binary { 0 + 1, predicate: { threshold: -1,
/// GreaterThan } }` — because Keeper does not care about TxLINE's predicate
/// verdict at all: the VALUES of the proven leaves are the settlement input,
/// and TxLINE hard-errors on any invalid proof, so CPI success already means
/// "these leaves are proven against the on-chain root". Goal counts are never
/// negative, so `goals[0] + goals[1] > -1` is always true.
///
/// The predicate must reference EVERY leaf: TxLINE rejects proofs whose
/// strategy leaves a stat unevaluated (`IncompleteStatCoverage`, error 6071 —
/// verified live against the devnet program; a `Single { index: 0 }`
/// tautology fails exactly there).
///
/// Layout (byte-verified against the IDL + corner-case's hand-rolled encoder;
/// Anchor 0.31's standalone types coder is broken for this nested enum):
///   u32 LE 0   geometric_targets: empty vec
///   u8     0   distance_predicate: None
///   u32 LE 1   discrete_predicates: one entry
///   u8     1   StatPredicate::Binary
///   u8     0     index_a = 0 (leaf 0 = P1 goals)
///   u8     1     index_b = 1 (leaf 1 = P2 goals)
///   u8     0     op = BinaryExpression::Add
///   i32 LE -1    predicate.threshold
///   u8     0     predicate.comparison = GreaterThan
pub const ALWAYS_TRUE_STRATEGY: [u8; 18] = [
    0, 0, 0, 0, // geometric_targets: vec len 0
    0, // distance_predicate: None
    1, 0, 0, 0, // discrete_predicates: vec len 1
    1, // variant 1 = Binary
    0, // index_a = 0
    1, // index_b = 1
    0, // op 0 = Add
    0xFF, 0xFF, 0xFF, 0xFF, // threshold = -1 (i32 LE)
    0, // comparison 0 = GreaterThan
];

/// One sibling hash in a Merkle path.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

/// Fixture-level summary — the node that binds a proof to ONE fixture.
/// `fixture_id` living inside the proven chain is what makes on-chain fixture
/// binding possible (the FixtureMismatch gate below).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

/// A single provable key/value statistic — the innermost Merkle leaf.
/// `period` is the match-status period of the underlying score record
/// (3 = halftime, 100 = game finalised), NOT the stat key's period prefix.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatLeaf {
    pub stat: ScoreStat,
    pub stat_proof: Vec<ProofNode>,
}

/// Full `validate_stat_v2` payload (TxLINE IDL: `StatValidationInput`),
/// exactly as the stat-validation endpoint hands it to the settler. Borsh
/// round-trips are canonical: deserializing the caller-built payload and
/// re-serializing it here yields identical bytes, so the proof the caller
/// fetched is the proof TxLINE verifies.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatValidationInput {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub event_stat_root: [u8; 32],
    pub stats: Vec<StatLeaf>,
}

// ---------------------------------------------------------------------------
// Book state
// ---------------------------------------------------------------------------

pub const BOOK_SEED: &[u8] = b"book";

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_SETTLED: u8 = 1;

pub const WINNER_P1: u8 = 0;
pub const WINNER_DRAW: u8 = 1;
pub const WINNER_P2: u8 = 2;
pub const WINNER_UNSET: u8 = 255;

/// One market-maker book per fixture. PDA: `["book", fixture_id i64 LE]`.
#[account]
pub struct BookState {
    /// The maker's wallet — the only signer allowed to record epochs.
    pub authority: Pubkey,
    /// TxLINE fixture id (i64 to match TxLINE's own encoding).
    pub fixture_id: i64,
    /// Kickoff epoch-day (UTC days since epoch). Settlement accepts proofs
    /// under this day's root or the next (evening kickoffs finalise past
    /// 00:00 UTC).
    pub epoch_day: u16,
    /// TxLINE `Participant1IsHome` — maps proven P1/P2 goals to home/away.
    pub p1_is_home: bool,
    /// Number of epochs recorded so far.
    pub epoch_count: u32,
    /// Merkle root of the most recent anchored blotter batch.
    pub latest_root: [u8; 32],
    /// EXCLUSIVE end of the anchored seq range == the next expected
    /// `seq_start` == total events anchored. Storing the exclusive bound makes
    /// the continuity check a single equality (`seq_start == seq_end`) with no
    /// first-epoch special case.
    pub seq_end: u64,
    /// Signed inventory per outcome [home, draw, away], stake units ×1e6.
    pub inventory_micro: [i64; 3],
    /// Mark-to-market P&L at the last recorded epoch, stake units ×1e6.
    pub mtm_pnl_micro: i64,
    /// STATUS_OPEN | STATUS_SETTLED.
    pub status: u8,
    /// Final [P1 goals, P2 goals] proven by TxLINE. Meaningful once settled.
    pub proven_goals: [i32; 2],
    /// WINNER_P1 | WINNER_DRAW | WINNER_P2, WINNER_UNSET until settled.
    pub winner: u8,
    pub bump: u8,
}

impl BookState {
    /// 8 (discriminator) + 32 + 8 + 2 + 1 + 4 + 32 + 8 + 24 + 8 + 1 + 8 + 1 + 1
    pub const SPACE: usize = 8 + 32 + 8 + 2 + 1 + 4 + 32 + 8 + 24 + 8 + 1 + 8 + 1 + 1;
}

// ---------------------------------------------------------------------------
// Events — the queryable audit trail
// ---------------------------------------------------------------------------

/// Emitted once per anchored blotter batch. Together with the on-chain
/// continuity gate this forms a gap-free, queryable audit trail: replaying a
/// book's EpochRecorded events reconstructs the full anchored history, and
/// `scripts/verify-anchors.ts` checks each event's root against a local
/// recomputation from the blotter.
#[event]
pub struct EpochRecorded {
    pub fixture_id: i64,
    pub epoch_count: u32,
    pub root: [u8; 32],
    /// Inclusive start of the anchored seq range.
    pub seq_start: u64,
    /// EXCLUSIVE end of the anchored seq range.
    pub seq_end: u64,
    pub inventory_micro: [i64; 3],
    pub mtm_pnl_micro: i64,
}

/// Emitted exactly once per book, when a TxLINE proof settles it.
#[event]
pub struct BookSettled {
    pub fixture_id: i64,
    /// Proven final [P1 goals, P2 goals].
    pub proven_goals: [i32; 2],
    /// WINNER_P1 | WINNER_DRAW | WINNER_P2.
    pub winner: u8,
    /// Epoch-day whose TxLINE root the proof verified against.
    pub epoch_day: u16,
    /// Timestamp of the proven score record (ms epoch, from the proof).
    pub proof_ts: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum KeeperBookError {
    #[msg("signer is not the book authority")]
    Unauthorized,
    #[msg("record_epoch seq_start does not equal the stored seq_end — blotter continuity broken")]
    ContinuityBroken,
    #[msg("record_epoch range is empty (seq_end must be > seq_start)")]
    EmptyEpochRange,
    #[msg("book is already settled")]
    AlreadySettled,
    #[msg("epoch_day must be the book's stored day or the next day")]
    EpochDayOutOfRange,
    #[msg("proof is for a different fixture than this book")]
    FixtureMismatch,
    #[msg("proof leaves must be exactly the goal stat keys [1, 2], in order")]
    StatKeysMismatch,
    #[msg("proof leaf is not from the game_finalised record (period != 100)")]
    ProofNotFinal,
    #[msg("txline_roots is not the daily_scores_roots PDA for this epoch_day")]
    InvalidRootsAccount,
    #[msg("txline_program is not the TxLINE txoracle program")]
    InvalidTxlineProgram,
    #[msg("TxLINE returned no validation result")]
    NoValidationResult,
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(fixture_id: i64)]
pub struct InitBook<'info> {
    /// The maker. Pays rent and becomes the book's epoch-recording authority.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = BookState::SPACE,
        seeds = [BOOK_SEED, &fixture_id.to_le_bytes()],
        bump,
    )]
    pub book: Account<'info, BookState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordEpoch<'info> {
    /// Only the maker that opened the book may extend its anchored history.
    #[account(address = book.authority @ KeeperBookError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [BOOK_SEED, &book.fixture_id.to_le_bytes()],
        bump = book.bump,
    )]
    pub book: Account<'info, BookState>,
}

#[derive(Accounts)]
pub struct SettleBook<'info> {
    /// Permissionless caller — pays the fee, controls nothing else.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [BOOK_SEED, &book.fixture_id.to_le_bytes()],
        bump = book.bump,
    )]
    pub book: Account<'info, BookState>,

    /// TxLINE's daily scores Merkle-root account for `epoch_day`.
    /// CHECK: the handler re-derives the PDA from the epoch_day ARG against
    /// TXORACLE_ID (never our own program id — the classic foreign-PDA bug)
    /// and requires TxLINE ownership. A wrong-but-well-derived day simply
    /// fails proof validation inside TxLINE.
    pub txline_roots: UncheckedAccount<'info>,

    /// CHECK: pinned to TxLINE's program id; the runtime enforces that the
    /// CPI target is executable.
    #[account(address = TXORACLE_ID @ KeeperBookError::InvalidTxlineProgram)]
    pub txline_program: UncheckedAccount<'info>,
}

#[program]
pub mod keeper_book {
    use super::*;

    /// Open the on-chain book for one fixture. The payer becomes the only
    /// wallet that can record epochs; settlement stays permissionless.
    pub fn init_book(
        ctx: Context<InitBook>,
        fixture_id: i64,
        epoch_day: u16,
        p1_is_home: bool,
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;
        book.authority = ctx.accounts.authority.key();
        book.fixture_id = fixture_id;
        book.epoch_day = epoch_day;
        book.p1_is_home = p1_is_home;
        book.epoch_count = 0;
        book.latest_root = [0u8; 32];
        book.seq_end = 0; // next expected seq_start — the blotter starts at 0
        book.inventory_micro = [0; 3];
        book.mtm_pnl_micro = 0;
        book.status = STATUS_OPEN;
        book.proven_goals = [0; 2];
        book.winner = WINNER_UNSET;
        book.bump = ctx.bumps.book;
        Ok(())
    }

    /// Anchor one blotter batch: Merkle root over engine events
    /// `[seq_start, seq_end)` plus the maker's inventory and mark-to-market
    /// P&L at the end of the batch (stake units ×1e6).
    ///
    /// The continuity gate is the on-chain guarantee that the anchored
    /// blotter has no gaps: each epoch must begin exactly where the previous
    /// one ended (`seq_start == stored seq_end`, which starts at 0), so the
    /// maker cannot quietly skip a range of events and keep anchoring.
    ///
    /// Deliberately still allowed AFTER settlement: the audit trail may keep
    /// appending (post-final P&L snapshots flush late), while the settlement
    /// verdict — proven_goals / winner / status — is written exactly once by
    /// `settle_book` and never touched here. Rejecting late epochs would only
    /// create a liveness footgun (an anchorer retrying a range forever), not
    /// security.
    pub fn record_epoch(
        ctx: Context<RecordEpoch>,
        root: [u8; 32],
        seq_start: u64,
        seq_end: u64,
        inventory_micro: [i64; 3],
        mtm_pnl_micro: i64,
    ) -> Result<()> {
        let book = &mut ctx.accounts.book;

        require!(seq_start == book.seq_end, KeeperBookError::ContinuityBroken);
        require!(seq_end > seq_start, KeeperBookError::EmptyEpochRange);

        book.latest_root = root;
        book.seq_end = seq_end;
        book.inventory_micro = inventory_micro;
        book.mtm_pnl_micro = mtm_pnl_micro;
        book.epoch_count += 1;

        emit!(EpochRecorded {
            fixture_id: book.fixture_id,
            epoch_count: book.epoch_count,
            root,
            seq_start,
            seq_end,
            inventory_micro,
            mtm_pnl_micro,
        });
        Ok(())
    }

    /// Settle the book against TxLINE's proven final score. PERMISSIONLESS:
    /// nothing the caller supplies can steer the outcome —
    ///
    ///  - the payload either chains to TxLINE's own on-chain daily root
    ///    (checked by TxLINE itself, via CPI) or the whole tx aborts;
    ///  - the gates below pin WHICH proof is acceptable: this fixture's
    ///    (fixture bind), final whistle only (finality), the goal stats and
    ///    nothing else (stat-key bind), under the expected day's root
    ///    (epoch window);
    ///  - the winner is computed from the proven leaf values, not from any
    ///    argument.
    ///
    /// So the "worst" a malicious caller can do is settle the book correctly.
    pub fn settle_book(
        ctx: Context<SettleBook>,
        epoch_day: u16,
        payload: StatValidationInput,
    ) -> Result<()> {
        let book = &ctx.accounts.book;

        // Settle exactly once.
        require!(book.status == STATUS_OPEN, KeeperBookError::AlreadySettled);

        // Gate: epoch window. The init-time epoch_day is the kickoff day; an
        // evening kickoff can finalise after 00:00 UTC under the next day's
        // root. Accepting exactly {stored, stored+1} stops the caller from
        // shopping arbitrary historical roots while never stranding a late
        // final whistle.
        require!(
            epoch_day == book.epoch_day || epoch_day == book.epoch_day.wrapping_add(1),
            KeeperBookError::EpochDayOutOfRange
        );

        // Gate: fixture bind. The fixture id lives INSIDE the proven summary
        // node, so this one comparison pins the whole proof to the match this
        // book actually made markets on.
        require!(
            payload.fixture_summary.fixture_id == book.fixture_id,
            KeeperBookError::FixtureMismatch
        );

        // Gate: stat-key bind. Settlement reads goals from leaves [0] and [1],
        // so those leaves must prove exactly keys 1 (P1 goals) and 2 (P2
        // goals), in order — a valid proof of, say, corners must not be able
        // to masquerade as a scoreline.
        require!(payload.stats.len() == 2, KeeperBookError::StatKeysMismatch);
        require!(
            payload.stats[0].stat.key == GOALS_P1_KEY && payload.stats[1].stat.key == GOALS_P2_KEY,
            KeeperBookError::StatKeysMismatch
        );

        // Gate: finality. Leaves proven from a mid-match record carry that
        // record's status period (3 = halftime). Requiring 100 on EVERY leaf
        // means only the game_finalised record can settle — a 1-0 halftime
        // score can never be passed off as the final result.
        for leaf in payload.stats.iter() {
            require!(leaf.stat.period == FINAL_PERIOD, KeeperBookError::ProofNotFinal);
        }

        // The roots account: re-derive against TxLINE's program id from the
        // caller's epoch_day arg and require TxLINE ownership.
        let (expected_roots, _) = Pubkey::find_program_address(
            &[DAILY_SCORES_ROOTS_SEED, &epoch_day.to_le_bytes()],
            &TXORACLE_ID,
        );
        require_keys_eq!(
            ctx.accounts.txline_roots.key(),
            expected_roots,
            KeeperBookError::InvalidRootsAccount
        );
        require!(
            ctx.accounts.txline_roots.owner == &TXORACLE_ID,
            KeeperBookError::InvalidRootsAccount
        );

        // CPI into TxLINE's verifier: discriminator + payload (canonical borsh
        // round-trip of what the settler fetched from the stat-validation
        // endpoint) + the constant always-true strategy bytes. TxLINE
        // hard-errors on ANY invalid proof, aborting this transaction — so
        // reaching the next line means every leaf above is proven against the
        // root TxLINE itself posted for this epoch_day.
        let mut data = Vec::with_capacity(8 + 512 + ALWAYS_TRUE_STRATEGY.len());
        data.extend_from_slice(&VALIDATE_STAT_V2_DISCRIMINATOR);
        payload.serialize(&mut data)?;
        data.extend_from_slice(&ALWAYS_TRUE_STRATEGY);

        let ix = Instruction {
            program_id: TXORACLE_ID,
            accounts: vec![AccountMeta::new_readonly(
                ctx.accounts.txline_roots.key(),
                false,
            )],
            data,
        };
        invoke(
            &ix,
            &[
                ctx.accounts.txline_roots.to_account_info(),
                ctx.accounts.txline_program.to_account_info(),
            ],
        )?;

        // Defense in depth: require that a verdict came back and that it came
        // from TxLINE's program id (not some inner CPI). We do NOT branch on
        // the verdict — the strategy is a tautology and the settlement input
        // is the proven leaf VALUES — but a missing/foreign return value
        // would mean the CPI did not run the code we think it ran.
        let (returning_program, ret) =
            get_return_data().ok_or(KeeperBookError::NoValidationResult)?;
        require_keys_eq!(
            returning_program,
            TXORACLE_ID,
            KeeperBookError::NoValidationResult
        );
        require!(ret.len() == 1, KeeperBookError::NoValidationResult);

        // The proven final score decides the winner. From here on, pure state.
        let goals_p1 = payload.stats[0].stat.value;
        let goals_p2 = payload.stats[1].stat.value;
        let winner = if goals_p1 > goals_p2 {
            WINNER_P1
        } else if goals_p1 < goals_p2 {
            WINNER_P2
        } else {
            WINNER_DRAW
        };

        let book = &mut ctx.accounts.book;
        book.proven_goals = [goals_p1, goals_p2];
        book.winner = winner;
        book.status = STATUS_SETTLED;

        emit!(BookSettled {
            fixture_id: book.fixture_id,
            proven_goals: [goals_p1, goals_p2],
            winner,
            epoch_day,
            proof_ts: payload.ts,
        });
        Ok(())
    }
}
