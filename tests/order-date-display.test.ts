import { expect, it } from 'vitest';
import { formatDate, formatDateTime } from '../web/src/lib/format';

it('shows the viewer calendar date without changing the stored UTC instant', () => {
  const instant = '2026-10-23T03:22:52.509Z';
  expect(formatDate(instant, 'America/New_York')).toBe('October 22, 2026');
  expect(formatDateTime(instant, 'America/New_York')).toContain('11:22 PM EDT');
  expect(formatDate(instant, 'UTC')).toBe('October 23, 2026');
});

it('reads legacy SQLite datetime strings in UTC before converting', () => {
  expect(formatDateTime('2026-10-23 03:22:52', 'America/New_York')).toBe(
    formatDateTime('2026-10-23T03:22:52Z', 'America/New_York')
  );
});
