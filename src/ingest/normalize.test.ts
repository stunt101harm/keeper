import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OddsTick } from '../types.js';
import type { FixtureMeta, OddsRecord, ScoreRecord } from './client.js';
import { fixtureToInfo, Normalizer } from './normalize.js';

const wcFixtures = JSON.parse(
  readFileSync(new URL('../../fixtures/fixtures-wc.json', import.meta.url), 'utf8'),
) as FixtureMeta[];
const day20649Fixtures = JSON.parse(
  readFileSync(new URL('../../fixtures/fixtures-day20649.json', import.meta.url), 'utf8'),
) as FixtureMeta[];
const oddsSnapshot = JSON.parse(
  readFileSync(new URL('../../fixtures/odds-snapshot-18257865.json', import.meta.url), 'utf8'),
) as OddsRecord[];

const franceEngland = wcFixtures.find((f) => f.FixtureId === 18257865)!;

/** Hand-built flip fixture: Participant1 is the AWAY side. */
const flipMeta: FixtureMeta = {
  ...franceEngland,
  FixtureId: 999001,
  Participant1: 'AwayTeam',
  Participant2: 'HomeTeam',
  Participant1IsHome: false,
};

function consensusRecord(overrides: Partial<OddsRecord> = {}): OddsRecord {
  return {
    FixtureId: 18257865,
    MessageId: 'm1',
    Ts: 1_784_338_826_662,
    Bookmaker: 'TXLineStablePriceDemargined',
    BookmakerId: 10021,
    SuperOddsType: '1X2_PARTICIPANT_RESULT',
    GameState: null,
    InRunning: true,
    MarketParameters: null,
    MarketPeriod: null,
    PriceNames: ['part1', 'draw', 'part2'],
    Prices: [1952, 4204, 4005],
    Pct: ['51.230', '23.787', '24.969'],
    ...overrides,
  };
}

function scoreRecord(overrides: Partial<ScoreRecord> = {}): ScoreRecord {
  return {
    FixtureId: 18257865,
    Action: 'kickoff',
    Ts: 1_784_408_400_000,
    Seq: 10,
    ...overrides,
  };
}

describe('fixtureToInfo', () => {
  it('maps the real World Cup sample (Participant1IsHome=true)', () => {
    expect(fixtureToInfo(franceEngland)).toEqual({
      id: '18257865',
      home: 'France',
      away: 'England',
      kickoffTs: 1_784_408_400_000,
      competition: 'World Cup',
    });
  });

  it('swaps home/away when Participant1IsHome=false', () => {
    const info = fixtureToInfo(flipMeta);
    expect(info.home).toBe('HomeTeam');
    expect(info.away).toBe('AwayTeam');
  });

  it('handles every fixture in the broader day-20649 sample', () => {
    for (const meta of day20649Fixtures) {
      const info = fixtureToInfo(meta);
      expect(info.id).toBe(String(meta.FixtureId));
      expect(info.home).toBe(meta.Participant1IsHome ? meta.Participant1 : meta.Participant2);
      expect(info.kickoffTs).toBe(meta.StartTime);
    }
  });
});

