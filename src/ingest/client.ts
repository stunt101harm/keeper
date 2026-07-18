/**
 * client.ts — typed REST client over authedFetch for the TxLINE API.
 *
 * Verified surface (live probes, 2026-07-17):
 *   GET /fixtures/snapshot?competitionId=&startEpochDay=  → FixtureMeta[]
 *   GET /odds/snapshot/{fixtureId}?asOf=                  → OddsRecord[]
 *   GET /odds/updates/{epochDay}/{hourOfDay}/{interval}   → 5-min bucket of OddsRecord
 *   GET /scores/snapshot/{fixtureId}                      → ScoreRecord[]
 *   GET /scores/historical/{fixtureId}                    → SSE-formatted TEXT, full match log
 *
 * Field names mirror the API exactly — no renaming, so recorded JSON, live
 * JSON and these types never drift apart.
 *
 * Note on /scores/snapshot: it does NOT return one merged state object — it
 * returns an array with the LATEST RECORD PER ACTION TYPE (a finished match's
 * max-Seq record can be a StatusId-less "disconnected"). summariseSnapshot()
 * reduces that to the current state a caller wants.
 */

import type { TxlineAuth } from './auth.js';
import { parseSseText } from './sse.js';

// ---------------------------------------------------------------------------
// API record types
// ---------------------------------------------------------------------------

export interface FixtureMeta {
  Ts: number;
  /** Kickoff, epoch ms. */
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
  /** Numeric in /fixtures/snapshot, string ("scheduled") inside score records. */
  GameState: number | string;
}

export interface OddsRecord {
  FixtureId: number;
  MessageId: string;
  /** Epoch ms. */
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  /** e.g. "1X2_PARTICIPANT_RESULT", "ASIANHANDICAP_PARTICIPANT_GOALS". */
  SuperOddsType: string;
  GameState: unknown;
  InRunning: boolean;
  MarketParameters: string | null;
  /** null = full-match line; "half=1" etc. mark period-scoped variants. */
  MarketPeriod: string | null;
  /** e.g. ["part1","draw","part2"]. */
  PriceNames: string[];
  /** Decimal odds ×1000. EMPTY array = market suspended. */
  Prices: number[];
  /** Demargined percentages as strings ("51.230"), summing ≈100; may be "NA". */
  Pct: string[];
  [key: string]: unknown;
}

export interface PeriodScore {
  Goals?: number;
  YellowCards?: number;
  RedCards?: number;
  Corners?: number;
}

export interface ParticipantScore {
  H1?: PeriodScore;
  HT?: PeriodScore;
  H2?: PeriodScore;
  Total?: PeriodScore;
}

export interface ScoreBoard {
  Participant1?: ParticipantScore;
  Participant2?: ParticipantScore;
}

