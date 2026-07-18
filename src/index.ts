import { Bus } from './bus.js';
import { loadConfig } from './config.js';
import { createEngine } from './engine/index.js';
import { log } from './log.js';
import { makeTxlineDiscovery } from './mode/discovery.js';
import { makeClock, startOrchestrator } from './mode/orchestrator.js';
import { Recorder } from './replay/recorder.js';
import { ReplaySource } from './replay/replaySource.js';
import { setOnchainProvider, startServer, type SourceControl } from './server/app.js';
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
/** Effective source right now; auto mode's orchestrator flips it. */
let activeSource: 'live' | 'replay' = config.mode === 'live' ? 'live' : 'replay';

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
    mode: activeSource, // always the EFFECTIVE source (contract)
    feed,
    lastTickTs,
    fixtures: [...fixtures.values()],
  });
}

function trackFixture(f: FixtureInfo): void {
  fixtures.set(f.id, f);
  state.registerFixture(f);
}

/**
 * Owns the current ReplaySource. Swappable at runtime (POST /api/replay/select)
 * and restartable across auto-mode live↔replay transitions.
 */
class ReplayRunner {
  file = config.replay.file;
  private source: ReplaySource | null = null;
  private lastFixture: FixtureInfo | null = null;

  /** Fixture of the current (or most recent) replay recording. */
  get fixture(): FixtureInfo | null {
    return this.source?.fixture ?? this.lastFixture;
  }

  start(): void {
    this.runSource(
      new ReplaySource(this.file, config.replay.speed, config.replay.loop, config.replay.start),
    );
  }

  stop(): void {
    this.source?.stop();
    this.source = null;
  }

  /**
   * Swap to a new recording: parse it FIRST (a bad file must leave the current
   * replay running), then stop, reset engine + old fixture state, and start.
   */
  select(file: string): FixtureInfo | null {
    const next = new ReplaySource(file, config.replay.speed, config.replay.loop, config.replay.start);
    const old = this.fixture;
    this.stop();
    engine.reset();
    if (old) {
      state.resetFixture(old.id);
      fixtures.delete(old.id);
    }
    this.file = file;
    this.runSource(next);
    return next.fixture;
  }

  private runSource(source: ReplaySource): void {
    this.source = source;
    if (source.fixture) {
      this.lastFixture = source.fixture;
      trackFixture(source.fixture);
    }
    publishStatus('ok');
    source.start({
      onTick: processTick,
      onLoopRestart: () => {
        engine.reset();
        if (source.fixture) {
          state.resetFixture(source.fixture.id);
          trackFixture(source.fixture);
        }
        publishStatus('ok');
        log.info('replay: loop restart — book reset');
      },
      onEnd: () => {
        publishStatus('ok');
        log.info('replay: recording complete');
      },
    });
  }
}

function liveFeedWatchdog(): void {
  setInterval(() => {
    if (activeSource === 'live') {
      const stale =
        lastTickWallMs === null || Date.now() - lastTickWallMs > config.engine.staleFeedSec * 1000;
      publishStatus(stale ? 'stale' : 'ok');
    } else {
      // Periodic status so dashboard clients (and their reconnect watchdogs)
      // always see a fresh feed state during replay.
      publishStatus('ok');
    }
  }, 5000).unref?.();
}

async function startAutoMode(replayRunner: ReplayRunner): Promise<void> {
  const { startLiveIngest } = await import('./ingest/live.js');
  const recorder = new Recorder('data', fixtures);
  const now = makeClock(process.env.KEEPER_FAKE_NOW);
  let liveHandle: { stop(): void } | null = null;

  await startOrchestrator({
    now,
    ...(process.env.ORCH_CHECK_MS ? { checkIntervalMs: Number(process.env.ORCH_CHECK_MS) } : {}),
    discover: makeTxlineDiscovery(config, now),
    startLive: async () => {
      activeSource = 'live';
      lastTickWallMs = null; // staleness clock restarts with the live feed
      publishStatus('ok');
      liveHandle = await startLiveIngest({
        config,
        // Record ONLY live ticks (replay ticks also cross the bus — never
        // attach the recorder to the bus in auto mode).
        onTick: (tick) => {
          recorder.record(tick);
          processTick(tick);
        },
        onFixtures: (list) => {
          for (const f of list) trackFixture(f);
        },
      });
    },
    stopLive: () => {
      liveHandle?.stop();
      liveHandle = null;
    },
    startReplay: () => {
      activeSource = 'replay';
      // Re-entering replay: engine + state resets apply to the replay fixture
      // only — live fixtures keep their dashboard history in the StateStore,
      // and bus/anchorer continue across the transition untouched.
      engine.reset();
      const prev = replayRunner.fixture;
      if (prev) {
        state.resetFixture(prev.id);
        fixtures.delete(prev.id);
      }
      replayRunner.start();
    },
    stopReplay: () => replayRunner.stop(),
  });

  liveFeedWatchdog();
}

async function main(): Promise<void> {
  const replayRunner = new ReplayRunner();
  const sources: SourceControl = {
    getActiveSource: () => activeSource,
    getReplayFile: () => replayRunner.file,
    selectReplay: (file) => replayRunner.select(file),
  };
  await startServer({ config, bus, state, engine, sources, dataDir: 'data' });

  // Solana anchoring attaches here when enabled (issue #10). It subscribes to
  // the bus, so it persists across auto-mode source transitions.
  if (config.solana.anchorEnabled && config.solana.secretKey) {
    const { startAnchorer } = await import('./chain/anchorer.js');
    startAnchorer({ bus, config });
  }

  // On-chain book surface: /api/state.onchain + the SettlementEvent →
  // settle_book bridge. Both no-op gracefully when the program isn't
  // configured, so wiring is unconditional.
  if (config.solana.programId) {
    const { makeOnchainProvider } = await import('./chain/book.js');
    setOnchainProvider(makeOnchainProvider(config));
  }
  const { makeAutoSettler } = await import('./chain/settle.js');
  const autoSettler = makeAutoSettler(config);
  bus.on('engine', (ev) => {
    if (ev.kind === 'settlement') autoSettler.onSettlement(ev);
  });

  if (config.mode === 'replay') {
    replayRunner.start();
    setInterval(() => publishStatus('ok'), 5000).unref?.();
  } else if (config.mode === 'live') {
    const { startLiveIngest } = await import('./ingest/live.js');
    const recorder = new Recorder('data', fixtures);
    recorder.attach(bus);
    await startLiveIngest({
      config,
      onTick: processTick,
      onFixtures: (list: FixtureInfo[]) => {
        for (const f of list) trackFixture(f);
      },
    });
    liveFeedWatchdog();
  } else {
    // KEEPER_MODE=auto: the orchestrator discovers fixtures itself, goes live
    // for any fixture inside its live window, and replays otherwise.
    await startAutoMode(replayRunner);
  }
}

// A detached callback (observed: @solana/web3.js confirm machinery during an
// RPC 429 storm) must never kill a live trading agent. Anchoring retries by
// design; everything else degrades gracefully. Log and carry on.
process.on('unhandledRejection', (reason) => {
  log.error({ err: String(reason) }, 'unhandledRejection (survived)');
});
process.on('uncaughtException', (err) => {
  log.error({ err: String(err) }, 'uncaughtException (survived)');
});

main().catch((err) => {
  log.error(err, 'fatal');
  process.exit(1);
});
