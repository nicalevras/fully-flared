import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDb } from './helpers/d1';
import { webp } from './helpers/image-fixtures';
import { Route } from '../web/src/routes/api/media';

const actor = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('../web/src/server/session', async (original) => ({
  ...(await original<typeof import('../web/src/server/session')>()),
  requireStaff: async () => ({ id: 'staff', role: actor.role }),
}));
let db: D1Database, dispose: () => Promise<void>;
const put = vi.fn();
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  env.DB = db;
  env.MEDIA = { put };
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,alt_text,created_at) VALUES('original','original.webp','original.webp','image/webp','','2026-01-01')"
    )
    .run();
});
afterAll(async () => {
  delete env.DB;
  delete env.MEDIA;
  await dispose();
});
async function upload(
  role: string,
  original?: string,
  width = '640',
  png = false,
  supplied?: { bytes: Uint8Array; type: string }
) {
  actor.role = role;
  put.mockClear();
  const body = new FormData();
  const bytes = png ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) : webp();
  body.set(
    'file',
    new File([supplied?.bytes ?? bytes], png ? 'file.png' : 'file.webp', {
      type: supplied?.type ?? (png ? 'image/png' : 'image/webp'),
    })
  );
  if (original !== undefined) {
    body.set('variant_of', original);
    body.set('variant_width', width);
  }
  const handlers = Route.options.server!.handlers;
  if (typeof handlers === 'function') throw new Error('Expected direct route handlers');
  const handler = handlers!.POST;
  if (typeof handler !== 'function') throw new Error('Expected POST handler');
  return handler({
    request: new Request('http://localhost:8799/api/media', { method: 'POST', body }),
  } as never) as Promise<Response>;
}
it('denies support and warehouse original and variant writes', async () => {
  for (const role of ['support', 'warehouse'])
    for (const original of [undefined, 'original.webp']) {
      expect((await upload(role, original)).status).toBe(403);
      expect(put).not.toHaveBeenCalled();
    }
});
it('rejects missing originals, invalid widths, empty references and disallowed types', async () => {
  for (const args of [
    ['missing.jpg', '640', false],
    ['original.webp', '999', false],
    ['', '640', false],
    ['original.webp', '640', true],
  ] as const) {
    expect((await upload('manager', ...args)).status).toBeGreaterThanOrEqual(400);
    expect(put).not.toHaveBeenCalled();
  }
});
it('rejects a WebP variant whose format differs from the original', async () => {
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES('logo','logo.svg','logo.svg','image/svg+xml','2026')"
    )
    .run();
  const response = await upload('manager', 'logo.svg');
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'Variant format must match the original',
  });
  expect(put).not.toHaveBeenCalled();
});
it('allows owner, legacy admin and manager uploads with database-derived variant keys', async () => {
  for (const role of ['owner', 'admin', 'manager']) {
    const response = await upload(role, 'original.webp');
    expect(response.status).toBe(200);
    expect(put.mock.calls[0]?.[0]).toMatch(/^original\.w640\.[a-f0-9]{16}\.webp$/);
  }
  expect((await upload('manager')).status).toBe(200);
  expect(put.mock.calls[0]?.[0]).toMatch(/^[a-f0-9-]+\.webp$/);
});
it('rejects pending originals and removes responsive writes that lose the deletion race', async () => {
  const remove = vi.fn(async () => undefined);
  env.MEDIA = { put, delete: remove };
  await db.prepare("UPDATE media SET deletion_pending=1 WHERE id='original'").run();
  expect((await upload('manager', 'original.webp')).status).toBe(404);
  expect(put).not.toHaveBeenCalled();
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES('late','late.webp','late.webp','image/webp','2026')"
    )
    .run();
  put.mockImplementationOnce(async () => {
    await db.prepare("UPDATE media SET deletion_pending=1 WHERE id='late'").run();
  });
  expect((await upload('manager', 'late.webp')).status).toBe(409);
  expect(remove).toHaveBeenCalledWith(expect.stringMatching(/^late\.w640\.[a-f0-9]{16}\.webp$/));
});

it('rejects mislabeled, malformed and animated bytes before any storage writes', async () => {
  for (const input of [
    { bytes: webp(640, 480, true), type: 'image/webp' },
    { bytes: new TextEncoder().encode('GIF89a'), type: 'image/webp' },
    { bytes: webp(12000, 100), type: 'image/webp' },
    { bytes: new TextEncoder().encode('<svg><'), type: 'image/svg+xml' },
  ]) {
    expect((await upload('manager', undefined, '640', false, input)).status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  }
});