export interface ScoreRecord {
  FixtureId: number;
  /** kickoff | goal | corner | yellow_card | shot | halftime_finalised | game_finalised | … */
  Action: string;
  Id?: number;
  /** Epoch ms. */
  Ts: number;
  Seq: number;
  /** 3 = halftime finalised, 100 = game finalised (the settlement trigger). */
  StatusId?: number;
  GameState?: number | string;
  StartTime?: number;
  CompetitionId?: number;
  Clock?: { Running: boolean; Seconds: number };
  Score?: ScoreBoard;
  /** Stat key → value. Keys: 1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners (P1/P2); +1000 = H1, +3000 = H2. */
  Stats?: Record<string, number>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Scores-snapshot summarisation
// ---------------------------------------------------------------------------

export interface SnapshotSummary {
  maxSeq: number;
  /** StatusId of the highest-Seq record that carries one. */
  statusId?: number;
  /** True iff any record in the snapshot has StatusId 100 (game_finalised). */
  finalised: boolean;
  /** Seq of the game_finalised record, when finalised. */
  finalisedSeq?: number;
  /** The highest-Seq record overall (freshest clock/score/stats). */
  latest?: ScoreRecord;
}

/**
 * Reduce a /scores/snapshot array (latest-record-per-action) to current state.
 * Finalisation detection deliberately scans ALL records rather than trusting
 * the max-Seq one: the last record of a finished match is often a StatusId-less
 * "disconnected" (observed live on 18241006, Seq 963), so the max-Seq record
 * alone would hide the finalisation.
 */
export function summariseSnapshot(records: ScoreRecord[]): SnapshotSummary {
  const summary: SnapshotSummary = { maxSeq: -1, finalised: false };
  let statusSeq = -1;
  for (const rec of records) {
    if (rec.Seq > summary.maxSeq) {
      summary.maxSeq = rec.Seq;
      summary.latest = rec;
    }
    if (rec.StatusId !== undefined && rec.Seq > statusSeq) {
      statusSeq = rec.Seq;
      summary.statusId = rec.StatusId;
    }
    if (rec.StatusId === 100 || rec.Action === 'game_finalised') {
      summary.finalised = true;
      summary.finalisedSeq =
        summary.finalisedSeq === undefined ? rec.Seq : Math.min(summary.finalisedSeq, rec.Seq);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface FixturesSnapshotParams {
  competitionId?: number;
  /** Days since epoch (UTC); the snapshot covers a 30-day window from here. */
  startEpochDay?: number;
}

export class TxlineClient {
  constructor(readonly auth: TxlineAuth) {}

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.auth.authedFetch(path);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`GET ${path} → HTTP ${res.status}${body ? `: ${body}` : ''}`);
    }
    return (await res.json()) as T;
  }

  fixturesSnapshot(params: FixturesSnapshotParams = {}): Promise<FixtureMeta[]> {
    const q = new URLSearchParams();
    if (params.competitionId !== undefined) q.set('competitionId', String(params.competitionId));
    if (params.startEpochDay !== undefined) q.set('startEpochDay', String(params.startEpochDay));
    const qs = q.toString();
    return this.getJson<FixtureMeta[]>(`/fixtures/snapshot${qs ? `?${qs}` : ''}`);
  }

  /** All current odds records for one fixture (every bookmaker/market). */
  oddsSnapshot(fixtureId: number, asOf?: number): Promise<OddsRecord[]> {
    const qs = asOf !== undefined ? `?asOf=${asOf}` : '';
    return this.getJson<OddsRecord[]>(`/odds/snapshot/${fixtureId}${qs}`);
  }

  /**
   * One 5-minute bucket of historical odds updates (ALL fixtures — callers
   * filter). epochDay = floor(ts_ms/86400000), hourOfDay 0–23 UTC,
   * interval 0–11 (5-minute slots within the hour).
   */
  oddsUpdates(epochDay: number, hourOfDay: number, interval: number): Promise<OddsRecord[]> {
    return this.getJson<OddsRecord[]>(`/odds/updates/${epochDay}/${hourOfDay}/${interval}`);
  }

  /** Current state of one fixture — array of latest-record-per-action. */
  scoresSnapshot(fixtureId: number): Promise<ScoreRecord[]> {
    return this.getJson<ScoreRecord[]>(`/scores/snapshot/${fixtureId}`);
  }

  /**
   * Full match log. The body is SSE-formatted TEXT (data:/id: lines), not a
   * stream and not JSON — undocumented but verified (id == Seq). ~1 MB for a
   * full match, hence the generous own timeout instead of the default 30s.
   */
  async scoresHistorical(fixtureId: number): Promise<ScoreRecord[]> {
    const res = await this.auth.authedFetch(`/scores/historical/${fixtureId}`, {
      noTimeout: true,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`GET /scores/historical/${fixtureId} → HTTP ${res.status}`);
    }
    const events = parseSseText(await res.text());
    return events.map((ev) => JSON.parse(ev.data) as ScoreRecord);
  }
}
