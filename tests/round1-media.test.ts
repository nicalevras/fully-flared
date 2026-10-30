import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDb } from './helpers/d1';
import { Route } from '../web/src/routes/api/media';
import { present } from './helpers/fixtures';
import { noNext, routeResponse } from './helpers/route';

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
      "INSERT INTO media(id,r2_key,filename,content_type,alt_text,created_at) VALUES('original','original.jpg','original.jpg','image/jpeg','','2026-01-01')"
    )
    .run();
});
afterAll(async () => {
  delete env.DB;
  delete env.MEDIA;
  await dispose();
});
async function upload(role: string, original?: string, width = '640', png = false) {
  actor.role = role;
  put.mockClear();
  const body = new FormData();
  const bytes = png
    ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    : new Uint8Array([255, 216, 255, 0]);
  body.set(
    'file',
    new File([bytes], png ? 'file.png' : 'file.jpg', { type: png ? 'image/png' : 'image/jpeg' })
  );
  if (original !== undefined) {
    body.set('variant_of', original);
    body.set('variant_width', width);
  }
  const handlers = present(Route.options.server?.handlers, 'the media upload handlers');
  if (typeof handlers === 'function') throw new Error('Expected direct route handlers');
  const handler = present(handlers.POST, 'the media upload POST handler');
  return routeResponse(
    await handler({
      request: new Request('http://localhost:8799/api/media', { method: 'POST', body }),
      context: undefined,
      params: {},
      pathname: '/api/media',
      next: noNext,
    })
  );
}
it('denies support and warehouse original and variant writes', async () => {
  for (const role of ['support', 'warehouse'])
    for (const original of [undefined, 'original.jpg']) {
      expect((await upload(role, original)).status).toBe(403);
      expect(put).not.toHaveBeenCalled();
    }
});
it('rejects missing originals, invalid widths, empty references and mismatched formats', async () => {
  for (const [original, width, png] of [
    ['missing.jpg', '640', false],
    ['original.jpg', '999', false],
    ['', '640', false],
    ['original.jpg', '640', true],
  ] as const) {
    expect((await upload('manager', original, width, png)).status).toBeGreaterThanOrEqual(400);
    expect(put).not.toHaveBeenCalled();
  }
});
it('allows owner, legacy admin and manager uploads with database-derived variant keys', async () => {
  for (const role of ['owner', 'admin', 'manager']) {
    const response = await upload(role, 'original.jpg');
    expect(response.status).toBe(200);
    expect(put.mock.calls[0]?.[0]).toMatch(/^original\.w640\.[a-f0-9]{16}\.jpg$/);
  }
  expect((await upload('manager')).status).toBe(200);
  expect(put.mock.calls[0]?.[0]).toMatch(/^[a-f0-9-]+\.jpg$/);
});
it('rejects pending originals and removes responsive writes that lose the deletion race', async () => {
  const remove = vi.fn(async () => undefined);
  env.MEDIA = { put, delete: remove };
  await db.prepare("UPDATE media SET deletion_pending=1 WHERE id='original'").run();
  expect((await upload('manager', 'original.jpg')).status).toBe(404);
  expect(put).not.toHaveBeenCalled();
  await db
    .prepare(
      "INSERT INTO media(id,r2_key,filename,content_type,created_at) VALUES('late','late.jpg','late.jpg','image/jpeg','2026')"
    )
    .run();
  put.mockImplementationOnce(async () => {
    await db.prepare("UPDATE media SET deletion_pending=1 WHERE id='late'").run();
  });
  expect((await upload('manager', 'late.jpg')).status).toBe(409);
  expect(remove).toHaveBeenCalledWith(expect.stringMatching(/^late\.w640\.[a-f0-9]{16}\.jpg$/));
});
