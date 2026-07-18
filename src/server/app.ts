import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { Engine } from '../engine/index.js';
import { log } from '../log.js';
import { listRecordings, resolveRecording } from './recordings.js';
import type { StateStore } from './state.js';
import type { FixtureInfo } from '../types.js';

/**
 * Composition-root hooks the server exposes (docs/CONTRACTS-WAVE2.md): the
 * orchestrator/replay runner supply the effective source + replay swapping.
 */
export interface SourceControl {
  /** What the orchestrator is currently running (replay unless live is up). */
  getActiveSource(): 'live' | 'replay';
  /** Currently loaded replay recording (path as configured/selected). */
  getReplayFile?(): string;
  /**
   * Swap the active replay source to `file` (absolute/relative path, already
   * validated to live inside the data dir). Implementations reset the engine
   * + old fixture state and publish a fresh status. Throws on unreadable or
   * tick-less recordings — the route maps that to 400.
   */
  selectReplay(file: string): FixtureInfo | null;
}

export interface ServerDeps {
  config: Config;
  bus: Bus;
  state: StateStore;
  engine: Engine;
  /** Absent in bare setups (tests, pure live mode without a runner). */
  sources?: SourceControl;
  /** Recordings directory (default 'data'). */
  dataDir?: string;
}

/**
 * On-chain snapshot provider (CONTRACTS-WAVE2 /api/state.onchain). The chain
 * module registers it at startup via setOnchainProvider(); /api/state renders
 * {} when it is absent or throws — the dashboard must never 500 because
 * devnet is down.
 */
export type OnchainProvider = () => unknown | Promise<unknown>;

let onchainProvider: OnchainProvider | null = null;

export function setOnchainProvider(fn: OnchainProvider | null): void {
  onchainProvider = fn;
}

async function resolveOnchain(): Promise<unknown> {
  if (!onchainProvider) return {};
  try {
    return (await onchainProvider()) ?? {};
  } catch (err) {
    log.warn({ err: String(err) }, 'server: onchain provider failed — rendering {}');
    return {};
  }
}

/** Build the Fastify app without binding a port (unit tests use inject()). */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, bus, state, engine } = deps;
  const dataDir = deps.dataDir ?? 'data';
  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });

  const startedAt = Date.now();
  let halted = false;

  const activeSource = (): 'live' | 'replay' =>
    deps.sources?.getActiveSource() ?? (config.mode === 'live' ? 'live' : 'replay');

  app.get('/health', async () => ({
    ok: true,
    mode: config.mode,
    activeSource: activeSource(),
    feed: state.status?.feed ?? 'ok',
    lastTickTs: state.status?.lastTickTs ?? null,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    halted,
  }));

  app.get('/metrics', async () => ({ ...state.metrics, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));

  app.get('/api/state', async () => {
    const source = activeSource();
    return {
      mode: config.mode,
      activeSource: source,
      replay:
        source === 'replay'
          ? { ...config.replay, file: deps.sources?.getReplayFile?.() ?? config.replay.file }
          : undefined,
      params: config.engine,
      halted,
      onchain: await resolveOnchain(),
      ...state.snapshot(),
    };
  });

  // Recordings API (docs/CONTRACTS-WAVE2.md)
  app.get('/api/recordings', async () => ({ recordings: listRecordings(dataDir) }));

  app.get('/api/recordings/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const full = resolveRecording(dataDir, file);
    if (!full) return reply.code(404).send({ error: 'no such recording' });
    return reply
      .header('Content-Type', 'application/x-ndjson')
      .header('Content-Disposition', `attachment; filename="${path.basename(full)}"`)
      .send(createReadStream(full));
  });

  app.post('/api/replay/select', async (req, reply) => {
    const body = req.body as { file?: unknown } | null;
    const file = typeof body?.file === 'string' ? body.file : null;
    if (!file) return reply.code(400).send({ error: 'body must be { file: string }' });
    if (activeSource() !== 'replay') {
      return reply
        .code(409)
        .send({ error: 'live source active — replay selection unavailable' });
    }
    if (!deps.sources) {
      return reply.code(409).send({ error: 'replay selection not supported in this mode' });
    }
    const full = resolveRecording(dataDir, file);
    if (!full) return reply.code(404).send({ error: 'no such recording' });
    try {
      const fixture = deps.sources.selectReplay(full);
      log.info({ file }, 'server: replay recording selected');
      return { ok: true, file, fixture };
    } catch (err) {
      return reply.code(400).send({ error: `recording rejected: ${String(err)}` });
    }
  });

  // Ops kill-switch (the one intended human control)
  app.post('/api/halt', async () => {
    halted = true;
    engine.setHalted(true, 'manual halt via API');
    return { halted };
  });
  app.post('/api/resume', async () => {
    halted = false;
    engine.setHalted(false);
    return { halted };
  });

  // Server-Sent Events: forward every bus event, typed.
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const send = (type: string, data: unknown) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onTick = (t: unknown) => send('tick', t);
    const onEngine = (e: unknown) => send('engine', e);
    const onAnchor = (a: unknown) => send('anchor', a);
    const onStatus = (s: unknown) => send('status', s);
    bus.on('tick', onTick);
    bus.on('engine', onEngine);
    bus.on('anchor', onAnchor);
    bus.on('status', onStatus);
    const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), 15000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      bus.off('tick', onTick);
      bus.off('engine', onEngine);
      bus.off('anchor', onAnchor);
      bus.off('status', onStatus);
    });
  });

  // Static dashboard build, if present
  const webDist = path.resolve('web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

export async function startServer(deps: ServerDeps) {
  const app = await buildServer(deps);
  await app.listen({ port: deps.config.server.port, host: deps.config.server.host });
  log.info({ port: deps.config.server.port, mode: deps.config.mode }, 'server: listening');
  return app;
}
