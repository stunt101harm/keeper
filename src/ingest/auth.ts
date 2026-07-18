/**
 * auth.ts — TxLINE auth as a managed resource.
 *
 * Two credentials are in play:
 *
 *  - TXLINE_API_TOKEN (long-lived): comes in via config (src/config.ts reads
 *    .env through dotenv); sent as `X-Api-Token` on every data request.
 *  - Guest JWT (short-lived): POST {host}/auth/guest/start → { token }; sent
 *    as `Authorization: Bearer <jwt>`. The API answers 401 when it expires and
 *    the fix is simply to fetch a fresh one — the same X-Api-Token keeps
 *    working.
 *
 * authedFetch() hides all of that from callers: 401 → single-flight JWT
 * renewal and retry; 5xx / network failure → 2s/8s/30s backoff. The backoff
 * matters: devnet had a ~10-minute full 503 outage on 2026-07-17 (auth
 * endpoints stayed up, data endpoints all 503) — every caller must assume the
 * API can vanish briefly and come back, and nothing may crash while it is
 * gone.
 *
 * SECURITY: credential values must never appear in logs or errors.
 */

import type { Config } from '../config.js';

const HOSTS: Record<'devnet' | 'mainnet', string> = {
  devnet: 'https://txline-dev.txodds.com',
  mainnet: 'https://txline.txodds.com',
};

/** Backoff ladder for 5xx / network errors: 3 retries → 4 attempts total. */
const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];

/**
 * Cap on 401→renew cycles inside one authedFetch call. Two is enough for the
 * legitimate case (expired JWT, then a renewal that raced another renewal);
 * more than that means the API token itself is being rejected and retrying
 * forever would just mask a configuration error.
 */
const MAX_JWT_RETRIES = 2;

/** Default per-attempt timeout for plain (non-streaming) requests. */
const REQUEST_TIMEOUT_MS = 30_000;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface AuthedFetchOptions extends RequestInit {
  /**
   * Disable the default 30s per-attempt timeout. Required for streaming
   * responses (SSE) and large bodies, where the caller manages its own
   * AbortController lifetime via `signal`.
   */
  noTimeout?: boolean;
}

export class TxlineAuth {
  readonly apiBase: string;
  private readonly jwtUrl: string;
  private readonly apiToken: string;

  private jwt: string | null = null;
  /**
   * Single-flight renewal: when N concurrent requests all hit 401 (typical
   * after the JWT expires under a busy recorder), they must share ONE
   * guest/start call, not stampede the auth endpoint with N of them.
   */
  private renewInFlight: Promise<string> | null = null;

  constructor(txline: Config['txline']) {
    const host = HOSTS[txline.network];
    if (txline.baseUrl) {
      // Explicit override: baseUrl is the API base; the auth endpoint lives on
      // the same host one level up from /api.
      this.apiBase = txline.baseUrl.replace(/\/$/, '');
      this.jwtUrl = `${this.apiBase.replace(/\/api$/, '')}/auth/guest/start`;
    } else {
      this.apiBase = `${host}/api`;
      this.jwtUrl = `${host}/auth/guest/start`;
    }
    if (!txline.apiToken) {
      throw new Error(
        'TXLINE_API_TOKEN is not set — put it in the repo root .env or export it before running the keeper',
      );
    }
    this.apiToken = txline.apiToken;
  }

  /** Current JWT, acquiring one if we have none yet. */
  async getJwt(): Promise<string> {
    return this.jwt ?? this.renewJwt();
  }

  /** Force-renew the guest JWT (single-flight; see renewInFlight). */
  renewJwt(): Promise<string> {
    if (!this.renewInFlight) {
      this.renewInFlight = this.doRenew().finally(() => {
        this.renewInFlight = null;
      });
    }
    return this.renewInFlight;
  }

  private async doRenew(): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        // Auth endpoints stayed up during the 2026-07-17 data outage, but we
        // retry anyway — a keeper that dies because guest/start hiccuped once
        // during a live match is not acceptable.
        const res = await fetch(this.jwtUrl, {
          method: 'POST',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`guest/start returned HTTP ${res.status}`);
        const body = (await res.json()) as { token?: string };
        if (!body.token) throw new Error('guest/start response has no token field');
        this.jwt = body.token;
        return body.token;
      } catch (err) {
        lastErr = err;
        if (attempt >= RETRY_DELAYS_MS.length) break;
        await sleep(RETRY_DELAYS_MS[attempt] ?? 30_000);
      }
    }
    throw new Error(
      `guest JWT renewal failed after ${RETRY_DELAYS_MS.length + 1} attempts: ${String(lastErr)}`,
    );
  }

  /**
   * fetch() with TxLINE auth headers, JWT renewal on 401, and 5xx/network
   * retry with backoff. Returns the final Response — callers still check
   * res.ok, because after exhausting retries we hand back the last failing
   * response rather than throwing (the status code carries useful signal,
   * e.g. "the whole API is 503 again").
   *
   * `path` may be "/scores/stream" style (joined to the API base) or a full URL.
   */
  async authedFetch(path: string, init: AuthedFetchOptions = {}): Promise<Response> {
    const url = path.startsWith('http')
      ? path
      : `${this.apiBase}${path.startsWith('/') ? '' : '/'}${path}`;
    const { noTimeout, ...rest } = init;

    let jwt = await this.getJwt();
    let serverRetries = 0;
    let jwtRetries = 0;

    for (;;) {
      const headers = new Headers(rest.headers);
      headers.set('Authorization', `Bearer ${jwt}`);
      headers.set('X-Api-Token', this.apiToken);
      // A caller-supplied signal takes precedence (streaming callers own their
      // AbortController); otherwise plain requests get a per-attempt timeout so
      // a black-holed TCP connection cannot hang the keeper forever.
      const signal =
        rest.signal ?? (noTimeout ? undefined : AbortSignal.timeout(REQUEST_TIMEOUT_MS));

      let res: Response | null = null;
      let netErr: unknown = null;
      try {
        res = await fetch(url, { ...rest, headers, ...(signal ? { signal } : {}) });
      } catch (err) {
        // A deliberate caller abort must propagate — only transient failures retry.
        if (rest.signal?.aborted) throw err;
        netErr = err;
      }

      if (res) {
        if (res.status === 401 && jwtRetries < MAX_JWT_RETRIES) {
          jwtRetries++;
          void res.body?.cancel().catch(() => {});
          // If another request already renewed while ours was in flight, just
          // pick up the fresh JWT instead of renewing again.
          jwt = this.jwt !== null && this.jwt !== jwt ? this.jwt : await this.renewJwt();
          continue;
        }
        // 2xx/3xx/4xx (including a persistent 401 past the cap): final answer.
        if (res.status < 500) return res;
      }

      if (serverRetries >= RETRY_DELAYS_MS.length) {
        if (res) return res;
        throw netErr instanceof Error ? netErr : new Error(String(netErr));
      }
      // Drain the failed response so the socket is released before we sleep.
      if (res) void res.body?.cancel().catch(() => {});
      await sleep(RETRY_DELAYS_MS[serverRetries] ?? 30_000);
      serverRetries++;
    }
  }
}
