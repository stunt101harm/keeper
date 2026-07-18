import type { Config } from '../config.js';
import type { SettlementEvent } from '../types.js';
import { log } from '../log.js';
import { BookClient, explorerTx, registerSettleSig, type BookWinner } from './book.js';
import { epochDayOf, type StatValidationProof } from './txproof.js';

/**
 * settle.ts — the auto-settler: turns the engine's SettlementEvent (full-time
 * detected in the tick stream) into an on-chain, PROOF-GATED settle_book.
 *
 * Flow per fixture:
 *   1. GET /scores/snapshot/{fixtureId}  → find the game_finalised Seq
 *      (StatusId 100 — scanning ALL records, because the max-Seq record of a
 *      finished match is often a StatusId-less "disconnected").
 *   2. GET /scores/stat-validation?fixtureId=&seq=&statKeys=1,2 → Merkle
 *      proof of the final goals.
 *   3. settle_book(epoch_day, payload) with a 300k CU budget, SIMULATED
 *      first: while TxLINE's on-chain root lags the API's proof the sim
 *      fails and nothing is spent — we just retry next tick.
 *
 * The TxLINE fetch here is deliberately a ~40-line standalone (guest JWT +
 * X-Api-Token headers, one retry on 401) rather than an import of
 * src/ingest: the settler must keep working even if the ingest layer is
 * mid-refactor, and it needs exactly two endpoints.
 *
 * Settlement being permissionless means this process is a convenience
 * cranker, not an authority — if it dies, anyone can settle with the same
 * proof (scripts/settle-book.ts is that "anyone").
 */

const HOSTS: Record<'devnet' | 'mainnet', string> = {
  devnet: 'https://txline-dev.txodds.com',
  mainnet: 'https://txline.txodds.com',
};

export const GOAL_STAT_KEYS: [number, number] = [1, 2];

// ---------------------------------------------------------------------------
// Minimal authed TxLINE client (standalone by design — see header)
// ---------------------------------------------------------------------------

interface ScoreRecordLite {
  Seq: number;
  StatusId?: number;
  Action?: string;
}

export class SettleTxlineClient {
  private readonly apiBase: string;
  private readonly jwtUrl: string;
  private readonly apiToken: string;
  private jwt: string | null = null;

  constructor(txline: Config['txline']) {
    const host = HOSTS[txline.network];
    this.apiBase = txline.baseUrl ? txline.baseUrl.replace(/\/$/, '') : `${host}/api`;
    this.jwtUrl = `${this.apiBase.replace(/\/api$/, '')}/auth/guest/start`;
    if (!txline.apiToken) throw new Error('settle: TXLINE_API_TOKEN is not configured');
    this.apiToken = txline.apiToken;
  }

