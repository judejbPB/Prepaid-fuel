// Vercel function entry: the whole API with an in-memory demo database, seeded on each cold start.
// Demo only: data resets whenever the platform starts a new instance.
import { buildApp } from '../server/src/app.js';
import { createCtx } from '../server/src/context.js';
import { seedDemo } from '../server/src/demo.js';

const ctx = createCtx(':memory:');
seedDemo(ctx);
const app = buildApp(ctx);
const ready = app.ready();

export default async function handler(req: any, res: any) {
  await ready;
  // Requests are routed here as /api?__path=<rest>; restore the original /api/<rest> URL for Fastify.
  const url = new URL(req.url, 'http://local');
  const path = url.searchParams.get('__path');
  if (path !== null) {
    url.searchParams.delete('__path');
    const qs = url.searchParams.toString();
    req.url = `/api/${path}${qs ? `?${qs}` : ''}`;
  }
  app.server.emit('request', req, res);
}
