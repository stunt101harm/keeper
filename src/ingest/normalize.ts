/**
 * normalize.ts — TxLINE API records → normalized domain Ticks.
 *
 * The Normalizer is stateful per fixture because three things require memory:
 *  - home/away mapping: TxLINE speaks part1/part2 and Participant1IsHome comes
 *    from the fixture registry, not the odds record;
 *  - suspension: a suspended odds record (empty Prices/Pct) carries no prices,
 *    so the tick re-publishes the last known odds with suspended: true;
 *  - dedupe: odds snapshots overlap with streams/buckets, so any record with
 *    Ts ≤ the last emitted odds Ts for that fixture is dropped;
 *  - second-half detection: a kickoff after halftime_finalised is the
 *    second-half restart, not a new match.
 *
 * Feed records in Ts/Seq order per fixture (sort snapshots before feeding).
 */

import type { FixtureInfo, MatchEventType, OddsTick, Outcome, ScoreTick } from '../types.js';
import type { FixtureMeta, OddsRecord, ScoreRecord } from './client.js';

/** The one consensus feed Keeper quotes around. */
export const CONSENSUS_BOOKMAKER = 'TXLineStablePriceDemargined';
export const CONSENSUS_MARKET = '1X2_PARTICIPANT_RESULT';

export function fixtureToInfo(meta: FixtureMeta): FixtureInfo {
  return {
    id: String(meta.FixtureId),
    home: meta.Participant1IsHome ? meta.Participant1 : meta.Participant2,
    away: meta.Participant1IsHome ? meta.Participant2 : meta.Participant1,
    kickoffTs: meta.StartTime,
    competition: meta.Competition,
  };
}

interface FixtureState {
  p1IsHome: boolean;
  lastOdds: Record<Outcome, number> | null;
  /** Ts of the last emitted odds tick — dedupe gate. */
  lastOddsTs: number;
  seenHalftime: boolean;
  lastScore: { home: number; away: number };
}

export class Normalizer {
  private readonly fixtures = new Map<number, FixtureState>();

  /** Register (or refresh) a fixture; returns the normalized FixtureInfo. */
  registerFixture(meta: FixtureMeta): FixtureInfo {
    const existing = this.fixtures.get(meta.FixtureId);
    if (existing) {
      existing.p1IsHome = meta.Participant1IsHome;
    } else {
      this.fixtures.set(meta.FixtureId, {
        p1IsHome: meta.Participant1IsHome,
        lastOdds: null,
        lastOddsTs: -Infinity,
        seenHalftime: false,
        lastScore: { home: 0, away: 0 },
      });
    }
    return fixtureToInfo(meta);
  }

  isRegistered(fixtureId: number): boolean {
    return this.fixtures.has(fixtureId);
  }

  /**
   * OddsRecord → OddsTick, or null when the record is not the consensus 1X2
   * market, the fixture is unknown, it is a Ts-duplicate, or it is a
   * suspension marker with no prior odds to re-publish.
   */
  normalizeOdds(rec: OddsRecord): OddsTick | null {
    if (rec.Bookmaker !== CONSENSUS_BOOKMAKER || rec.SuperOddsType !== CONSENSUS_MARKET) {
      return null;
    }
    // Period-scoped variants (e.g. MarketPeriod "half=1", the H1-result market)
    // share this SuperOddsType and interleave on the same feed — mixing them
    // into one price stream produced violent fake jumps (verified live on
    // 18241006). Only the full-match line (null period, null parameters) is
    // the consensus Keeper trades on.
    if (rec.MarketPeriod != null || rec.MarketParameters != null) return null;
    const state = this.fixtures.get(rec.FixtureId);
    if (!state) return null;
    if (!Number.isFinite(rec.Ts) || rec.Ts <= state.lastOddsTs) return null; // dedupe

    const odds = this.oddsFromPct(rec, state.p1IsHome);
    if (odds === null) {
      // Suspension marker (empty Prices/Pct, or unusable Pct like "NA").
      if (!state.lastOdds) return null; // nothing known yet — nothing to publish
      state.lastOddsTs = rec.Ts;
      return {
        kind: 'odds',
        fixtureId: String(rec.FixtureId),
        ts: rec.Ts,
        odds: { ...state.lastOdds },
        suspended: true,
      };
    }
    state.lastOdds = odds;
    state.lastOddsTs = rec.Ts;
    return { kind: 'odds', fixtureId: String(rec.FixtureId), ts: rec.Ts, odds };
  }

