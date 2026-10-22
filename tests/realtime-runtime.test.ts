import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../web/node_modules/miniflare/dist/src/index.js';

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
    })
  );
  try {
    const response = await mf.dispatchFetch('http://local/ws?topics=order', {
      headers: { Upgrade: 'websocket' },
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
