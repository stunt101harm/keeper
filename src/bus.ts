import { EventEmitter } from 'node:events';
import type { AnchorBatch, BusEvent, EngineEvent, StatusEvent, Tick } from './types.js';

interface BusEvents {
  tick: [Tick];
  engine: [EngineEvent];
  anchor: [AnchorBatch];
  status: [StatusEvent];
}

/**
 * Typed in-process event bus. The engine reducer publishes here; recorder,
 * anchorer, and the SSE server subscribe. Also assigns a monotonically
 * increasing sequence number to every engine event — the anchoring layer
 * batches by sequence range, so ordering must be total.
 */
export class Bus extends EventEmitter<BusEvents> {
  private seq = 0;

  /** Engine events, in order, since process start (source for anchor batches + SSE catch-up). */
  readonly engineLog: Array<{ seq: number; event: EngineEvent }> = [];

  publishTick(tick: Tick): void {
    this.emit('tick', tick);
  }

  publishEngine(event: EngineEvent): number {
    const seq = this.seq++;
    this.engineLog.push({ seq, event });
    this.emit('engine', event);
    return seq;
  }

  publishAnchor(batch: AnchorBatch): void {
    this.emit('anchor', batch);
  }

  publishStatus(status: StatusEvent): void {
    this.emit('status', status);
  }
}

export type { BusEvent };
