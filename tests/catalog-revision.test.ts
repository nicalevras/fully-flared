import { expect, it } from 'vitest';
import { contentRevision } from '../web/src/server/catalog-models';

function bigintReference(json: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < json.length; i++) {
    hash ^= BigInt(json.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function randomString(seed: number): string {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  const length = next() % 300;
  let out = '';
  for (let i = 0; i < length; i++) {
    const pick = next() % 4;
    if (pick === 0) out += String.fromCharCode(0xffff);
    else if (pick === 1) out += '\u{1F600}';
    else out += String.fromCharCode(next() % 0x10000);
  }
  return out;
}

it('keeps FNV-1a 64 golden vectors', () => {
  expect(contentRevision('')).toBe('cbf29ce484222325');
  expect(contentRevision('a')).toBe('af63dc4c8601ec8c');
  expect(contentRevision('foobar')).toBe('85944171f73967e8');
});

it('matches the BigInt FNV-1a 64 definition on arbitrary UTF-16 input', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const value = randomString(seed);
    expect(contentRevision(value)).toBe(bigintReference(value));
  }
  const large = JSON.stringify({ description: 'é€中'.repeat(8_000) });
  expect(contentRevision(large)).toBe(bigintReference(large));
});

it('logs the hashing time of a 25 KB document', () => {
  const doc = JSON.stringify({ description: 'x'.repeat(25_000) });
  const time = (fn: (value: string) => string) => {
    const start = performance.now();
    for (let i = 0; i < 20; i++) fn(doc);
    return (performance.now() - start) / 20;
  };
  console.warn(
    `contentRevision 25KB ms: bigint=${time(bigintReference).toFixed(3)} limbs=${time(contentRevision).toFixed(3)}`
  );
});
