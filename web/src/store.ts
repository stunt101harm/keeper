/**
 * Client-side projection of the Keeper bus.
 *
 * Hydrates once from GET /api/state, then applies the SSE stream
 * (GET /api/events). On any disconnect it reconnects with backoff and
 * re-hydrates, so the projection is always snapshot + suffix — never a gap.
 *
 * Buffering: quote points capped at ~5000 per fixture; when the cap is hit the
 * older half is thinned 2:1 so the full match stays on screen cheaply.
 */
import type {
  AnchorBatch,
  BookSnapshot,
  EngineEvent,
  FixtureInfo,
  Metrics,
  OnchainState,
  Outcome,
  ParamsView,
  QuoteSet,
  RecordingInfo,
  RiskTransition,
  ScoreTick,
  ServerSnapshot,
  SettlementEvent,
  StatusEvent,
  Tick,
  Trade,
} from './domain';
import { applyMocks, MOCK_FLAGS } from './mock';

const CHART_CAP = 5000;
const BOOK_HISTORY_CAP = 3000;
const TRADES_CAP = 200;
const ANCHOR_CAP = 200;
/** A backwards ts jump larger than this = replay loop restarted → reset buffers. */
const LOOP_RESET_MS = 120_000;

/** Fair-prob point synthesized from raw odds ticks (fallback while engine is warming up). */
export interface FairPoint {
  ts: number;
  fair: Record<Outcome, number>;
}

export interface BookPoint {
  ts: number;
  total: number; // realized + MTM
  spreadCapture: number;
  inventoryDrift: number;
  settlementResidual: number;
}

export interface FixtureBuf {
  id: string;
  fixture: FixtureInfo | null;
  latestQuotes: QuoteSet | null;
  latestScore: ScoreTick | null;
  book: BookSnapshot | null;
  settlement: SettlementEvent | null;
  chart: QuoteSet[];
  fairTicks: FairPoint[];
  bookHistory: BookPoint[];
  trades: Trade[]; // oldest→newest
  riskLog: RiskTransition[]; // oldest→newest
  goals: ScoreTick[];
  lastTs: number;
}

export type ConnState = 'connecting' | 'open' | 'reconnecting';

function emptyBuf(id: string): FixtureBuf {
  return {
    id,
    fixture: null,
    latestQuotes: null,
    latestScore: null,
    book: null,
    settlement: null,
    chart: [],
    fairTicks: [],
    bookHistory: [],
    trades: [],
    riskLog: [],
    goals: [],
    lastTs: 0,
  };
}

/** Thin the older half of a ring buffer 2:1 once it exceeds cap. */
export function thin<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const half = Math.floor(arr.length / 2);
  return arr.filter((_, i) => i >= half || i % 2 === 0);
}

export function devig(odds: Record<Outcome, number>): Record<Outcome, number> | null {
  // MODEL.md guard: all three legs present, finite, > 0 — else treat as suspended
  if (!(isFinite(odds.home) && isFinite(odds.draw) && isFinite(odds.away))) return null;
  const inv = { home: 1 / odds.home, draw: 1 / odds.draw, away: 1 / odds.away };
  const sum = inv.home + inv.draw + inv.away;
  if (!isFinite(sum) || sum <= 0) return null;
  return { home: inv.home / sum, draw: inv.draw / sum, away: inv.away / sum };
}

export class KeeperStore {
  conn: ConnState = 'connecting';
  hydrated = false;
  mode: 'live' | 'replay' = 'replay';
  /** What the orchestrator is actually running right now (wave-2; falls back to mode). */
  activeSource: 'live' | 'replay' = 'replay';
  /** keeper_book on-chain projection, when the server exposes it (wave-2). */
  onchain: OnchainState | null = null;
  /** Available replay recordings (wave-2; empty when the route is absent). */
  recordings: RecordingInfo[] = [];
  /** True while a POST /api/replay/select round-trip is in flight. */
  switchingReplay = false;
  replay: { file: string; speed: number; loop: boolean } | null = null;
  params: ParamsView = {};
  halted = false;
  status: StatusEvent | null = null;
  metrics: Metrics | null = null;
  anchors: AnchorBatch[] = [];
  fixtures = new Map<string, FixtureBuf>();
  selectedFixture: string | null = null;
  /** Wall-clock ms of the last SSE payload of any type (client-side staleness). */
  lastEventAt = 0;

