import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from '../web/node_modules/esbuild/lib/main.js';
import {
  Miniflare,
  convertV4MiniflareOptions,
} from '../web/node_modules/miniflare/dist/src/index.js';

let mf: Miniflare;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import {sanitizeStaticSvg} from './web/src/server/svg.ts'; export default {async fetch(request) {try {return new Response(await sanitizeStaticSvg(new Uint8Array(await request.arrayBuffer())),{headers:{'Content-Type':'image/svg+xml'}})}catch(error){return new Response(error.message,{status:400})}}}`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    plugins: [
      {
        name: 'wasm',
        setup(build) {
          build.onResolve({ filter: /\.wasm$/ }, () => ({
            path: './sanitizer.wasm',
            external: true,
          }));
        },
      },
    ],
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-10-16',
      compatibilityFlags: ['nodejs_compat'],
      modules: [
        { type: 'ESModule', path: resolve('svg-test.js'), contents: bundle.outputFiles[0]!.text },
        {
          type: 'CompiledWasm',
          path: resolve('sanitizer.wasm'),
          contents: readFileSync(
            'web/node_modules/@zeropress/svg-hush/dist/zeropress_svg_hush_bg.wasm'
          ),
        },
      ],
    })
  );
});
afterAll(async () => mf?.dispose());
const svg = (content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">${content}</svg>`;
const sanitize = (value: string) =>
  mf.dispatchFetch('http://localhost/', { method: 'POST', body: value });
it('runs the exact installed sanitizer in Workerd and retains a realistic static logo', async () => {
  const response = await sanitize(
    svg(
      '<defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><clipPath id="c"><rect width="200" height="100"/></clipPath><mask id="m"><rect width="240" height="120" fill="white"/></mask></defs><style>.logo {fill:url(#g)}</style><rect class="logo" width="240" height="120" clip-path="url(#c)" mask="url(#m)"/><text x="10" y="30">Fully Flared</text>'
    )
  );
  expect(response.status).toBe(200);
  const result = await response.text();
  for (const token of ['linearGradient', 'clipPath', 'mask', 'Fully Flared'])
    expect(result).toContain(token);
});
it('removes active content and rejects malformed SVG', async () => {
  const response = await sanitize(
    svg('<script>alert(1)</script><rect width="20" height="20" onclick="alert(1)"/>')
  );
  expect(response.status).toBe(200);
  expect(await response.text()).not.toMatch(/<script|onclick/i);
  expect((await sanitize('<svg><')).status).toBe(400);
});
it('rejects SMIL, CSS animations, escaped names, transitions and embedded GIFs', async () => {
  for (const content of [
    '<animate attributeName="x"/>',
    '<style>@keyframes move {to {opacity:0}}</style>',
    '<style>@keyfr\\61mes move {to {opacity:0}}</style>',
    '<rect style="anim\\61tion:move 1s"/>',
    '<rect style="transition:opacity 1s"/>',
    '<image href=" DATA:image/gif;base64,R0lGODlh"/>',
  ])
    expect((await sanitize(svg(content))).status, content).toBe(400);
});
