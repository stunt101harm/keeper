import { Bus } from './bus.js';
import { loadConfig } from './config.js';
import { createEngine } from './engine/index.js';
import { log } from './log.js';
import { Recorder } from './replay/recorder.js';
import { ReplaySource } from './replay/replaySource.js';
import { startServer } from './server/app.js';
import { StateStore } from './server/state.js';
import type { FixtureInfo, StatusEvent, Tick } from './types.js';

const config = loadConfig();
const bus = new Bus();
const state = new StateStore();
state.attach(bus);
const engine = createEngine(config.engine);

const fixtures = new Map<string, FixtureInfo>();
let lastTickWallMs: number | null = null;
let lastTickTs: number | null = null;

function processTick(tick: Tick): void {
  lastTickWallMs = Date.now();
  lastTickTs = tick.ts;
  bus.publishTick(tick);
  for (const event of engine.onTick(tick)) {
    bus.publishEngine(event);
  }
}

function publishStatus(feed: StatusEvent['feed']): void {
  bus.publishStatus({
    kind: 'status',
    ts: Date.now(),
    mode: config.mode,
    feed,
    lastTickTs,
    fixtures: [...fixtures.values()],
  });
}

async function main(): Promise<void> {
  await startServer({ config, bus, state, engine });

  // Solana anchoring attaches here when enabled (issue #10).
  if (config.solana.anchorEnabled && config.solana.secretKey) {
    const { startAnchorer } = await import('./chain/anchorer.js').catch(() => ({
      startAnchorer: null,
    }));
    if (startAnchorer) startAnchorer({ bus, config });
    else log.warn('chain: anchorer module not present yet — skipping');
  }

  if (config.mode === 'replay') {
    const source = new ReplaySource(
      config.replay.file,
      config.replay.speed,
      config.replay.loop,
      config.replay.start,
    );
    if (source.fixture) {
      fixtures.set(source.fixture.id, source.fixture);
      state.registerFixture(source.fixture);
    }
    publishStatus('ok');
    // Periodic status so dashboard clients (and their reconnect watchdogs)
    // always see a fresh feed state during replay.
    setInterval(() => publishStatus('ok'), 5000).unref?.();
    source.start({
      onTick: processTick,
      onLoopRestart: () => {
        engine.reset();
        if (source.fixture) state.resetFixture(source.fixture.id);
        if (source.fixture) state.registerFixture(source.fixture);
        publishStatus('ok');
        log.info('replay: loop restart — book reset');
      },
      onEnd: () => {
        publishStatus('ok');
        log.info('replay: recording complete');
      },
    });
  } else {
    // Live mode: TxLINE ingestion (issues #3/#4)
    const { startLiveIngest } = await import('./ingest/live.js');
    const recorder = new Recorder('data', fixtures);
    recorder.attach(bus);
    await startLiveIngest({
      config,
      onTick: processTick,
      onFixtures: (list: FixtureInfo[]) => {
        for (const f of list) {
          fixtures.set(f.id, f);
          state.registerFixture(f);
        }
      },
    });
    // Feed watchdog: status + staleness signal for dashboard/health
    setInterval(() => {
      const stale =
        lastTickWallMs === null || Date.now() - lastTickWallMs > config.engine.staleFeedSec * 1000;
      publishStatus(stale ? 'stale' : 'ok');
    }, 5000);
  }
}

main().catch((err) => {
  log.error(err, 'fatal');
  process.exit(1);
});