describe('normalizeOdds', () => {
  it('extracts exactly the consensus 1X2 record from the real snapshot', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    const ticks = oddsSnapshot
      .map((r) => n.normalizeOdds(r))
      .filter((t): t is OddsTick => t !== null);
    // The committed snapshot has many AH/other records but ONE consensus 1X2.
    expect(ticks).toHaveLength(1);
    const tick = ticks[0]!;
    expect(tick).toMatchObject({ kind: 'odds', fixtureId: '18257865', ts: 1_784_338_826_662 });
    // odds_i = 1/(Pct_i/100), 3dp: 100/51.230, 100/23.787, 100/24.969
    expect(tick.odds).toEqual({ home: 1.952, draw: 4.204, away: 4.005 });
    expect(tick.suspended).toBeUndefined();
  });

  it('maps part1→away and part2→home when Participant1IsHome=false', () => {
    const n = new Normalizer();
    n.registerFixture(flipMeta);
    const tick = n.normalizeOdds(consensusRecord({ FixtureId: 999001 }));
    expect(tick?.odds).toEqual({ home: 4.005, draw: 4.204, away: 1.952 });
  });

  it('rejects non-consensus bookmakers and markets', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    expect(n.normalizeOdds(consensusRecord({ Bookmaker: 'SomeBook' }))).toBeNull();
    expect(
      n.normalizeOdds(consensusRecord({ SuperOddsType: 'ASIANHANDICAP_PARTICIPANT_GOALS' })),
    ).toBeNull();
  });

  it('rejects period-scoped 1X2 variants (the H1-result regime observed live on 18241006)', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    expect(
      n.normalizeOdds(
        consensusRecord({ MarketPeriod: 'half=1', Pct: ['15.246', '73.153', '11.596'] }),
      ),
    ).toBeNull();
    expect(n.normalizeOdds(consensusRecord({ MarketParameters: 'line=0' }))).toBeNull();
    // The full-match line (both null) still normalizes.
    expect(n.normalizeOdds(consensusRecord({ Ts: 1_784_338_826_700 }))).not.toBeNull();
  });

  it('rejects records for unregistered fixtures', () => {
    const n = new Normalizer();
    expect(n.normalizeOdds(consensusRecord())).toBeNull();
  });

  it('dedupes by Ts: equal or older timestamps are dropped', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    expect(n.normalizeOdds(consensusRecord({ Ts: 1000 }))).not.toBeNull();
    expect(n.normalizeOdds(consensusRecord({ Ts: 1000 }))).toBeNull(); // duplicate
    expect(n.normalizeOdds(consensusRecord({ Ts: 999 }))).toBeNull(); // out of order
    expect(n.normalizeOdds(consensusRecord({ Ts: 1001 }))).not.toBeNull();
  });

  it('publishes suspended ticks carrying the last known odds', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    const live = n.normalizeOdds(consensusRecord({ Ts: 1000 }))!;
    const susp = n.normalizeOdds(consensusRecord({ Ts: 2000, Prices: [], Pct: [] }));
    expect(susp).toEqual({
      kind: 'odds',
      fixtureId: '18257865',
      ts: 2000,
      odds: live.odds,
      suspended: true,
    });
    // Recovery after suspension publishes fresh odds again.
    const back = n.normalizeOdds(consensusRecord({ Ts: 3000 }));
    expect(back?.suspended).toBeUndefined();
  });

  it('drops suspension markers when no odds are known yet', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    expect(n.normalizeOdds(consensusRecord({ Prices: [], Pct: [] }))).toBeNull();
  });

  it('treats unusable Pct legs ("NA", zero) as suspended', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    const live = n.normalizeOdds(consensusRecord({ Ts: 1000 }))!;
    const na = n.normalizeOdds(
      consensusRecord({ Ts: 2000, Pct: ['NA', 'NA', 'NA'] }),
    );
    expect(na?.suspended).toBe(true);
    expect(na?.odds).toEqual(live.odds);
    const zero = n.normalizeOdds(
      consensusRecord({ Ts: 3000, Pct: ['0', '50.0', '50.0'] }),
    );
    expect(zero?.suspended).toBe(true);
  });

  it('never confuses a heartbeat-seconds timestamp with record ms (dedupe basis)', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    // A real record (ms) followed by a bogus seconds-scale Ts must be dropped
    // by the dedupe gate, not emitted as a time-travelling tick.
    expect(n.normalizeOdds(consensusRecord({ Ts: 1_784_338_826_662 }))).not.toBeNull();
    expect(n.normalizeOdds(consensusRecord({ Ts: 1_784_338_826 }))).toBeNull();
  });
});

