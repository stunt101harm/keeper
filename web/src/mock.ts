/**
 * Dev-only visual mocks for wave-2 surfaces the server may not serve yet.
 *
 * Activated via `?mock=<flag>[,<flag>]` on the dashboard URL, ONLY in dev
 * builds (`import.meta.env.DEV`) — the production bundle strips this to a
 * constant empty set. Flags:
 *
 *   onchain     — synthesize an `onchain` block (program id + one open book
 *                 per tracked fixture) as if the chain module were wired.
 *   settled     — implies `onchain`, marks every book settled with proven
 *                 goals/winner/settle sig, and injects a SettlementEvent per
 *                 fixture so the settlement banner renders.
 *   recordings  — pad /api/recordings to 3 entries so the replay selector
 *                 shows even when only one real recording exists.
 */
import type { OnchainBook, RecordingInfo } from './domain';
import type { KeeperStore } from './store';

const MOCK_ADDR = 'BooKmoCkPda1111111111111111111111111111111';
const MOCK_PROGRAM = 'KeePmoCkPr0gram111111111111111111111111111';
const MOCK_ROOT = 'a3f9c2d871e64b05cc10fe9d2b7a4418c0ffee00aa11bb22cc33dd44ee55ff66';
const MOCK_SETTLE_SIG =
  '5mockSettLeS1gXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

export const MOCK_FLAGS: ReadonlySet<string> =
  typeof location !== 'undefined' && import.meta.env.DEV
    ? new Set(
        (new URLSearchParams(location.search).get('mock') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : new Set();

export function applyMocks(store: KeeperStore, flags: ReadonlySet<string>): void {
  const settled = flags.has('settled');

  if ((flags.has('onchain') || settled) && store.fixtures.size > 0) {
    const anchoredThrough = store.anchors
      .filter((a) => a.status === 'confirmed')
      .reduce((m, a) => Math.max(m, a.seqEnd), 41);
    const books: Record<string, OnchainBook> = {};
    for (const [id, buf] of store.fixtures) {
      const score = buf.latestScore?.score ?? { home: 2, away: 1 };
      const base: OnchainBook = {
        address: MOCK_ADDR,
        latestRoot: MOCK_ROOT,
        seqEnd: anchoredThrough,
        epochCount: 14,
        status: settled ? 'settled' : 'open',
        explorerUrl: `https://explorer.solana.com/address/${MOCK_ADDR}?cluster=devnet`,
      };
      books[id] = settled
        ? {
            ...base,
            provenGoals: [score.home, score.away],
            winner: score.home > score.away ? 'p1' : score.home < score.away ? 'p2' : 'draw',
            settleSig: MOCK_SETTLE_SIG,
          }
        : base;
    }
    store.onchain = { programId: MOCK_PROGRAM, network: 'devnet', books };
  }

  if (settled) {
    for (const buf of store.fixtures.values()) {
      if (buf.settlement) continue;
      const score = buf.latestScore?.score ?? { home: 2, away: 1 };
      buf.settlement = {
        kind: 'settlement',
        fixtureId: buf.id,
        ts: buf.lastTs || Date.now(),
        winner: score.home > score.away ? 'home' : score.home < score.away ? 'away' : 'draw',
        finalScore: score,
        realizedPnl: buf.book?.realizedPnl ?? 3.42,
      };
    }
  }

  if (flags.has('recordings') && store.recordings.length < 2) {
    const fakes: RecordingInfo[] = [
      {
        file: 'mock-france-england.jsonl',
        fixture: {
          id: 'mock-1',
          home: 'France',
          away: 'England',
          kickoffTs: Date.now(),
          competition: 'World Cup',
        },
        ticks: 5000,
        bytes: 1_200_000,
      },
      {
        file: 'mock-brazil-spain.jsonl',
        fixture: {
          id: 'mock-2',
          home: 'Brazil',
          away: 'Spain',
          kickoffTs: Date.now(),
          competition: 'World Cup',
        },
        ticks: 4200,
        bytes: 990_000,
      },
    ];
    store.recordings = [...store.recordings, ...fakes];
  }
}
