import 'dotenv/config';
import { z } from 'zod';

/**
 * All tunable parameters live here, env-overridable, so the engine itself is a
 * pure function of (config, tick stream). Defaults are the reviewed values —
 * see docs/MODEL.md for justifications.
 */

const num = (def: number) => z.coerce.number().default(def);
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const EnvSchema = z.object({
  KEEPER_MODE: z.enum(['live', 'replay']).default('replay'),
  REPLAY_FILE: z.string().default('data/sample-match.jsonl'),
  REPLAY_SPEED: num(10),
  REPLAY_LOOP: bool(true),

  PORT: num(8787),
  HOST: z.string().default('0.0.0.0'),

  TXLINE_NETWORK: z.enum(['devnet', 'mainnet']).default('devnet'),
  TXLINE_BASE_URL: z.string().optional(),
  TXLINE_POLL_MS: num(1000),

  SOLANA_SECRET_KEY: z.string().optional(),
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  ANCHOR_INTERVAL_SEC: num(30),
  ANCHOR_ENABLED: bool(true),

  // Engine parameters (probability space unless noted)
  GAMMA: num(0.5), // risk aversion in reservation-price skew
  DELTA_MIN: num(0.008), // minimum half-spread
  DELTA_MAX: num(0.06), // maximum half-spread
  K_VOL: num(1.5), // half-spread volatility multiplier
  EWMA_HALF_LIFE_SEC: num(120), // volatility estimator half-life
  FREEZE_GOAL_SEC: num(45),
  FREEZE_VAR_SEC: num(90),
  FREEZE_RED_CARD_SEC: num(30),
  CLIP_SIZE: num(1), // stake units per fill
  INVENTORY_CAP: num(10), // per-outcome absolute inventory cap
  MAX_DRAWDOWN: num(8), // per-match equity drawdown -> flatten mode
  STALE_FEED_SEC: num(20), // no ticks for this long -> halt quoting
  MIN_QUOTE_PROB: num(0.03), // stop quoting an outcome below this fair prob
  MAX_QUOTE_PROB: num(0.97), // ...or above this
  ARB_MARGIN: num(0.01), // enforced no-arb margin across the outcome set
});

export type Env = z.infer<typeof EnvSchema>;

export interface EngineParams {
  gamma: number;
  deltaMin: number;
  deltaMax: number;
  kVol: number;
  ewmaHalfLifeSec: number;
  freezeSec: { goal: number; var: number; red_card: number };
  clipSize: number;
  inventoryCap: number;
  maxDrawdown: number;
  staleFeedSec: number;
  minQuoteProb: number;
  maxQuoteProb: number;
  arbMargin: number;
}

export interface Config {
  mode: 'live' | 'replay';
  replay: { file: string; speed: number; loop: boolean };
  server: { port: number; host: string };
  txline: { network: 'devnet' | 'mainnet'; baseUrl?: string; pollMs: number };
  solana: {
    secretKey?: string;
    rpcUrl: string;
    anchorIntervalSec: number;
    anchorEnabled: boolean;
  };
  engine: EngineParams;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  return {
    mode: e.KEEPER_MODE,
    replay: { file: e.REPLAY_FILE, speed: e.REPLAY_SPEED, loop: e.REPLAY_LOOP },
    server: { port: e.PORT, host: e.HOST },
    txline: {
      network: e.TXLINE_NETWORK,
      ...(e.TXLINE_BASE_URL ? { baseUrl: e.TXLINE_BASE_URL } : {}),
      pollMs: e.TXLINE_POLL_MS,
    },
    solana: {
      ...(e.SOLANA_SECRET_KEY ? { secretKey: e.SOLANA_SECRET_KEY } : {}),
      rpcUrl: e.SOLANA_RPC_URL,
      anchorIntervalSec: e.ANCHOR_INTERVAL_SEC,
      anchorEnabled: e.ANCHOR_ENABLED,
    },
    engine: {
      gamma: e.GAMMA,
      deltaMin: e.DELTA_MIN,
      deltaMax: e.DELTA_MAX,
      kVol: e.K_VOL,
      ewmaHalfLifeSec: e.EWMA_HALF_LIFE_SEC,
      freezeSec: { goal: e.FREEZE_GOAL_SEC, var: e.FREEZE_VAR_SEC, red_card: e.FREEZE_RED_CARD_SEC },
      clipSize: e.CLIP_SIZE,
      inventoryCap: e.INVENTORY_CAP,
      maxDrawdown: e.MAX_DRAWDOWN,
      staleFeedSec: e.STALE_FEED_SEC,
      minQuoteProb: e.MIN_QUOTE_PROB,
      maxQuoteProb: e.MAX_QUOTE_PROB,
      arbMargin: e.ARB_MARGIN,
    },
  };
}
