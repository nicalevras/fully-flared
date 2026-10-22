/** Network abuse keys retain only the IPv6 /64, preventing address rotation. */
export function normalizeNetwork(ip: string): string {
  if (!ip.includes(':')) return ip;
  const value = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const [left = '', right = ''] = value.split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const groups = value.includes('::')
    ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b]
    : a;
  return (
    groups
      .slice(0, 4)
      .map((g) => g.padStart(4, '0'))
      .join(':') + '::/64'
  );
}
