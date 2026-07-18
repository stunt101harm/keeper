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

  PORT: num(8790),
  HOST: z.string().default('0.0.0.0'),

  TXLINE_NETWORK: z.enum(['devnet', 'mainnet']).default('devnet'),
  TXLINE_BASE_URL: z.string().optional(),
  TXLINE_POLL_MS: num(1000),

  SOLANA_SECRET_KEY: z.string().optional(),
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  ANCHOR_INTERVAL_SEC: num(30),
  ANCHOR_ENABLED: bool(true),

  // Engine parameters (probability space unless noted). Defaults are the
  // adversarially-reviewed values — justifications in docs/MODEL.md.
  GAMMA: num(20), // risk aversion; calibrated so skew at full cap ≈ one half-spread
  DELTA_MIN: num(0.005), // minimum half-spread (50 bps); 3·δ_min = structural overround
  DELTA_MAX: num(0.04), // maximum half-spread
  K_VOL: num(1.5), // half-spread volatility multiplier (on σ_prob)
  EWMA_HALF_LIFE_TICKS: num(25), // volatility estimator half-life, in odds ticks
  FREEZE_GOAL_SEC: num(30), // feed-time seconds
  FREEZE_VAR_SEC: num(120), // VAR: until resolution + 10s, capped here
  FREEZE_RED_CARD_SEC: num(20),
  REENTRY_WIDEN_MULT: num(2), // spread multiplier on freeze exit...
  REENTRY_DECAY_TICKS: num(25), // ...decaying to 1 over this many ticks
  CLIP_SIZE: num(1), // stake units per fill
  INVENTORY_CAP: num(10), // per-outcome NET EXPOSURE cap -> reduce-only
  MAX_DRAWDOWN: num(5), // equity drawdown from high-water mark -> flatten
  STALE_FEED_SEC: num(10), // feed-time gap with no ticks -> halt quoting
  MIN_QUOTE_PROB: num(0.03), // no new quotes below this fair prob
  MAX_QUOTE_PROB: num(0.97), // ...or above this
  ARB_MARGIN: num(0.01), // post-rounding no-arb margin check
  BENIGN_A: num(0.12), // benign-flow intensity scale (accumulator gain/tick)
  BENIGN_K: num(250), // benign-flow spread sensitivity: I += A·exp(−K·δ)
  WARMUP_TICKS: num(20), // no quoting until the vol estimator has warmed up
  SIGMA_MIN: num(0.005), // floor on σ_logit
  SIGMA_MAX: num(0.2), // cap on σ_logit
  JUMP_SIGMA_MULT: num(5), // circuit breaker: |Δlogit| > max(mult·σ, JUMP_LOGIT_ABS)
  JUMP_LOGIT_ABS: num(0.5),
});

export type Env = z.infer<typeof EnvSchema>;

export interface EngineParams {
  gamma: number;
  deltaMin: number;
  deltaMax: number;
  kVol: number;
  ewmaHalfLifeTicks: number;
  freezeSec: { goal: number; var: number; red_card: number };
  reentryWidenMult: number;
  reentryDecayTicks: number;
  clipSize: number;
  inventoryCap: number;
  maxDrawdown: number;
  staleFeedSec: number;
  minQuoteProb: number;
  maxQuoteProb: number;
  arbMargin: number;
  benignA: number;
  benignK: number;
  warmupTicks: number;
  sigmaMin: number;
  sigmaMax: number;
  jumpSigmaMult: number;
  jumpLogitAbs: number;
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
      ewmaHalfLifeTicks: e.EWMA_HALF_LIFE_TICKS,
      freezeSec: { goal: e.FREEZE_GOAL_SEC, var: e.FREEZE_VAR_SEC, red_card: e.FREEZE_RED_CARD_SEC },
      reentryWidenMult: e.REENTRY_WIDEN_MULT,
      reentryDecayTicks: e.REENTRY_DECAY_TICKS,
      clipSize: e.CLIP_SIZE,
      inventoryCap: e.INVENTORY_CAP,
      maxDrawdown: e.MAX_DRAWDOWN,
      staleFeedSec: e.STALE_FEED_SEC,
      minQuoteProb: e.MIN_QUOTE_PROB,
      maxQuoteProb: e.MAX_QUOTE_PROB,
      arbMargin: e.ARB_MARGIN,
      benignA: e.BENIGN_A,
      benignK: e.BENIGN_K,
      warmupTicks: e.WARMUP_TICKS,
      sigmaMin: e.SIGMA_MIN,
      sigmaMax: e.SIGMA_MAX,
      jumpSigmaMult: e.JUMP_SIGMA_MULT,
      jumpLogitAbs: e.JUMP_LOGIT_ABS,
    },
  };
}
