import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AdminActionFeedback } from '../web/src/components/AdminActionFeedback';

it('renders a submitted action as a neutral status without implying settlement', () => {
  const message = 'Refund submitted. Settlement is pending.';
  const html = renderToStaticMarkup(
    createElement(AdminActionFeedback, { value: { kind: 'status', message } })
  );
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-atomic="true"');
  expect(html).toContain(message);
  expect(html).toContain('bg-green-600');
  expect(html).not.toContain('bg-red-600');
});

it('announces a failed action as an error and renders nothing before an action', () => {
  const html = renderToStaticMarkup(
    createElement(AdminActionFeedback, {
      value: { kind: 'error', message: 'Refund failed' },
    })
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain('Refund failed');
  expect(html).toContain('bg-red-600');
  expect(renderToStaticMarkup(createElement(AdminActionFeedback, { value: null }))).toBe('');
});
