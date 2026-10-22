// Better Auth + admin gate pass (requires dev server on base URL).
// Usage: node scripts/auth-admin-test.mjs [baseUrl] [email]
const base = process.argv[2] ?? 'http://localhost:8799';
const email = process.argv[3] ?? `owner-${Date.now()}@example.com`;
const password = 'TestPassword123!';

let cookie = '';
async function call(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
};

const promoted = process.argv.includes('--promoted');
const signup = promoted
  ? await call('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  : await call('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ name: 'Store Owner', email, password }),
    });
check(
  promoted ? 'sign-in/email' : 'sign-up/email',
  signup.status === 200,
  `status=${signup.status} ${signup.status !== 200 ? JSON.stringify(signup.body).slice(0, 200) : ''}`
);

const session = await call('/api/auth/get-session');
check(
  'get-session after sign-up',
  session.status === 200 && !!session.body?.user,
  `status=${session.status}`
);

if (!promoted) {
  const adminBefore = await call('/api/admin', {
    method: 'POST',
    body: JSON.stringify({ action: 'product.create', title: 'Nope', slug: 'nope', variants: [] }),
  });
  check(
    'customer blocked from admin API (403)',
    adminBefore.status === 403,
    `status=${adminBefore.status}`
  );
}

console.log(`Signed up: ${email}`);
console.log('Promote this user in D1, then rerun with --promoted:', email);
if (process.argv.includes('--promoted')) {
  const create = await call('/api/admin', {
    method: 'POST',
    body: JSON.stringify({
      action: 'product.create',
      title: 'Admin Test Product',
      slug: `admin-test-${Date.now()}`,
      status: 'active',
      description: 'Created through staff gate',
      variants: [{ sku: `TEST-${Date.now()}`, title: 'Default', priceCents: 1234, stock: 7 }],
    }),
  });
  check(
    'staff product.create',
    create.status === 200 && create.body?.ok === true,
    `status=${create.status}`
  );

  const disc = await call('/api/admin', {
    method: 'POST',
    body: JSON.stringify({
      action: 'discount.create',
      code: `TEST${Date.now() % 100000}`,
      type: 'percentage',
      value: 10,
    }),
  });
  check('staff discount.create', disc.status === 200 && disc.body?.ok === true);

  const imp = await call('/api/admin', {
    method: 'POST',
    body: JSON.stringify({
      action: 'import.productsCsv',
      csv: `title,slug,sku,price_cents,stock\nImport Tee,import-tee-${Date.now()},IMP-TEE-${Date.now()},1999,5\nBad Row,, ,0,0\n`,
    }),
  });
  check(
    'CSV import with per-row errors',
    imp.status === 200 && imp.body?.data?.imported === 1 && imp.body?.data?.errors?.length === 1,
    JSON.stringify(imp.body?.data ?? {}).slice(0, 200)
  );

  const report = await fetch(`${base}/api/reports?type=inventory&format=csv`, {
    headers: { Cookie: cookie },
  });
  const csv = await report.text();
  check(
    'inventory report CSV',
    report.status === 200 && csv.includes('sku,on_hand'),
    `status=${report.status}`
  );
}

const failed = results.filter(([, ok]) => !ok);
console.log(
  failed.length === 0
    ? 'All executed checks passed'
    : `FAILED: ${failed.map(([n]) => n).join(', ')}`
);
process.exit(failed.length ? 1 : 0);
