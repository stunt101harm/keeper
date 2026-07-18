/**
 * live.ts — TxLINE live ingestion: fixture discovery, snapshot seeding, and
 * the two resilient SSE streams (odds + scores), all normalized to Ticks.
 *
 * Flow:
 *  1. Discover fixtures with StartTime in [now − pastH, now + aheadH]
 *     (config.txline.fixtureWindow*), across ALL competitions — refreshed
 *     every 10 minutes. Newly tracked fixtures are seeded from
 *     /odds/snapshot + /scores/snapshot (emitted as ticks, oldest first).
 *  2. /odds/stream and /scores/stream run independently forever — one dying
 *     (or the whole devnet 503ing for ten minutes, as it did on 2026-07-17)
 *     never affects the other, and zero tracked fixtures just means an idle
 *     but connected ingester.
 *
 * Both streams deliver records for ALL fixtures; everything outside the
 * tracked set is dropped before normalization. The Normalizer handles
 * part1/part2 → home/away, suspension carry-forward, and Ts-dedupe (which
 * also absorbs the snapshot/stream overlap during seeding).
 *
 * startLiveIngest resolves once discovery + seeding + stream startup are
 * launched; the streams and the refresh timer keep running in the background.
 */

import type { Config } from '../config.js';
import { log } from '../log.js';
import type { FixtureInfo, Tick } from '../types.js';
import { TxlineAuth } from './auth.js';
import { TxlineClient, type OddsRecord, type ScoreRecord } from './client.js';
import { Normalizer } from './normalize.js';
import { streamRecords, type StreamStatus } from './streams.js';

export interface LiveIngestDeps {
  config: Config;
  onTick(tick: Tick): void;
  onFixtures(fixtures: FixtureInfo[]): void;
}

const FIXTURE_REFRESH_MS = 10 * 60_000;
const MS_PER_DAY = 86_400_000;

export async function startLiveIngest(deps: LiveIngestDeps): Promise<void> {
  const { config } = deps;
  const auth = new TxlineAuth(config.txline); // throws early if no API token
  const client = new TxlineClient(auth);
  const normalizer = new Normalizer();
  const tracked = new Map<number, FixtureInfo>();

  const emit = (tick: Tick | null): void => {
    if (!tick) return;
    try {
      deps.onTick(tick);
    } catch (err) {
      log.error({ err: String(err) }, 'ingest: onTick threw');
    }
  };

  /** Seed one fixture's current state from snapshots, oldest tick first. */
  const seedFixture = async (fixtureId: number): Promise<void> => {
    const [oddsRecs, scoreRecs] = await Promise.all([
      client.oddsSnapshot(fixtureId).catch((err) => {
        log.warn({ fixtureId, err: String(err) }, 'ingest: odds snapshot seed failed');
        return [] as OddsRecord[];
      }),
      client.scoresSnapshot(fixtureId).catch((err) => {
        log.warn({ fixtureId, err: String(err) }, 'ingest: scores snapshot seed failed');
        return [] as ScoreRecord[];
      }),
    ]);
    // Normalize in source order (odds by Ts; scores by Seq — the causal order),
    // then emit the merged result oldest-first so the engine warms up sanely.
    const ticks: Tick[] = [];
    for (const rec of [...oddsRecs].sort((a, b) => a.Ts - b.Ts)) {
      const t = normalizer.normalizeOdds(rec);
      if (t) ticks.push(t);
    }
    for (const rec of [...scoreRecs].sort((a, b) => a.Seq - b.Seq)) {
      const t = normalizer.normalizeScore(rec);
      if (t) ticks.push(t);
    }
    ticks.sort((a, b) => a.ts - b.ts);
    for (const t of ticks) emit(t);
    log.info({ fixtureId, seedTicks: ticks.length }, 'ingest: fixture seeded');
  };

  /** Discover fixtures in the tracking window; seed any newly tracked ones. */
  const refreshFixtures = async (): Promise<void> => {
    const now = Date.now();
    const windowStart = now - config.txline.fixtureWindowPastH * 3_600_000;
    const windowEnd = now + config.txline.fixtureWindowAheadH * 3_600_000;
    // startEpochDay anchors the API's 30-day window at the past edge so a
    // fixture that kicked off late yesterday (UTC) is still returned.
    const metas = await client.fixturesSnapshot({
      startEpochDay: Math.floor(windowStart / MS_PER_DAY),
    });
    const fresh: number[] = [];
    for (const meta of metas) {
      if (meta.StartTime < windowStart || meta.StartTime > windowEnd) continue;
      const info = normalizer.registerFixture(meta);
      if (!tracked.has(meta.FixtureId)) fresh.push(meta.FixtureId);
      tracked.set(meta.FixtureId, info);
    }
    deps.onFixtures([...tracked.values()]);
    log.info(
      { tracked: tracked.size, fresh: fresh.length },
      'ingest: fixture window refreshed',
    );
    for (const id of fresh) await seedFixture(id);
  };

  const streamLogger =
    (name: string) =>
    (status: StreamStatus): void => {
      const level = status.type === 'error' || status.type === 'closed' ? 'warn' : 'debug';
      log[level]({ stream: name, ...status }, `ingest: ${name} stream ${status.type}`);
    };

  // Initial discovery + seeding. Must not crash the keeper if the API is down
  // at boot — streams below will connect (with backoff) once it returns, and
  // the refresh timer retries discovery.
  try {
    await refreshFixtures();
  } catch (err) {
    log.error({ err: String(err) }, 'ingest: initial fixture discovery failed — will retry');
    deps.onFixtures([]);
  }

  const refreshTimer = setInterval(() => {
    refreshFixtures().catch((err) => {
      log.warn({ err: String(err) }, 'ingest: fixture refresh failed — keeping current set');
    });
  }, FIXTURE_REFRESH_MS);
  refreshTimer.unref?.();

  // The two streams are fully independent loops: separate sockets, separate
  // backoff ladders. Records for untracked fixtures are dropped up front.
  streamRecords<OddsRecord>(
    auth,
    '/odds/stream',
    {
      onRecord: (rec) => {
        if (!tracked.has(rec.FixtureId)) return;
        emit(normalizer.normalizeOdds(rec));
      },
      onStatus: streamLogger('odds'),
    },
  );
  streamRecords<ScoreRecord>(
    auth,
    '/scores/stream',
    {
      onRecord: (rec) => {
        if (!tracked.has(rec.FixtureId)) return;
        emit(normalizer.normalizeScore(rec));
      },
      onStatus: streamLogger('scores'),
    },
  );

  log.info(
    { network: config.txline.network, tracked: tracked.size },
    'ingest: live ingestion started (odds + scores streams)',
  );
}