  private version = 0;
  private listeners = new Set<() => void>();
  private raf: number | null = null;
  private es: EventSource | null = null;
  private retryMs = 1000;
  private disposed = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version++;
    if (this.raf != null) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      for (const fn of this.listeners) fn();
    });
  }

  start(): void {
    void this.hydrate();
    this.connect();
    // Watchdog for half-open SSE (a dead upstream behind a proxy never fires
    // onerror): no events for 30s of wall time → force a reconnect+rehydrate.
    this.watchdog = setInterval(() => {
      if (this.conn === 'open' && this.lastEventAt > 0 && Date.now() - this.lastEventAt > 30_000) {
        this.conn = 'reconnecting';
        this.bump();
        this.connect();
      }
    }, 5000);
  }

  dispose(): void {
    this.disposed = true;
    this.es?.close();
    if (this.raf != null) cancelAnimationFrame(this.raf);
    if (this.watchdog != null) clearInterval(this.watchdog);
  }

  // ---------------------------------------------------------------- hydration

  async hydrate(): Promise<void> {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error(`state ${res.status}`);
      const snap = (await res.json()) as ServerSnapshot;
      this.applySnapshot(snap);
    } catch {
      // server not up yet — SSE reconnect loop will retry hydration
    }
    void this.loadRecordings();
  }

  /** Wave-2 route; degrades to an empty list (selector hidden) when absent. */
  private async loadRecordings(): Promise<void> {
    try {
      const res = await fetch('/api/recordings');
      if (!res.ok) return;
      const body = (await res.json()) as { recordings?: RecordingInfo[] };
      if (Array.isArray(body.recordings)) {
        this.recordings = body.recordings;
      }
    } catch {
      // route not shipped yet — leave recordings empty
    }
    if (MOCK_FLAGS.size > 0) applyMocks(this, MOCK_FLAGS);
    this.bump();
  }

  private applySnapshot(snap: ServerSnapshot): void {
    this.mode = snap.mode;
    // activeSource (wave-2) > status.mode (effective source) > config mode.
    const src = snap.activeSource ?? snap.status?.mode ?? snap.mode;
    this.activeSource = src === 'live' ? 'live' : 'replay';
    // Accept onchain only when it matches the wave-2 contract shape; the
    // server may send a partial/empty object while the chain module is wiring.
    const oc = snap.onchain;
    this.onchain =
      oc && typeof oc.programId === 'string' && oc.books && typeof oc.books === 'object'
        ? oc
        : null;
    this.replay = snap.replay ?? null;
    this.params = snap.params ?? {};
    this.halted = snap.halted;
    this.status = snap.status;
    this.metrics = snap.metrics;
    this.anchors = [...(snap.anchors ?? [])];
    const next = new Map<string, FixtureBuf>();
    for (const [id, fs] of Object.entries(snap.fixtures ?? {})) {
      const buf = emptyBuf(id);
      buf.fixture = fs.fixture;
      buf.latestQuotes = fs.latestQuotes;
      buf.latestScore = fs.latestScore;
      buf.book = fs.book;
      buf.settlement = fs.settlement ?? null;
      buf.chart = [...(fs.chart ?? [])];
      buf.trades = [...(fs.trades ?? [])];
      buf.riskLog = [...(fs.riskLog ?? [])];
      if (fs.latestScore?.event === 'goal') buf.goals = [fs.latestScore];
      if (fs.book) buf.bookHistory = [toBookPoint(fs.book)];
      buf.lastTs = Math.max(
        fs.latestQuotes?.ts ?? 0,
        fs.latestScore?.ts ?? 0,
        fs.chart?.at(-1)?.ts ?? 0,
      );
      next.set(id, buf);
    }
    this.fixtures = next;
    if (!this.selectedFixture || !next.has(this.selectedFixture)) {
      this.selectedFixture = next.keys().next().value ?? null;
    }
    this.hydrated = true;
    if (MOCK_FLAGS.size > 0) applyMocks(this, MOCK_FLAGS);
    this.bump();
  }

  // ---------------------------------------------------------------------- SSE

  private connect(): void {
    if (this.disposed) return;
    this.es?.close();
    const es = new EventSource('/api/events');
    this.es = es;

    es.onopen = () => {
      const wasReconnect = this.conn === 'reconnecting';
      this.conn = 'open';
      this.retryMs = 1000;
      if (wasReconnect || !this.hydrated) void this.hydrate();
      this.bump();
    };
    es.onerror = () => {
      es.close();
      if (this.es === es) {
        this.conn = 'reconnecting';
        this.bump();
        setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 8000);
      }
    };

    const on = <T>(type: string, fn: (data: T) => void) => {
      es.addEventListener(type, (ev) => {
        this.lastEventAt = Date.now();
        try {
          fn(JSON.parse((ev as MessageEvent).data) as T);
        } catch {
          // malformed frame — skip
        }
      });
    };
    on<Tick>('tick', (t) => this.onTick(t));
    on<EngineEvent>('engine', (e) => this.onEngine(e));
    on<AnchorBatch>('anchor', (a) => this.onAnchor(a));
    on<StatusEvent>('status', (s) => this.onStatus(s));
  }

  // ------------------------------------------------------------------ events

  private buf(fixtureId: string): FixtureBuf {
    let b = this.fixtures.get(fixtureId);
    if (!b) {
      b = emptyBuf(fixtureId);
      this.fixtures.set(fixtureId, b);
      if (!this.selectedFixture) this.selectedFixture = fixtureId;
    }
    return b;
  }

  /** Replay loop restart: feed time jumped backwards → clear per-match history. */
  private checkLoopReset(b: FixtureBuf, ts: number): void {
    if (b.lastTs > 0 && ts < b.lastTs - LOOP_RESET_MS) {
      const fixture = b.fixture;
      const fresh = emptyBuf(b.id);
      fresh.fixture = fixture;
      fresh.lastTs = ts;
      this.fixtures.set(b.id, fresh);
    }
  }

  private onTick(t: Tick): void {
    this.checkLoopReset(this.buf(t.fixtureId), t.ts);
    const b = this.buf(t.fixtureId);
    b.lastTs = Math.max(b.lastTs, t.ts);
    if (t.kind === 'score') {
      b.latestScore = t;
      if (t.event === 'goal') b.goals = [...b.goals, t];
    } else if (!t.suspended) {
      const fair = devig(t.odds);
      if (fair) {
        b.fairTicks = thin([...b.fairTicks, { ts: t.ts, fair }], CHART_CAP);
      }
    }
    this.bump();
  }

  private onEngine(e: EngineEvent): void {
    this.checkLoopReset(this.buf(e.fixtureId), e.ts);
    const b = this.buf(e.fixtureId);
    b.lastTs = Math.max(b.lastTs, e.ts);
    switch (e.kind) {
      case 'quotes':
        b.latestQuotes = e;
        b.chart = thin([...b.chart, e], CHART_CAP);
        break;
      case 'trade':
        b.trades = [...b.trades, e].slice(-TRADES_CAP);
        break;
      case 'book':
        b.book = e;
        b.bookHistory = thin([...b.bookHistory, toBookPoint(e)], BOOK_HISTORY_CAP);
        break;
      case 'risk':
        b.riskLog = [...b.riskLog, e].slice(-100);
        break;
      case 'settlement':
        b.settlement = e;
        break;
    }
    this.bump();
  }

  private onAnchor(a: AnchorBatch): void {
    const i = this.anchors.findIndex((x) => x.seqStart === a.seqStart);
    const next = [...this.anchors];
    if (i >= 0) next[i] = a;
    else next.push(a);
    this.anchors = next.slice(-ANCHOR_CAP);
    this.bump();
  }

  private onStatus(s: StatusEvent): void {
    this.status = s;
    this.activeSource = s.mode === 'live' ? 'live' : 'replay';
    for (const f of s.fixtures) {
      const b = this.buf(f.id);
      if (!b.fixture) b.fixture = f;
    }
    this.bump();
  }

  // ------------------------------------------------------------------ actions

  select(fixtureId: string): void {
    this.selectedFixture = fixtureId;
    this.bump();
  }

  /**
   * Switch the active replay recording (wave-2). On success we reuse the
   * loop-restart reset semantics for the whole projection: drop every fixture
   * buffer and re-hydrate, so the new match starts from a clean slate.
   */
  async selectRecording(file: string): Promise<void> {
    if (this.switchingReplay) return;
    this.switchingReplay = true;
    this.bump();
    try {
      const res = await fetch('/api/replay/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      if (res.ok) {
        this.fixtures = new Map();
        this.selectedFixture = null;
        if (this.replay) this.replay = { ...this.replay, file };
        await this.hydrate();
      }
    } catch {
      // server unreachable or route absent — keep current state
    } finally {
      this.switchingReplay = false;
      this.bump();
    }
  }

  async setHalted(halt: boolean): Promise<void> {
    try {
      const res = await fetch(halt ? '/api/halt' : '/api/resume', { method: 'POST' });
      if (res.ok) {
        const body = (await res.json()) as { halted: boolean };
        this.halted = body.halted;
        this.bump();
      }
    } catch {
      // leave state as-is; next hydrate reconciles
    }
  }
}

function toBookPoint(b: BookSnapshot): BookPoint {
  return {
    ts: b.ts,
    total: b.realizedPnl + b.mtmPnl,
    spreadCapture: b.pnl.spreadCapture,
    inventoryDrift: b.pnl.inventoryDrift,
    settlementResidual: b.pnl.settlementResidual,
  };
}

export const store = new KeeperStore();
