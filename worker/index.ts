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
      KEEPER_MODE: env.KEEPER_MODE ?? 'replay',
      REPLAY_FILE: env.REPLAY_FILE ?? 'data/18241006-england-argentina.jsonl',
      REPLAY_SPEED: '10',
      REPLAY_LOOP: 'true',
      REPLAY_START: 'kickoff',
      TXLINE_NETWORK: 'devnet',
      ...(env.SOLANA_SECRET_KEY ? { SOLANA_SECRET_KEY: env.SOLANA_SECRET_KEY } : {}),
      ...(env.TXLINE_API_TOKEN ? { TXLINE_API_TOKEN: env.TXLINE_API_TOKEN } : {}),
      ...(env.SOLANA_RPC_URL ? { SOLANA_RPC_URL: env.SOLANA_RPC_URL } : {}),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Single named instance: every visitor reaches the same agent, and the
    // Response streams (SSE) pass through untouched.
    return getContainer(env.KEEPER, 'main').fetch(request);
  },
};
