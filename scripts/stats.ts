/**
 * Run a recording through the engine and print summary statistics —
 * the numbers quoted in docs/MODEL.md and the demo.
 *
 *   tsx scripts/stats.ts [recording=data/18241006-england-argentina.jsonl]
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createEngine } from '../src/engine/index.js';
import { parseRecording } from '../src/replay/recording.js';
import type { BookSnapshot, SettlementEvent } from '../src/types.js';

const file = process.argv[2] ?? 'data/18241006-england-argentina.jsonl';
const { fixture, ticks } = parseRecording(readFileSync(file, 'utf8'));
const engine = createEngine(loadConfig().engine);

let quoteSets = 0;
let twoSided = 0;
const fills = { benign: 0, informed: 0 };
let freezes = 0;
let breakers = 0;
let staleHalts = 0;
let maxAbsU = 0;
let lastBook: BookSnapshot | null = null;
let settlement: SettlementEvent | null = null;

for (const tick of ticks) {
  for (const ev of engine.onTick(tick)) {
    switch (ev.kind) {
      case 'quotes': {
        quoteSets++;
        const q = ev.quotes;
        if (q.home.bid !== null && q.home.ask !== null) twoSided++;
        break;
      }
      case 'trade':
        fills[ev.fillType]++;
        break;
      case 'risk':
        if (ev.to === 'frozen') {
          freezes++;
          if (ev.reason.includes('jump') || ev.reason.includes('breaker')) breakers++;
        }
        if (ev.reason === 'stale_feed') staleHalts++;
        break;
      case 'book':
        lastBook = ev;
        for (const u of Object.values(ev.netExposure)) maxAbsU = Math.max(maxAbsU, Math.abs(u));
        break;
      case 'settlement':
        settlement = ev;
        break;
    }
  }
}

console.log(`recording: ${file}`);
console.log(`fixture:   ${fixture?.home} v ${fixture?.away} (${fixture?.competition})`);
console.log(`ticks:     ${ticks.length}  quote sets: ${quoteSets}`);
console.log(
  `uptime:    ${((100 * twoSided) / Math.max(1, quoteSets)).toFixed(1)}% two-sided (${twoSided}/${quoteSets})`,
);
console.log(
  `fills:     ${fills.benign} benign : ${fills.informed} informed = ${(fills.benign / Math.max(1, fills.informed)).toFixed(2)}:1`,
);
console.log(`freezes:   ${freezes} (breaker: ${breakers})  stale halts: ${staleHalts}`);
console.log(`max |u|:   ${maxAbsU.toFixed(3)}`);
if (settlement) {
  console.log(
    `settled:   ${settlement.winner} ${settlement.finalScore.home}-${settlement.finalScore.away}, realized ${settlement.realizedPnl.toFixed(4)}`,
  );
}
if (lastBook) {
  const { pnl } = lastBook;
  console.log(
    `P&L:       realized ${lastBook.realizedPnl.toFixed(4)}  (spread ${pnl.spreadCapture.toFixed(4)}, drift ${pnl.inventoryDrift.toFixed(4)}, settle ${pnl.settlementResidual.toFixed(4)})  trades ${lastBook.tradeCount}`,
  );
}
