import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Bus } from '../bus.js';
import { loadConfig } from '../config.js';
import { createEngine } from '../engine/index.js';
import type { FixtureInfo } from '../types.js';
import { buildServer, setOnchainProvider, type SourceControl } from './app.js';
import { isRecordingFilename, listRecordings } from './recordings.js';
import { StateStore } from './state.js';

const FIXTURE: FixtureInfo = {
  id: '18257865',
  home: 'France',
  away: 'England',
  kickoffTs: 1_800_000_000_000,
  competition: 'World Cup',
};

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'keeper-recordings-'));
  const lines = [
    JSON.stringify({ kind: 'meta', fixture: FIXTURE }),
    JSON.stringify({ kind: 'odds', fixtureId: FIXTURE.id, ts: 1, odds: { home: 2, draw: 3, away: 4 } }),
    JSON.stringify({ kind: 'score', fixtureId: FIXTURE.id, ts: 2, score: { home: 0, away: 0 }, event: 'kickoff' }),
  ];
  writeFileSync(path.join(dir, '18257865-france-england.jsonl'), lines.join('\n') + '\n');
  // Blotters that must NOT be listed or downloadable:
  writeFileSync(path.join(dir, 'events.jsonl'), '{"kind":"quotes"}\n');
  writeFileSync(path.join(dir, 'events-2026-07-18T02-40-19.jsonl'), '{"kind":"quotes"}\n');
  writeFileSync(path.join(dir, 'anchors.jsonl'), '{"kind":"anchor"}\n');
  writeFileSync(path.join(dir, 'notes.txt'), 'not a recording\n');
  return dir;
}

describe('recordings helpers', () => {
  it('validates filenames strictly', () => {
    expect(isRecordingFilename('match.jsonl')).toBe(true);
    expect(isRecordingFilename('../secrets.jsonl')).toBe(false);
    expect(isRecordingFilename('sub/dir.jsonl')).toBe(false);
    expect(isRecordingFilename('events.jsonl')).toBe(false);
    expect(isRecordingFilename('events-2026.jsonl')).toBe(false);
    expect(isRecordingFilename('anchors.jsonl')).toBe(false);
    expect(isRecordingFilename('.hidden.jsonl')).toBe(false);
    expect(isRecordingFilename('match.json')).toBe(false);
  });

  it('lists recordings with parsed meta, tick count and bytes; excludes blotters', () => {
    const dir = makeDataDir();
    const recordings = listRecordings(dir);
    expect(recordings.map((r) => r.file)).toEqual(['18257865-france-england.jsonl']);
    const rec = recordings[0]!;
    expect(rec.fixture).toEqual(FIXTURE);
    expect(rec.ticks).toBe(2);
    expect(rec.bytes).toBeGreaterThan(0);
  });
});

describe('server API (CONTRACTS-WAVE2)', () => {
  const dataDir = makeDataDir();
  const config = loadConfig({ KEEPER_MODE: 'auto', ANCHOR_ENABLED: 'false' });
  const bus = new Bus();
  const state = new StateStore();
  state.attach(bus);
  const engine = createEngine(config.engine);

  let activeSource: 'live' | 'replay' = 'replay';
  const selected: string[] = [];
  let selectThrows = false;
  const sources: SourceControl = {
    getActiveSource: () => activeSource,
    getReplayFile: () => 'data/sample-match.jsonl',
    selectReplay: (file) => {
      if (selectThrows) throw new Error('no ticks');
      selected.push(file);
      return FIXTURE;
    },
  };

  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    app = await buildServer({ config, bus, state, engine, sources, dataDir });
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    activeSource = 'replay';
    selectThrows = false;
    selected.length = 0;
    setOnchainProvider(null);
  });

  it('GET /api/recordings lists only real recordings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recordings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { recordings: Array<{ file: string; ticks: number }> };
    expect(body.recordings.map((r) => r.file)).toEqual(['18257865-france-england.jsonl']);
    expect(body.recordings[0]!.ticks).toBe(2);
  });

  it('GET /api/recordings/:file downloads raw JSONL', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recordings/18257865-france-england.jsonl' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toContain('18257865-france-england.jsonl');
    expect(res.body.split('\n')[0]).toContain('"kind":"meta"');
  });

  it('GET /api/recordings/:file rejects blotters and traversal', async () => {
    for (const bad of ['events.jsonl', 'anchors.jsonl', '..%2F..%2Fpackage.json', 'nope.jsonl']) {
      const res = await app.inject({ method: 'GET', url: `/api/recordings/${bad}` });
      expect(res.statusCode, bad).toBe(404);
    }
  });

  it('POST /api/replay/select swaps the recording when replay is active', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/replay/select',
      payload: { file: '18257865-france-england.jsonl' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, file: '18257865-france-england.jsonl' });
    expect(selected).toEqual([path.join(dataDir, '18257865-france-england.jsonl')]);
  });

  it('POST /api/replay/select → 409 when the effective source is live', async () => {
    activeSource = 'live';
    const res = await app.inject({
      method: 'POST',
      url: '/api/replay/select',
      payload: { file: '18257865-france-england.jsonl' },
    });
    expect(res.statusCode).toBe(409);
    expect(selected).toEqual([]);
  });

  it('POST /api/replay/select → 404 unknown file, 400 bad body, 400 unreadable recording', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/replay/select', payload: { file: 'missing.jsonl' } });
    expect(missing.statusCode).toBe(404);
    const badBody = await app.inject({ method: 'POST', url: '/api/replay/select', payload: { nope: 1 } });
    expect(badBody.statusCode).toBe(400);
    selectThrows = true;
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/replay/select',
      payload: { file: '18257865-france-england.jsonl' },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it('GET /api/state exposes activeSource, replay info, and {} onchain by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    const body = res.json() as { activeSource: string; onchain: unknown; replay: { file: string } };
    expect(body.activeSource).toBe('replay');
    expect(body.replay.file).toBe('data/sample-match.jsonl');
    expect(body.onchain).toEqual({});
  });

  it('GET /api/state omits replay info and flips activeSource when live', async () => {
    activeSource = 'live';
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    const body = res.json() as { activeSource: string; replay?: unknown };
    expect(body.activeSource).toBe('live');
    expect(body.replay).toBeUndefined();
  });

  it('GET /api/state renders the registered onchain provider (and {} when it throws)', async () => {
    setOnchainProvider(async () => ({ programId: 'Keeper111', network: 'devnet', books: {} }));
    let body = (await app.inject({ method: 'GET', url: '/api/state' })).json() as { onchain: { programId?: string } };
    expect(body.onchain.programId).toBe('Keeper111');

    setOnchainProvider(() => {
      throw new Error('devnet down');
    });
    body = (await app.inject({ method: 'GET', url: '/api/state' })).json() as { onchain: object };
    expect(body.onchain).toEqual({});
  });
});
