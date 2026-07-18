import type { Bus } from '../bus.js';
import type {
  AnchorBatch,
  BookSnapshot,
  FixtureInfo,
  QuoteSet,
  ScoreTick,
  StatusEvent,
  Tick,
  Trade,
  RiskTransition,
} from '../types.js';

const CHART_CAP = 5000;
const TRADE_CAP = 300;
const ANCHOR_CAP = 200;

export interface FixtureState {
  fixture: FixtureInfo | null;
  latestQuotes: QuoteSet | null;
  latestScore: ScoreTick | null;
  book: BookSnapshot | null;
  /** Ring buffer of quote sets for chart hydration. */
  chart: QuoteSet[];
  trades: Trade[];
  riskLog: RiskTransition[];
}

/**
 * In-memory projection of the bus, serving dashboard hydration (/api/state).
 * Live updates flow to clients over SSE; this store answers "what happened
 * before I connected".
 */
export class StateStore {
  private fixtures = new Map<string, FixtureState>();
  anchors: AnchorBatch[] = [];
  status: StatusEvent | null = null;
  metrics = { ticksIn: 0, quotesOut: 0, trades: 0, anchorsConfirmed: 0, anchorsFailed: 0 };

  attach(bus: Bus): void {
    bus.on('tick', (tick) => this.onTick(tick));
    bus.on('engine', (event) => {
      const fs = this.fixtureState(event.fixtureId);
      switch (event.kind) {
        case 'quotes':
          this.metrics.quotesOut++;
          fs.latestQuotes = event;
          fs.chart.push(event);
          if (fs.chart.length > CHART_CAP) fs.chart.splice(0, fs.chart.length - CHART_CAP);
          break;
        case 'trade':
          this.metrics.trades++;
          fs.trades.push(event);
          if (fs.trades.length > TRADE_CAP) fs.trades.splice(0, fs.trades.length - TRADE_CAP);
          break;
        case 'book':
          fs.book = event;
          break;
        case 'risk':
          fs.riskLog.push(event);
          if (fs.riskLog.length > 100) fs.riskLog.splice(0, fs.riskLog.length - 100);
          break;
        case 'settlement':
          break;
      }
    });
    bus.on('anchor', (batch) => {
      const existing = this.anchors.findIndex((a) => a.seqStart === batch.seqStart);
      if (existing >= 0) this.anchors[existing] = batch;
      else this.anchors.push(batch);
      if (this.anchors.length > ANCHOR_CAP) this.anchors.splice(0, this.anchors.length - ANCHOR_CAP);
      if (batch.status === 'confirmed') this.metrics.anchorsConfirmed++;
      if (batch.status === 'failed') this.metrics.anchorsFailed++;
    });
    bus.on('status', (status) => {
      this.status = status;
      for (const fixture of status.fixtures) {
        this.fixtureState(fixture.id).fixture = fixture;
      }
    });
  }

  private onTick(tick: Tick): void {
    this.metrics.ticksIn++;
    if (tick.kind === 'score') this.fixtureState(tick.fixtureId).latestScore = tick;
  }

  private fixtureState(id: string): FixtureState {
    let fs = this.fixtures.get(id);
    if (!fs) {
      fs = {
        fixture: null,
        latestQuotes: null,
        latestScore: null,
        book: null,
        chart: [],
        trades: [],
        riskLog: [],
      };
      this.fixtures.set(id, fs);
    }
    return fs;
  }

  registerFixture(fixture: FixtureInfo): void {
    this.fixtureState(fixture.id).fixture = fixture;
  }

  resetFixture(id: string): void {
    this.fixtures.delete(id);
  }

  snapshot() {
    return {
      status: this.status,
      metrics: this.metrics,
      anchors: this.anchors,
      fixtures: Object.fromEntries(this.fixtures.entries()),
    };
  }
}
