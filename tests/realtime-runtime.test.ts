import { expect, it } from 'vitest';
import { build } from '../web/node_modules/esbuild/lib/main.js';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { applyMigrationFile } from './helpers/d1';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../web/node_modules/miniflare/dist/src/index.js';

async function seedStaffSession(mf: Miniflare) {
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const file of readdirSync(resolve('web/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await applyMigrationFile(db, file);
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO user (id, name, email, email_verified, role, two_factor_enabled, created_at, updated_at) VALUES ('staff-1', 'S', 'staff@example.com', 1, 'owner', 1, ?, ?)"
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES ('sess-1', 'tok-1', 'staff-1', ?, ?, ?)"
      )
      .bind(now + 3_600_000, now, now),
    db
      .prepare(
        "INSERT INTO staff_two_factor_sessions (session_id, user_id, verified_at) VALUES ('sess-1', 'staff-1', ?)"
      )
      .bind(new Date().toISOString()),
  ]);
  return db;
}

async function realtimeHarness() {
  const bundle = await build({
    entryPoints: [resolve('web/src/do/realtime.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:workers'],
  });
  const script =
    bundle.outputFiles[0]!.text +
    `
    export default {async fetch(request,env){const stub=env.REALTIME.getByName('admin');const url=new URL(request.url);if(url.pathname==='/broadcast'){await stub.broadcast('order.paid',{test:true});return new Response('ok');}return stub.fetch(request);}};`;
  return new Miniflare(
    convertV4MiniflareOptions({
      name: 'realtime-revocation',
      compatibilityDate: '2026-10-17',
      modules: true,
      script,
      durableObjects: { REALTIME: { className: 'RealtimeDO', useSQLite: true } },
      d1Databases: ['DB'],
    })
  );
}

it('closes a socket on the next broadcast once its staff session is revoked (L9)', async () => {
  const mf = await realtimeHarness();
  try {
    const db = await seedStaffSession(mf);
    const response = await mf.dispatchFetch('http://local/ws?topics=order', {
      headers: { Upgrade: 'websocket', 'x-staff-session-id': 'sess-1' },
    });
    const socket = response.webSocket!;
    socket.accept();
    const messages: string[] = [];
    socket.addEventListener('message', (e) => messages.push(String(e.data)));
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener('close', (e) => resolve(e.code))
    );
    await mf.dispatchFetch('http://local/broadcast');
    await new Promise((r) => setTimeout(r, 200));
    expect(messages).toHaveLength(1);
    await db.prepare("DELETE FROM session WHERE id='sess-1'").run();
    await mf.dispatchFetch('http://local/broadcast');
    const code = await Promise.race([
      closed,
      new Promise<string>((r) => setTimeout(() => r('still open'), 20_000)),
    ]);
    expect(code).toBe(1008);
    expect(messages).toHaveLength(1);
  } finally {
    await mf.dispose();
  }
}, 60_000);

it('keeps a real WebSocket subscription across a workerd Durable Object eviction and constructor restart', async () => {
  const bundle = await build({
    entryPoints: [resolve('web/src/do/realtime.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:workers'],
  });
  const script =
    bundle.outputFiles[0]!.text +
    `
    export class RestartableRealtime extends RealtimeDO {
      constructor(ctx,env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{await ctx.storage.put('boots',(await ctx.storage.get('boots') ?? 0)+1);});}
      async boots(){return await this.ctx.storage.get('boots');}
    }
    export default {async fetch(request,env){const stub=env.REALTIME.getByName('admin');const url=new URL(request.url);if(url.pathname==='/boots')return Response.json(await stub.boots());if(url.pathname==='/broadcast'){await stub.broadcast('order.paid',{test:true});return new Response('ok');}return stub.fetch(request);}};`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'realtime-restart',
      compatibilityDate: '2026-10-17',
      modules: true,
      script,
      durableObjects: { REALTIME: { className: 'RestartableRealtime', useSQLite: true } },
      d1Databases: ['DB'],
    })
  );
  try {
    await seedStaffSession(mf);
    const response = await mf.dispatchFetch('http://local/ws?topics=order', {
      headers: { Upgrade: 'websocket', 'x-staff-session-id': 'sess-1' },
    });
    const socket = response.webSocket!;
    socket.accept();
    const next = () =>
      new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No WebSocket delivery')), 5000);
        socket.addEventListener(
          'message',
          (e) => {
            clearTimeout(timeout);
            resolve(String(e.data));
          },
          { once: true }
        );
      });
    const first = next();
    await mf.dispatchFetch('http://local/broadcast');
    expect(JSON.parse(await first).type).toBe('order.paid');
    expect(await (await mf.dispatchFetch('http://local/boots')).json()).toBe(1);
    await mf.unsafeEvictDurableObject('realtime-restart', 'RestartableRealtime', {
      name: 'admin',
      webSockets: 'hibernate',
    });
    const revived = next();
    await mf.dispatchFetch('http://local/broadcast');
    expect(JSON.parse(await revived).type).toBe('order.paid');
    expect(await (await mf.dispatchFetch('http://local/boots')).json()).toBe(2);
    socket.close();
  } finally {
    await mf.dispose();
  }
}, 60_000);
