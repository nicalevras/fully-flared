import { SVG_CSP } from '../src/lib/image-input.ts';

const [svgUrl, accountId, bucket] = process.argv.slice(2);
if (!svgUrl || !accountId || !bucket || !process.env.CLOUDFLARE_API_TOKEN)
  throw Error(
    'Usage: CLOUDFLARE_API_TOKEN=... node scripts/verify-svg-cdn.mjs https://images.example.com/media/probe.svg ACCOUNT_ID BUCKET'
  );
const url = new URL(svgUrl);
if (url.protocol !== 'https:' || !/^\/media\/[^/]+\.svg$/.test(url.pathname) || url.search)
  throw Error('Use an HTTPS /media/*.svg URL with no query.');
const api = async (suffix) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/domains/${suffix}`,
    {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    }
  );
  const body = await response.json();
  if (!response.ok || !body.success) throw Error(`Cannot inspect bucket ${suffix} domains.`);
  return body.result;
};
const managed = await api('managed');
if (managed.enabled !== false)
  throw Error('Disable the public r2.dev endpoint before enabling public SVG.');
const custom = await api('custom');
if (!Array.isArray(custom.domains)) throw Error('Cannot inspect custom domains.');
const hosts = custom.domains.filter((domain) => domain.enabled).map((domain) => domain.domain);
if (!hosts.includes(url.hostname))
  throw Error('The requested hostname is not enabled on this bucket.');
for (const host of hosts) {
  const probe = new URL(url.pathname, `https://${host}`);
  let hit = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(probe, { redirect: 'error' });
    if (
      !response.ok ||
      response.headers.get('content-type')?.split(';')[0] !== 'image/svg+xml' ||
      response.headers.get('content-security-policy') !== SVG_CSP ||
      response.headers.get('x-content-type-options') !== 'nosniff'
    )
      throw Error(`SVG security headers failed on ${host}.`);
    await response.arrayBuffer();
    hit ||= response.headers.get('cf-cache-status') === 'HIT';
  }
  if (!hit)
    throw Error(`No verified SVG cache hit on ${host}. Check cache configuration and rerun.`);
}
console.log(
  `Verified SVG headers on ${hosts.length} public hostnames and disabled r2.dev.\nSet SVG_VERIFIED_PUBLIC_ORIGIN=${url.origin} for the matching media base URL.`
);
