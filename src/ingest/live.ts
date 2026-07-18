import type { Config } from '../config.js';
import type { FixtureInfo, Tick } from '../types.js';

export interface LiveIngestDeps {
  config: Config;
  onTick(tick: Tick): void;
  onFixtures(fixtures: FixtureInfo[]): void;
}

// Placeholder — real TxLINE ingestion lands with issues #3/#4.
export async function startLiveIngest(_deps: LiveIngestDeps): Promise<void> {
  throw new Error('live ingest not implemented yet — run in KEEPER_MODE=replay');
}