describe('normalizeScore', () => {
  it('maps the standard event lifecycle including second-half kickoff', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    const ev = (rec: ScoreRecord) => n.normalizeScore(rec)?.event;
    expect(ev(scoreRecord({ Action: 'kickoff', Seq: 1 }))).toBe('kickoff');
    expect(ev(scoreRecord({ Action: 'goal', Seq: 2 }))).toBe('goal');
    expect(ev(scoreRecord({ Action: 'kickoff', Seq: 3 }))).toBe('kickoff'); // post-goal restart, H1
    expect(ev(scoreRecord({ Action: 'red_card', Seq: 4 }))).toBe('red_card');
    expect(ev(scoreRecord({ Action: 'var_check', Seq: 5 }))).toBe('var');
    expect(ev(scoreRecord({ Action: 'halftime_finalised', Seq: 6, StatusId: 3 }))).toBe('halftime');
    expect(ev(scoreRecord({ Action: 'kickoff', Seq: 7 }))).toBe('second_half');
    expect(ev(scoreRecord({ Action: 'resume', Seq: 8 }))).toBe('second_half');
    expect(ev(scoreRecord({ Action: 'game_finalised', Seq: 9, StatusId: 100 }))).toBe('fulltime');
    expect(ev(scoreRecord({ Action: 'throw_in', Seq: 10 }))).toBe('other');
    expect(ev(scoreRecord({ Action: 'comment', Seq: 11 }))).toBe('other');
  });

  it('reads the score from the Score board, omitted Goals key = 0-goal side', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    // Verified shape from 18241006 Seq 539: scoring side has Goals, the other
    // side's Total exists but omits the Goals key entirely.
    const tick = n.normalizeScore(
      scoreRecord({
        Action: 'goal',
        Score: {
          Participant1: { Total: { Goals: 1, YellowCards: 1 } },
          Participant2: { Total: { YellowCards: 2, Corners: 2 } },
        },
        Stats: { '1': 0, '2': 0 }, // Stats lag the board
      }),
    );
    expect(tick?.score).toEqual({ home: 1, away: 0 });
  });

  it('falls back to Stats keys 1/2 when there is no Score board', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    const tick = n.normalizeScore(scoreRecord({ Action: 'kickoff', Stats: { '1': 1, '2': 2 } }));
    expect(tick?.score).toEqual({ home: 1, away: 2 });
  });

  it('swaps the score when Participant1IsHome=false', () => {
    const n = new Normalizer();
    n.registerFixture(flipMeta);
    const tick = n.normalizeScore(
      scoreRecord({
        FixtureId: 999001,
        Action: 'goal',
        Score: { Participant1: { Total: { Goals: 2 } }, Participant2: { Total: { Goals: 1 } } },
      }),
    );
    // Participant1 is the away side here.
    expect(tick?.score).toEqual({ home: 1, away: 2 });
  });

  it('never rolls the score back on lagging Stats-only records', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    n.normalizeScore(
      scoreRecord({
        Action: 'goal',
        Seq: 828,
        Score: { Participant1: { Total: { Goals: 1 } }, Participant2: { Total: { Goals: 1 } } },
      }),
    );
    // Verified on 18241006 Seq 829: a 'possible' record right after the goal
    // still carries the PRE-goal Stats counters.
    const lagging = n.normalizeScore(
      scoreRecord({ Action: 'possible', Seq: 829, Stats: { '1': 1, '2': 0 } }),
    );
    expect(lagging?.score).toEqual({ home: 1, away: 1 });
  });

  it('allows an authoritative Score-board decrease (VAR overturn)', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    n.normalizeScore(
      scoreRecord({ Action: 'goal', Seq: 1, Score: { Participant1: { Total: { Goals: 1 } }, Participant2: { Total: { Goals: 1 } } } }),
    );
    const overturn = n.normalizeScore(
      scoreRecord({
        Action: 'var_decision',
        Seq: 2,
        Score: { Participant1: { Total: { Goals: 0 } }, Participant2: { Total: { Goals: 1 } } },
      }),
    );
    expect(overturn?.event).toBe('var');
    expect(overturn?.score).toEqual({ home: 0, away: 1 });
  });

  it('carries the last known score on records with no score info', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    n.normalizeScore(scoreRecord({ Action: 'goal', Seq: 1, Stats: { '1': 1, '2': 0 } }));
    const comment = n.normalizeScore(scoreRecord({ Action: 'comment', Seq: 2 }));
    expect(comment?.score).toEqual({ home: 1, away: 0 });
  });

  it('derives minute from Clock.Seconds, floor, only when present', () => {
    const n = new Normalizer();
    n.registerFixture(franceEngland);
    const withClock = n.normalizeScore(
      scoreRecord({ Clock: { Running: true, Seconds: 3264 } }),
    );
    expect(withClock?.minute).toBe(54);
    const without = n.normalizeScore(scoreRecord({ Seq: 11 }));
    expect(without).not.toHaveProperty('minute');
  });

  it('rejects records for unregistered fixtures', () => {
    const n = new Normalizer();
    expect(n.normalizeScore(scoreRecord())).toBeNull();
  });
});
