/**
 * discovery.ts — standalone TxLINE fixture discovery for the orchestrator.
 *
 * The orchestrator needs to see upcoming fixtures BEFORE live ingestion is
 * running (that is what tells it to go live in the first place), so it cannot
 * lean on startLiveIngest's internal refresh. This mirrors live.ts's
 * windowing: fixtures with kickoff in [now − pastH, now + aheadH]
 * (config.txline.fixtureWindow*), all competitions.
 *
 * No TXLINE_API_TOKEN → a stub that always returns [] (auto mode degrades to
 * pure replay instead of crashing). API errors propagate to the orchestrator,
 * which keeps deciding on its last known set.
 */

import type { Config } from '../config.js';
import { TxlineAuth } from '../ingest/auth.js';
import { TxlineClient } from '../ingest/client.js';
import { fixtureToInfo } from '../ingest/normalize.js';
import { log } from '../log.js';
import type { FixtureInfo } from '../types.js';

const MS_PER_DAY = 86_400_000;

export function makeTxlineDiscovery(
  config: Config,
  now: () => number = () => Date.now(),
): () => Promise<FixtureInfo[]> {
  let client: TxlineClient;
  try {
    client = new TxlineClient(new TxlineAuth(config.txline)); // throws without token
  } catch (err) {
    log.warn(
      { err: String(err) },
      'orchestrator: no TxLINE credentials — auto mode will stay in replay',
    );
    return async () => [];
  }
  return async () => {
    const nowMs = now();
    const windowStart = nowMs - config.txline.fixtureWindowPastH * 3_600_000;
    const windowEnd = nowMs + config.txline.fixtureWindowAheadH * 3_600_000;
    const metas = await client.fixturesSnapshot({
      startEpochDay: Math.floor(windowStart / MS_PER_DAY),
    });
    return metas
      .filter((m) => m.StartTime >= windowStart && m.StartTime <= windowEnd)
      .map(fixtureToInfo);
  };
}
