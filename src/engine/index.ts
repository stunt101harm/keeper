import type { EngineParams } from '../config.js';
import type { BookSnapshot, EngineEvent, Tick } from '../types.js';

/**
 * The trading core. Implemented as a deterministic reducer: `onTick` is the
 * ONLY way state advances, and it never reads the wall clock — identical tick
 * streams produce identical event streams, byte for byte.
 *
 * `setHalted` is the one operational control (ops kill-switch). It is an
 * explicit external input; using it during a replay breaks determinism by
 * design, and that is documented behavior.
 */
export interface Engine {
  onTick(tick: Tick): EngineEvent[];
  /** Full reset (used on replay loop restart). */
  reset(): void;
  /** Current book for a fixture, for server hydration. */
  book(fixtureId: string): BookSnapshot | null;
  setHalted(halted: boolean, reason?: string): void;
}

// Placeholder wiring stub — replaced by the real reducer (issues #6–#9).
export function createEngine(_params: EngineParams): Engine {
  return {
    onTick: () => [],
    reset: () => {},
    book: () => null,
    setHalted: () => {},
  };
}
