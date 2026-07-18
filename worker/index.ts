import { Container, getContainer } from '@cloudflare/containers';

/**
 * Cloudflare Worker front-end: proxies every request to a single named
 * container instance running the Keeper agent (Fastify + dashboard + SSE).
 * Secrets reach the container process env via envVars — never baked into
 * the image.
 */

interface Env {
  KEEPER: DurableObjectNamespace<KeeperContainer>;
  SOLANA_SECRET_KEY?: string;
  TXLINE_API_TOKEN?: string;
  SOLANA_RPC_URL?: string;
  KEEPER_MODE?: string;
  REPLAY_FILE?: string;
  ANCHOR_TARGET?: string;
  KEEPER_PROGRAM_ID?: string;
}

export class KeeperContainer extends Container<Env> {
  defaultPort = 8790;
  sleepAfter = '2h';

  override envVars: Record<string, string> = {};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: 'production',
      LOG_PRETTY: 'false',
      KEEPER_MODE: env.KEEPER_MODE ?? 'auto',
      REPLAY_FILE: env.REPLAY_FILE ?? 'data/18241006-england-argentina.jsonl',
      REPLAY_SPEED: '10',
      REPLAY_LOOP: 'true',
      REPLAY_START: 'kickoff',
      TXLINE_NETWORK: 'devnet',
      ...(env.SOLANA_SECRET_KEY ? { SOLANA_SECRET_KEY: env.SOLANA_SECRET_KEY } : {}),
      ...(env.TXLINE_API_TOKEN ? { TXLINE_API_TOKEN: env.TXLINE_API_TOKEN } : {}),
      ...(env.SOLANA_RPC_URL ? { SOLANA_RPC_URL: env.SOLANA_RPC_URL } : {}),
      ...(env.ANCHOR_TARGET ? { ANCHOR_TARGET: env.ANCHOR_TARGET } : {}),
      ...(env.KEEPER_PROGRAM_ID ? { KEEPER_PROGRAM_ID: env.KEEPER_PROGRAM_ID } : {}),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Single named instance: every visitor reaches the same agent, and the
    // Response streams (SSE) pass through untouched.
    return getContainer(env.KEEPER, 'main').fetch(request);
  },

  // Keep-awake cron (wrangler.jsonc triggers, every 4 min): an asleep
  // container cannot wake itself, so auto mode's orchestrator must be kept
  // standing by for kickoff. Hitting /health (re)starts the container and
  // resets the sleepAfter timer.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const res = await getContainer(env.KEEPER, 'main').fetch(
      new Request('http://keeper/health'),
    );
    // Drain the body so the runtime does not warn about a stalled response.
    await res.text().catch(() => undefined);
  },
};
