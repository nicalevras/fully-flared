// Start the local Vite dev server first. This exercises its actual Start HTTP boundary.
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { admin } from 'better-auth/plugins';
import { toJSONAsync, fromCrossJSON } from 'seroval';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

// Optional independent transport for local Miniflare/Undici connection resets.
async function fetch(input, init) {
  if (!process.argv.includes('--curl')) return globalThis.fetch(input, init);
  const request = new Request(input, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const args = ['--silent', '--show-error', '--include', '--request', request.method];
  for (const [name, value] of request.headers) args.push('--header', `${name}: ${value}`);
  if (body) args.push('--data-binary', '@-');
  const raw = execFileSync(
    process.platform === 'win32' ? 'curl.exe' : 'curl',
    [...args, request.url],
    {
      input: body,
      timeout: 30_000,
    }
  );
  const boundary = raw.indexOf('\r\n\r\n');
  assert.ok(boundary >= 0, 'HTTP headers available');
  const [status, ...lines] = raw.subarray(0, boundary).toString().split('\r\n');
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  return new Response(raw.subarray(boundary + 4), {
    status: Number(status.split(' ')[1]),
    headers,
  });
}

const base = process.argv[2] ?? 'http://localhost:8799';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw new Error('HTTP smoke verification is local-only');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = join(
  process.env.STORE_HTTP_STATE ?? join(root, '.wrangler/state'),
  'v3/d1/miniflare-D1DatabaseObject'
);
const files = readdirSync(state).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
assert.equal(files.length, 1);
const db = new DatabaseSync(join(state, files[0]));
db.exec('PRAGMA foreign_keys=ON');
// The fixture owner must be removable without weakening the last-owner guards.
assert.ok(
  db.prepare("SELECT id FROM user WHERE role IN ('owner','admin') AND banned=0 LIMIT 1").get(),
  'Bootstrap an owner before this smoke check, or use disposable state with a fixture owner'
);
const fixtureIp =
  '2001:db8:' + randomBytes(2).toString('hex') + ':' + randomBytes(2).toString('hex') + '::1';
const prefix = `smoke-${randomUUID()}`;
const originalName = db.prepare("SELECT value FROM settings WHERE key='store_name'").get();
const originalLimit = db.prepare("SELECT value FROM settings WHERE key='cart_max_qty'").get();
async function idFor(path, name) {
  if (process.argv.includes('--preview')) {
    const assets = join(root, 'dist/server/assets');
    for (const file of readdirSync(assets).filter((file) => file.endsWith('.js'))) {
      const source = readFileSync(join(assets, file), 'utf8');
      const match = source.match(
        new RegExp(`id: "([^"]+)",\\s*name: "${name}",\\s*filename: "${path.slice(1)}"`)
      );
      if (match) return match[1];
    }
    assert.fail(`Built server function ${name} available`);
  }
  const source = await (await fetch(base + path)).text();
  const match = source.match(
    new RegExp(`(?:export )?const ${name} = [\\s\\S]*?createClientRpc\\("([^"]+)"\\)`)
  );
  assert.ok(match, `Compiled server function ${name} available`);
  return match[1];
}
async function rpc(id, data, { cookie = '', method = 'POST' } = {}) {
  const payload = JSON.stringify(await toJSONAsync({ data }));
  const url =
    base + '/_serverFn/' + id + (method === 'GET' ? '?payload=' + encodeURIComponent(payload) : '');
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tsr-serverfn': 'true',
      origin: base,
      'CF-Connecting-IP': fixtureIp,
      ...(cookie ? { cookie } : {}),
    },
    ...(method === 'POST' ? { body: payload } : {}),
  });
  const raw = await response.text();
  let value;
  try {
    value = fromCrossJSON(JSON.parse(raw), { refs: new Map() });
  } catch {
    value = raw;
  }
  return {
    response,
    value: value && typeof value === 'object' && 'result' in value ? value.result : value,
  };
}
try {
  for (const path of ['/', '/shop', '/collections', '/?page=1', '/shop?page=1'])
    for (const headers of [{ accept: 'text/html' }, {}]) {
      const response = await fetch(base + path, { headers, redirect: 'manual' });
      assert.equal(response.status, 200, `${path} renders in place`);
      assert.equal(response.headers.get('location'), null);
      await response.body?.cancel();
    }
  const shopPage = await (await fetch(base + '/shop?page=2', { redirect: 'manual' })).text();
  assert.match(shopPage, /<link rel="canonical" href="[^"]*\/shop\?page=2"/);
  const missing = [];
  for (let i = 0; i <= 30; i++)
    missing.push(
      (
        await fetch(`${base}/products/${prefix}-missing-${i}`, {
          headers: { accept: 'text/html', 'CF-Connecting-IP': fixtureIp },
        })
      ).status
    );
  assert.deepEqual([...new Set(missing.slice(0, 30))], [404]);
  assert.equal(missing[30], 429);
  console.log(
    'PASS storefront actual HTTP: /, /shop, /collections and page-1 URLs render without redirects, /shop?page=2 is canonical, the 31st unknown product per network is 429.'
  );
  const adminId = await idFor('/src/lib/adminFns.ts', 'adminActionFn');
  const getOrderId = await idFor('/src/routes/checkout/success.tsx', 'getOrder');
  const anonymous = await rpc(adminId, {
    action: 'settings.set',
    payload: { key: 'store_name', value: 'Should not write' },
  });
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.response.headers.get('cdn-cache-control'), 'no-store');
  const returnId = await idFor('/src/lib/shopFns.ts', 'createReturnFn');
  const accountId = await idFor('/src/lib/shopFns.ts', 'accountActionFn');
  const cartId = await idFor('/src/lib/cartFns.ts', 'addCartLineFn');
  for (const [functionId, data] of [
    [
      returnId,
      { orderId: 'missing', reason: 'Test return', items: [{ orderItemId: 'missing', qty: 1 }] },
    ],
    [accountId, { action: 'address.delete', addressId: 'missing' }],
  ])
    assert.equal((await rpc(functionId, data)).response.status, 401);
  assert.equal((await rpc(cartId, { sku: 'TEE-1', qty: 0 })).response.status, 400);
  const navigation = await fetch(base + '/admin', {
    redirect: 'manual',
    headers: { accept: 'text/html' },
  });
  assert.ok([302, 307].includes(navigation.status));
  assert.ok(navigation.headers.get('location')?.includes('/auth/sign-in'));
  const cookies = {};
  for (const role of ['customer', 'support', 'warehouse', 'owner']) {
    const id = prefix + '-' + role,
      email = id + '@example.invalid';
    const password = randomUUID() + randomUUID();
    db.prepare(
      'INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES(?,?,?,1,?,?,?)'
    ).run(id, 'HTTP fixture', email, role, Date.now(), Date.now());
    db.prepare(
      "INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,'credential',?,?,?,?)"
    ).run(id, id, id, await hashPassword(password), Date.now(), Date.now());
    const login = await fetch(base + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'CF-Connecting-IP': fixtureIp },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.status, 200, `Sign-in succeeds for ${role}`);
    if (role === 'owner' && !process.env.STORE_HTTP_STATE) {
      const output = execFileSync(
        process.execPath,
        [join(root, 'scripts/bootstrap-owner.mjs'), base],
        {
          cwd: tmpdir(),
          env: {
            ...process.env,
            OWNER_EMAIL: email,
            OWNER_PASSWORD: password,
            WRANGLER_REMOTE: '0',
          },
          encoding: 'utf8',
          timeout: 30_000,
        }
      );
      assert.ok(output.includes('Owner already exists'));
    }
    cookies[role] = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join(';');
    assert.ok(cookies[role]);
    if (role === 'owner' || role === 'support') {
      for (const endpoint of Object.values(admin().endpoints)) {
        const method = [endpoint.options.method].flat().includes('GET') ? 'GET' : 'POST';
        const response = await fetch(base + '/api/auth' + endpoint.path, {
          method,
          headers: {
            cookie: cookies[role],
            origin: base,
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            'CF-Connecting-IP': fixtureIp,
          },
          ...(method === 'POST'
            ? { body: JSON.stringify({ userId: 'missing', role: 'owner' }) }
            : {}),
        });
        const body = await response.text();
        assert.equal(response.status, 404, `${role}: disabled ${endpoint.path}: ${body}`);
      }
    }
    if (role === 'customer') continue;
    const gate = await rpc(
      adminId,
      { action: 'settings.set', payload: { key: 'store_name', value: 'Blocked by 2FA' } },
      { cookie: cookies[role] }
    );
    assert.equal(gate.response.status, 403, JSON.stringify(gate.value));
    db.prepare('UPDATE user SET two_factor_enabled=1 WHERE id=?').run(id);
    const sessions = db.prepare('SELECT token FROM session WHERE user_id=?').all(id);
    for (const session of sessions)
      db.prepare('INSERT INTO staff_two_factor_sessions VALUES(?,?,?)').run(
        createHash('sha256').update(session.token).digest('hex'),
        id,
        new Date().toISOString()
      );
  }
  const directoryId = await idFor('/src/routes/admin/customers.tsx', 'getData');
  assert.equal(
    (await rpc(directoryId, { page: 1 }, { cookie: cookies.warehouse, method: 'GET' })).response
      .status,
    403
  );
  assert.equal(
    (await rpc(directoryId, { page: 1 }, { cookie: cookies.support, method: 'GET' })).response
      .status,
    200
  );
  const image = new Uint8Array([255, 216, 255, 0]);
  function mediaForm(original) {
    const form = new FormData();
    form.set('file', new File([image], 'http.jpg', { type: 'image/jpeg' }));
    if (original) {
      form.set('variant_of', original);
      form.set('variant_width', '640');
    }
    return form;
  }
  for (const role of ['support', 'warehouse']) {
    const rejected = await fetch(base + '/api/media', {
      method: 'POST',
      headers: { cookie: cookies[role], origin: base },
      body: mediaForm(),
    });
    assert.equal(rejected.status, 403);
  }
  const original = await fetch(base + '/api/media', {
    method: 'POST',
    headers: { cookie: cookies.owner, origin: base },
    body: mediaForm(),
  });
  assert.equal(original.status, 200);
  const uploaded = await original.json();
  const variant = await fetch(base + '/api/media', {
    method: 'POST',
    headers: { cookie: cookies.owner, origin: base },
    body: mediaForm(uploaded.key),
  });
  assert.equal(variant.status, 200);
  const removed = await rpc(
    adminId,
    { action: 'media.delete', payload: { mediaId: uploaded.id } },
    { cookie: cookies.owner }
  );
  assert.equal(removed.value.ok, true);
  const customer = await rpc(
    adminId,
    { action: 'settings.set', payload: { key: 'store_name', value: 'Blocked' } },
    { cookie: cookies.customer }
  );
  assert.equal(customer.response.status, 403);
  const support = await rpc(
    adminId,
    { action: 'order.refund', payload: { orderId: 'does-not-exist', requestId: randomUUID() } },
    { cookie: cookies.support }
  );
  assert.equal(support.response.status, 403);
  assert.equal(support.value.ok, false);
  const invalid = await rpc(
    adminId,
    { action: 'settings.set', payload: { key: 'currency', value: 'INVALID' } },
    { cookie: cookies.owner }
  );
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.value.ok, false);
  const invalidEnvelope = await rpc(
    adminId,
    { action: '', payload: {} },
    { cookie: cookies.owner }
  );
  assert.equal(invalidEnvelope.response.status, 400);
  const allowed = await rpc(
    adminId,
    {
      action: 'settings.set',
      payload: { key: 'store_name', value: originalName?.value ?? 'My Store' },
    },
    { cookie: cookies.owner }
  );
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.value.ok, true);
  const customLimit = await rpc(
    adminId,
    { action: 'settings.set', payload: { key: 'cart_max_qty', value: '120' } },
    { cookie: cookies.owner }
  );
  assert.equal(customLimit.response.status, 200);
  assert.equal(customLimit.value.ok, true);
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key='cart_max_qty'").get().value,
    '120'
  );
  for (const value of ['0', '1000']) {
    const rejectedLimit = await rpc(
      adminId,
      { action: 'settings.set', payload: { key: 'cart_max_qty', value } },
      { cookie: cookies.owner }
    );
    assert.equal(rejectedLimit.response.status, 400);
    assert.equal(rejectedLimit.value.ok, false);
  }
  const orderId = prefix + '-order';
  const currentCurrency =
    db.prepare("SELECT value FROM settings WHERE key='currency'").get()?.value ?? 'USD';
  db.prepare(
    'INSERT INTO orders(id,number,customer_email,currency,subtotal_cents,total_cents,created_at,updated_at) VALUES(?,?,?, ?,100,100,?,?)'
  ).run(
    prefix + '-pending',
    prefix + '-pending',
    'pending@example.invalid',
    currentCurrency,
    new Date().toISOString(),
    new Date().toISOString()
  );
  const currencyChange = await rpc(
    adminId,
    {
      action: 'settings.set',
      payload: { key: 'currency', value: currentCurrency === 'USD' ? 'EUR' : 'USD' },
    },
    { cookie: cookies.owner }
  );
  assert.equal(currencyChange.response.status, 409);
  assert.equal(
    db.prepare("SELECT value FROM settings WHERE key='currency'").get()?.value ?? 'USD',
    currentCurrency
  );
  db.prepare('DELETE FROM orders WHERE id=?').run(prefix + '-pending');
  const badCoupon = await rpc(
    adminId,
    { action: 'discount.create', payload: { code: prefix, type: 'percentage', value: 101 } },
    { cookie: cookies.owner }
  );
  assert.equal(badCoupon.response.status, 400);
  assert.equal(
    db.prepare('SELECT id FROM discounts WHERE code=?').get(prefix.toUpperCase()),
    undefined
  );
  db.prepare(
    "INSERT INTO orders(id,number,status,payment_status,customer_email,user_id,subtotal_cents,total_cents,created_at,updated_at) VALUES(?,?,'paid','paid','private@example.invalid',?,100,100,?,?)"
  ).run(orderId, prefix, prefix + '-owner', new Date().toISOString(), new Date().toISOString());
  const notOwned = await rpc(
    getOrderId,
    { orderId, token: '' },
    { cookie: cookies.customer, method: 'GET' }
  );
  assert.equal(notOwned.value, null);
  const owned = await rpc(
    getOrderId,
    { orderId, token: '' },
    { cookie: cookies.owner, method: 'GET' }
  );
  assert.equal(owned.value.number, prefix);
  db.prepare(
    "INSERT INTO addresses(id,user_id,name,line1,city,postal_code,country) VALUES(?,?,'Fixture','Private street','City','123','US')"
  ).run(prefix + '-address', prefix + '-owner');
  db.prepare('INSERT INTO returns(id,order_id,user_id,created_at) VALUES(?,?,?,?)').run(
    prefix + '-return',
    orderId,
    prefix + '-owner',
    new Date().toISOString()
  );
  const deletion = await fetch(base + '/api/auth/delete-user', {
    method: 'POST',
    headers: {
      cookie: cookies.owner,
      origin: base,
      'content-type': 'application/json',
      'CF-Connecting-IP': fixtureIp,
    },
    body: '{}',
  });
  assert.equal(deletion.status, 403);
  assert.equal(
    db.prepare('SELECT customer_email FROM orders WHERE id=?').get(orderId).customer_email,
    'private@example.invalid'
  );
  assert.ok(db.prepare('SELECT id FROM addresses WHERE id=?').get(prefix + '-address'));
  assert.ok(db.prepare('SELECT id FROM returns WHERE id=?').get(prefix + '-return'));
  db.prepare(
    "INSERT INTO refunds(id,request_id,order_id,return_id,purpose,amount_cents,status,created_at) VALUES(?,?,?,?, 'return',100,'uncertain',?)"
  ).run(
    prefix + '-refund',
    prefix + '-refund',
    orderId,
    prefix + '-return',
    new Date().toISOString()
  );
  for (const action of ['return.reject', 'return.approve']) {
    const decision = await rpc(
      adminId,
      { action, payload: { returnId: prefix + '-return', refund: false } },
      { cookie: cookies.owner }
    );
    assert.equal(decision.response.status, 409);
    assert.equal(
      db.prepare('SELECT status FROM returns WHERE id=?').get(prefix + '-return').status,
      'requested'
    );
  }
  db.prepare(
    "INSERT INTO orders(id,number,status,payment_status,customer_email,currency,subtotal_cents,total_cents,created_at,updated_at) VALUES(?,?,'paid','paid','free@example.invalid',?,0,0,?,?)"
  ).run(
    prefix + '-free',
    prefix + '-free',
    currentCurrency,
    new Date().toISOString(),
    new Date().toISOString()
  );
  db.prepare('INSERT INTO returns(id,order_id,created_at) VALUES(?,?,?)').run(
    prefix + '-free-return',
    prefix + '-free',
    new Date().toISOString()
  );
  const freeApproval = await rpc(
    adminId,
    { action: 'return.approve', payload: { returnId: prefix + '-free-return' } },
    { cookie: cookies.support }
  );
  assert.equal(freeApproval.response.status, 200);
  assert.equal(
    db.prepare('SELECT status FROM returns WHERE id=?').get(prefix + '-free-return').status,
    'approved'
  );
  assert.equal(
    db.prepare('SELECT id FROM refunds WHERE order_id=?').get(prefix + '-free'),
    undefined
  );
  const reportEmail = prefix + '-mixed@example.invalid';
  for (const [currency, amount] of [
    ['USD', 100],
    ['EUR', 200],
  ])
    db.prepare(
      "INSERT INTO orders(id,number,status,payment_status,customer_email,currency,subtotal_cents,total_cents,created_at,updated_at) VALUES(?,?,'paid','paid',?,?,?,?,?,?)"
    ).run(
      prefix + '-report-' + currency,
      prefix + '-report-' + currency,
      reportEmail,
      currency,
      amount,
      amount,
      new Date().toISOString(),
      new Date().toISOString()
    );
  const customerReport = await fetch(base + '/api/reports?type=customers', {
    headers: { cookie: cookies.owner },
  });
  assert.equal(customerReport.status, 200);
  const reportRows = (await customerReport.json()).rows.filter(
    (row) => row.customer_email === reportEmail
  );
  assert.deepEqual(
    reportRows.map((row) => [row.currency, row.spent_cents]),
    [
      ['EUR', 200],
      ['USD', 100],
    ]
  );
  const summaryId = await idFor('/src/routes/admin/reports.tsx', 'getData');
  const summary = await rpc(summaryId, undefined, { cookie: cookies.owner, method: 'GET' });
  assert.equal(summary.response.status, 200);
  assert.ok(summary.value.revenues.some((row) => row.currency === 'USD'));
  assert.ok(summary.value.revenues.some((row) => row.currency === 'EUR'));
  assert.equal(summary.value.revenue, undefined);
  db.prepare(
    "INSERT INTO orders(id,number,status,payment_status,customer_email,user_id,currency,subtotal_cents,total_cents,created_at,updated_at) VALUES(?,?,'paid','paid',?,?,?,100,100,?,?)"
  ).run(
    prefix + '-self-order',
    prefix + '-self-order',
    prefix + '-customer@example.invalid',
    prefix + '-customer',
    currentCurrency,
    new Date().toISOString(),
    new Date().toISOString()
  );
  const selfDeletion = await rpc(
    accountId,
    { action: 'account.delete', confirmEmail: prefix + '-customer@example.invalid' },
    { cookie: cookies.customer }
  );
  assert.equal(selfDeletion.response.status, 200);
  assert.equal(selfDeletion.value.ok, true);
  assert.equal(db.prepare('SELECT id FROM user WHERE id=?').get(prefix + '-customer'), undefined);
  assert.equal(
    db.prepare('SELECT user_id FROM orders WHERE id=?').get(prefix + '-self-order').user_id,
    null
  );
  assert.equal(
    db.prepare('SELECT id FROM account WHERE user_id=?').get(prefix + '-customer'),
    undefined
  );
  const adminDeletion = await rpc(
    adminId,
    { action: 'customer.delete', payload: { userId: prefix + '-support' } },
    { cookie: cookies.owner }
  );
  assert.equal(adminDeletion.response.status, 200);
  assert.equal(adminDeletion.value.ok, true);
  assert.equal(db.prepare('SELECT id FROM user WHERE id=?').get(prefix + '-support'), undefined);
  console.log(
    'PASS follow-up actual HTTP: self-service and administrative atomic deletion, credential cascades, preserved anonymized order, and currency-separated report summaries/exports.'
  );
  console.log(
    'PASS round 2 actual HTTP: percentage validation 400, pending currency conflict 409, refund/return conflicts 409, and free return approval without refund permission or monetary refund.'
  );
  console.log(
    'PASS round 1 actual HTTP: all admin-plugin endpoints blocked before 2FA, warehouse directory denied, support directory allowed, upload permissions, original/variant uploads and protected deletion without anonymization.'
  );
  console.log(
    'PASS actual Start HTTP: 401/403 authorization, 2FA, permission, 400 validation, 200 structured result, redirect, private headers, order ownership and admin limit updates/bounds.'
  );
} finally {
  db.prepare('DELETE FROM orders WHERE id IN (?,?,?)').run(
    prefix + '-self-order',
    prefix + '-report-USD',
    prefix + '-report-EUR'
  );
  db.prepare('DELETE FROM refunds WHERE id=?').run(prefix + '-refund');
  db.prepare('DELETE FROM returns WHERE id=?').run(prefix + '-free-return');
  db.prepare('DELETE FROM orders WHERE id=?').run(prefix + '-free');
  db.prepare('DELETE FROM orders WHERE id=?').run(prefix + '-pending');
  db.prepare('DELETE FROM returns WHERE id=?').run(prefix + '-return');
  db.prepare('DELETE FROM orders WHERE id=?').run(prefix + '-order');
  db.prepare("UPDATE user SET role='customer' WHERE id LIKE ?").run(prefix + '-%');
  db.prepare('DELETE FROM user WHERE id LIKE ?').run(prefix + '-%');
  if (originalName)
    db.prepare("UPDATE settings SET value=? WHERE key='store_name'").run(originalName.value);
  else db.prepare("DELETE FROM settings WHERE key='store_name'").run();
  if (originalLimit)
    db.prepare("UPDATE settings SET value=? WHERE key='cart_max_qty'").run(originalLimit.value);
  else db.prepare("DELETE FROM settings WHERE key='cart_max_qty'").run();
  db.close();
}
