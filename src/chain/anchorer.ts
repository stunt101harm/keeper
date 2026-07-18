import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import { log } from '../log.js';

export interface AnchorerDeps {
  bus: Bus;
  config: Config;
}

// Placeholder — real Solana anchoring lands with issue #10.
export function startAnchorer(_deps: AnchorerDeps): void {
  log.warn('chain: anchorer stub — no anchoring yet');
}
