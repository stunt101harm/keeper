import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { Engine } from '../engine/index.js';
import { log } from '../log.js';
import type { StateStore } from './state.js';

export interface ServerDeps {
  config: Config;
  bus: Bus;
  state: StateStore;
  engine: Engine;
}

export async function startServer({ config, bus, state, engine }: ServerDeps) {
  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });

  const startedAt = Date.now();
  let halted = false;

  app.get('/health', async () => ({
    ok: true,
    mode: config.mode,
    feed: state.status?.feed ?? 'ok',
    lastTickTs: state.status?.lastTickTs ?? null,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    halted,
  }));

  app.get('/metrics', async () => ({ ...state.metrics, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));

  app.get('/api/state', async () => ({
    mode: config.mode,
    replay: config.mode === 'replay' ? config.replay : undefined,
    params: config.engine,
    halted,
    ...state.snapshot(),
  }));

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

  await app.listen({ port: config.server.port, host: config.server.host });
  log.info({ port: config.server.port, mode: config.mode }, 'server: listening');
  return app;
}
