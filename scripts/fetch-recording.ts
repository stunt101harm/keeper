/**
 * fetch-recording.ts — build a replayable recording of a completed (or
 * in-progress) match from the TxLINE historical endpoints.
 *
 *   npx tsx scripts/fetch-recording.ts <fixtureId> [outfile]
 *
 * Sources:
 *  - /scores/snapshot/{id}       → StartTime (locates the matchday)
 *  - /fixtures/snapshot?startEpochDay=<matchday> → FixtureMeta (names, home/away)
 *  - /scores/historical/{id}     → full match log (SSE-formatted text)
 *  - /odds/updates/{day}/{hour}/{interval} sweep from StartTime − 60min to
 *    game_finalised + 15min → every consensus odds tick
 *
 * Output: JSONL in the src/replay/recording.ts format — first line
 * {kind:'meta',fixture}, then normalized Ticks sorted by ts (stable).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { TxlineAuth } from '../src/ingest/auth.js';
import { summariseSnapshot, TxlineClient, type OddsRecord } from '../src/ingest/client.js';
import { CONSENSUS_BOOKMAKER, CONSENSUS_MARKET, Normalizer } from '../src/ingest/normalize.js';
import type { RecordingLine } from '../src/replay/recording.js';
import type { Tick } from '../src/types.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

async function main(): Promise<void> {
  const [fixtureIdArg, outArg] = process.argv.slice(2);
  if (!fixtureIdArg || !/^\d+$/.test(fixtureIdArg)) {
    console.error('usage: npx tsx scripts/fetch-recording.ts <fixtureId> [outfile]');
    process.exit(1);
  }
  const fixtureId = Number(fixtureIdArg);
  const outfile = outArg ?? `data/${fixtureId}.jsonl`;

  const config = loadConfig();
  const client = new TxlineClient(new TxlineAuth(config.txline));

  // 1. Scores snapshot → StartTime → matchday → fixture meta.
  console.log(`fetching scores snapshot for ${fixtureId}…`);
  const snapshot = await client.scoresSnapshot(fixtureId);
  const startTime = snapshot.find((r) => typeof r.StartTime === 'number')?.StartTime;
  if (startTime === undefined) {
    throw new Error(`scores snapshot for ${fixtureId} has no StartTime — cannot locate matchday`);
  }
  const matchday = Math.floor(startTime / MS_PER_DAY);

  console.log(`fetching fixture meta (epochDay ${matchday})…`);
  const metas = await client.fixturesSnapshot({ startEpochDay: matchday });
  const meta = metas.find((m) => m.FixtureId === fixtureId);
  if (!meta) {
    throw new Error(`fixture ${fixtureId} not found in /fixtures/snapshot?startEpochDay=${matchday}`);
  }

  // 2. Full score log.
  console.log('fetching historical scores…');
  const scoreRecs = (await client.scoresHistorical(fixtureId)).sort((a, b) => a.Seq - b.Seq);
  const summary = summariseSnapshot(scoreRecs);
  const finalRec = scoreRecs.find((r) => r.Action === 'game_finalised' || r.StatusId === 100);
  const endTs = (finalRec?.Ts ?? Math.max(...scoreRecs.map((r) => r.Ts))) + 15 * 60_000;
  const sweepStart = startTime - 60 * 60_000;
  console.log(
    `  ${scoreRecs.length} score records, maxSeq ${summary.maxSeq}, finalised=${summary.finalised}`,
  );

  // 3. Odds bucket sweep: every 5-minute interval of every hour in range.
  const oddsRecs: OddsRecord[] = [];
  const firstHour = Math.floor(sweepStart / MS_PER_HOUR);
  const lastHour = Math.floor(endTs / MS_PER_HOUR);
  console.log(`sweeping odds buckets over ${lastHour - firstHour + 1} hours…`);
  for (let hour = firstHour; hour <= lastHour; hour++) {
    const hourTs = hour * MS_PER_HOUR;
    const epochDay = Math.floor(hourTs / MS_PER_DAY);
    const hourOfDay = Math.floor((hourTs % MS_PER_DAY) / MS_PER_HOUR);
    for (let interval = 0; interval < 12; interval++) {
      const bucket = await client.oddsUpdates(epochDay, hourOfDay, interval);
      for (const rec of bucket) {
        if (
          rec.FixtureId === fixtureId &&
          rec.Bookmaker === CONSENSUS_BOOKMAKER &&
          rec.SuperOddsType === CONSENSUS_MARKET
        ) {
          oddsRecs.push(rec);
        }
      }
    }
    process.stdout.write(`  hour ${hourOfDay}:00 day ${epochDay} → ${oddsRecs.length} odds records so far\n`);
  }

  // 4. Normalize everything, merge, sort by ts (Array#sort is stable).
  const normalizer = new Normalizer();
  const fixture = normalizer.registerFixture(meta);
  const ticks: Tick[] = [];
  let suspendedCount = 0;
  for (const rec of oddsRecs.sort((a, b) => a.Ts - b.Ts)) {
    const t = normalizer.normalizeOdds(rec);
    if (!t) continue;
    if (t.suspended) suspendedCount++;
    ticks.push(t);
  }
  const oddsTickCount = ticks.length;
  for (const rec of scoreRecs) {
    const t = normalizer.normalizeScore(rec);
    if (t) ticks.push(t);
  }
  const scoreTickCount = ticks.length - oddsTickCount;
  ticks.sort((a, b) => a.ts - b.ts);

  // 5. Write JSONL.
  const lines: RecordingLine[] = [{ kind: 'meta', fixture }, ...ticks];
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  const spanMin = first && last ? Math.round((last.ts - first.ts) / 60_000) : 0;
  console.log(`\nwrote ${outfile}`);
  console.log(`  fixture: ${fixture.home} v ${fixture.away} (${fixture.competition})`);
  console.log(`  odds ticks:      ${oddsTickCount} (${suspendedCount} suspended)`);
  console.log(`  score ticks:     ${scoreTickCount}`);
  console.log(`  total ticks:     ${ticks.length}`);
  console.log(`  time span:       ${spanMin} min (${new Date(first?.ts ?? 0).toISOString()} → ${new Date(last?.ts ?? 0).toISOString()})`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
