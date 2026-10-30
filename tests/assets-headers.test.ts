import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/** Header rules from a Workers static-assets `_headers` file: a path line, then indented `Name: value` lines. */
function headerRules(text: string): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) current?.push(line.trim());
    else rules.set(line.trim(), (current = []));
  }
  return rules;
}

it('public/_headers marks hashed /assets/* immutable for a year', () => {
  const file = new URL('../web/public/_headers', import.meta.url);
  const rules = headerRules(readFileSync(file, 'utf8'));
  expect(rules.get('/assets/*')).toContain('Cache-Control: public, max-age=31536000, immutable');
});