  private async getJwt(force = false): Promise<string> {
    if (this.jwt && !force) return this.jwt;
    const res = await fetch(this.jwtUrl, { method: 'POST', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`guest/start → HTTP ${res.status}`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error('guest/start response has no token');
    this.jwt = body.token;
    return body.token;
  }

  async getJson<T>(path: string): Promise<T> {
    let jwt = await this.getJwt();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.apiBase}${path}`, {
        headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': this.apiToken },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 && attempt === 0) {
        jwt = await this.getJwt(true); // expired guest JWT — renew once
        continue;
      }
      if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
      return (await res.json()) as T;
    }
  }

  scoresSnapshot(fixtureId: number): Promise<ScoreRecordLite[]> {
    return this.getJson<ScoreRecordLite[]>(`/scores/snapshot/${fixtureId}`);
  }

  statValidation(fixtureId: number, seq: number, statKeys: number[]): Promise<StatValidationProof> {
    return this.getJson<StatValidationProof>(
      `/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(',')}`,
    );
  }
}

/**
 * Find the Seq of the game_finalised record in a /scores/snapshot response.
 * Scans ALL records (not just max-Seq) and keeps the LOWEST finalised Seq —
 * verified live: the finalisation record can be followed by StatusId-less
 * trailer records ("disconnected").
 */
export function findFinalisedSeq(records: ScoreRecordLite[]): number | null {
  let seq: number | null = null;
  for (const rec of records) {
    if (rec.StatusId === 100 || rec.Action === 'game_finalised') {
      seq = seq === null ? rec.Seq : Math.min(seq, rec.Seq);
    }
  }
  return seq;
}

// ---------------------------------------------------------------------------
// One-shot settle
// ---------------------------------------------------------------------------

export interface SettleResult {
  sig: string;
  explorerUrl: string;
  epochDay: number;
  finalisedSeq: number;
  provenGoals: [number, number];
  winner: BookWinner;
}

export const winnerFromGoals = (p1: number, p2: number): BookWinner =>
  p1 > p2 ? 'p1' : p1 < p2 ? 'p2' : 'draw';

/**
 * Fetch the final-score proof for `fixtureId` from TxLINE and fire
 * settle_book. Throws when the fixture is not finalised yet, when the
 * on-chain root still lags the proof (simulation failure — retryable), or
 * when the book is already settled.
 */
export async function settleBookOnChain(
  config: Config,
  fixtureId: string | number,
  opts: { seq?: number; proof?: StatValidationProof } = {},
): Promise<SettleResult> {
  const client = BookClient.fromConfig(config);
  if (!client) throw new Error('settle: KEEPER_PROGRAM_ID not configured');

  let proof = opts.proof;
  let finalisedSeq = opts.seq ?? -1;
  if (!proof) {
    const txline = new SettleTxlineClient(config.txline);
    if (opts.seq === undefined) {
      const snapshot = await txline.scoresSnapshot(Number(fixtureId));
      const seq = findFinalisedSeq(snapshot);
      if (seq === null) throw new Error(`settle: fixture ${fixtureId} is not finalised yet`);
      finalisedSeq = seq;
    }
    proof = await txline.statValidation(Number(fixtureId), finalisedSeq, GOAL_STAT_KEYS);
  }

  const epochDay = epochDayOf(proof);
  const sig = await client.settleBook(fixtureId, epochDay, proof, { simulateFirst: true });
  registerSettleSig(String(fixtureId), sig);

  const p1 = proof.statsToProve[0]?.value ?? 0;
  const p2 = proof.statsToProve[1]?.value ?? 0;
  return {
    sig,
    explorerUrl: explorerTx(sig),
    epochDay,
    finalisedSeq,
    provenGoals: [p1, p2],
    winner: winnerFromGoals(p1, p2),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator hook
// ---------------------------------------------------------------------------

export interface AutoSettler {
  /** Call on every engine SettlementEvent; idempotent per fixture. */
  onSettlement(event: SettlementEvent): void;
  stop(): void;
}

export interface AutoSettlerOpts {
  /** Seconds between retries while the TxLINE root lags (default 30). */
  retryIntervalSec?: number;
  /** Give up after this many attempts (default 60 ≈ 30 min). */
  maxAttempts?: number;
  /** Test seam: replaces the settle call. */
  settleFn?: (fixtureId: string) => Promise<SettleResult>;
}

/**
 * The engine's SettlementEvent → on-chain settle_book bridge, with the
 * root-posting-lag retry loop. Wire-up (integration): on engine events with
 * `kind === 'settlement'`, call `autoSettler.onSettlement(ev)`.
 *
 * Only active when ANCHOR_TARGET=program with a program id and a signer;
 * otherwise every call is a silent no-op, so the orchestrator can wire it
 * unconditionally.
 */
export function makeAutoSettler(config: Config, opts: AutoSettlerOpts = {}): AutoSettler {
  const retryMs = (opts.retryIntervalSec ?? 30) * 1000;
  const maxAttempts = opts.maxAttempts ?? 60;
  const settleFn = opts.settleFn ?? ((fixtureId: string) => settleBookOnChain(config, fixtureId));
  const enabled =
    opts.settleFn !== undefined ||
    (config.solana.anchorTarget === 'program' &&
      config.solana.programId !== undefined &&
      config.solana.secretKey !== undefined);

  const inProgress = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  const attempt = (fixtureId: string, n: number): void => {
    if (stopped) return;
    void settleFn(fixtureId)
      .then((result) => {
        log.info(
          { fixtureId, sig: result.sig, provenGoals: result.provenGoals, winner: result.winner },
          'chain: book settled on-chain with TxLINE proof',
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (/AlreadySettled|already settled/i.test(message)) {
          log.info({ fixtureId }, 'chain: book already settled — auto-settler done');
          return;
        }
        if (n >= maxAttempts) {
          log.error({ fixtureId, attempts: n, err: message }, 'chain: auto-settle gave up');
          return;
        }
        // Root-posting lag, transient RPC or API failure: retry on a timer.
        log.info(
          { fixtureId, attempt: n, retryInSec: retryMs / 1000, err: message },
          'chain: settle not possible yet — will retry',
        );
        const timer = setTimeout(() => {
          timers.delete(timer);
          attempt(fixtureId, n + 1);
        }, retryMs);
        timer.unref?.();
        timers.add(timer);
      });
  };

  return {
    onSettlement(event: SettlementEvent): void {
      if (!enabled || inProgress.has(event.fixtureId)) return;
      inProgress.add(event.fixtureId);
      log.info(
        { fixtureId: event.fixtureId, finalScore: event.finalScore },
        'chain: settlement detected — starting proof-gated on-chain settle',
      );
      attempt(event.fixtureId, 1);
    },
    stop(): void {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