  /**
   * Decimal odds per outcome from the demargined Pct legs: p_i = Pct_i/100 →
   * odds_i = 1/p_i, 3dp. Null when the record cannot yield three sane legs
   * (treated as suspended, per docs/MODEL.md guards).
   */
  private oddsFromPct(rec: OddsRecord, p1IsHome: boolean): Record<Outcome, number> | null {
    if (rec.Prices.length === 0 || rec.Pct.length === 0) return null;
    const idx = {
      part1: rec.PriceNames.indexOf('part1'),
      draw: rec.PriceNames.indexOf('draw'),
      part2: rec.PriceNames.indexOf('part2'),
    };
    if (idx.part1 < 0 || idx.draw < 0 || idx.part2 < 0) return null;
    const legs: number[] = [];
    for (const i of [idx.part1, idx.draw, idx.part2]) {
      const pct = Number.parseFloat(rec.Pct[i] ?? '');
      if (!Number.isFinite(pct) || pct <= 0) return null;
      legs.push(Math.round((100 / pct) * 1000) / 1000); // 1/(pct/100), 3dp
    }
    const [part1, draw, part2] = legs as [number, number, number];
    return {
      home: p1IsHome ? part1 : part2,
      draw,
      away: p1IsHome ? part2 : part1,
    };
  }

  /** ScoreRecord → ScoreTick, or null when the fixture is unknown. */
  normalizeScore(rec: ScoreRecord): ScoreTick | null {
    const state = this.fixtures.get(rec.FixtureId);
    if (!state) return null;

    const event = this.mapEvent(rec, state);
    const score = this.extractScore(rec, state);

    const tick: ScoreTick = {
      kind: 'score',
      fixtureId: String(rec.FixtureId),
      ts: rec.Ts,
      score,
      event,
    };
    const seconds = rec.Clock?.Seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      tick.minute = Math.floor(seconds / 60);
    }
    return tick;
  }

  private mapEvent(rec: ScoreRecord, state: FixtureState): MatchEventType {
    const action = (rec.Action ?? '').toLowerCase();
    if (action.includes('var')) return 'var';
    // Mapping is by Action only: StatusId can echo on later records (e.g. a
    // trailing 'disconnected' after game_finalised) and must not re-trigger
    // halftime/fulltime semantics.
    if (action === 'halftime_finalised') {
      state.seenHalftime = true;
      return 'halftime';
    }
    if (action === 'game_finalised') return 'fulltime';
    if (action === 'kickoff' || action === 'resume') {
      return state.seenHalftime ? 'second_half' : 'kickoff';
    }
    if (action === 'goal') return 'goal';
    if (action === 'red_card') return 'red_card';
    return 'other';
  }

  /**
   * Per-leg fallback chain: Score.Total.Goals → Stats key → last known.
   * Per-leg matters: a 0-goal side OMITS the Goals key inside Score.Total
   * (verified on 18241006 Seq 539: P1 Total {Goals:1,…}, P2 Total has no
   * Goals), and the Stats goal counters lag the Score board by a record or
   * two around each goal.
   */
  private extractScore(rec: ScoreRecord, state: FixtureState): { home: number; away: number } {
    const lastP1 = state.p1IsHome ? state.lastScore.home : state.lastScore.away;
    const lastP2 = state.p1IsHome ? state.lastScore.away : state.lastScore.home;
    const leg = (board: number | undefined, stat: number | undefined, last: number): number => {
      // Score-board goals are authoritative when present — they may legally
      // DECREASE (VAR overturn). The Stats counters lag the board by a couple
      // of records around each goal (verified on 18241006: Seq 829 'possible'
      // still has Stats '2'=0 after the 828 goal), so a Stats-sourced value is
      // clamped to never roll an already-published goal back.
      if (board !== undefined) return board;
      if (stat !== undefined) return Math.max(stat, last);
      return last;
    };
    const p1 = leg(rec.Score?.Participant1?.Total?.Goals, rec.Stats?.['1'], lastP1);
    const p2 = leg(rec.Score?.Participant2?.Total?.Goals, rec.Stats?.['2'], lastP2);
    const score = state.p1IsHome ? { home: p1, away: p2 } : { home: p2, away: p1 };
    state.lastScore = score;
    return { ...score };
  }
}
