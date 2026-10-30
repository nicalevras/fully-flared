// @vitest-environment happy-dom
import { render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnstileWidget } from '@/components/TurnstileWidget';

type Callbacks = { callback: (token: string) => void; 'expired-callback': () => void };
const rendered: Callbacks[] = [];
const remove = vi.fn();

vi.stubGlobal('turnstile', {
  render: (_container: HTMLElement, options: Callbacks) => {
    rendered.push(options);
    return `widget-${rendered.length}`;
  },
  reset: () => {},
  remove,
});

afterEach(() => {
  rendered.length = 0;
  remove.mockClear();
});

it('reports tokens to the latest onToken without re-rendering the widget', async () => {
  const first = vi.fn();
  const latest = vi.fn();
  const { rerender } = render(<TurnstileWidget siteKey="key" action="login" onToken={first} />);
  await waitFor(() => expect(rendered).toHaveLength(1));

  rerender(<TurnstileWidget siteKey="key" action="login" onToken={latest} />);
  rendered[0]?.callback('token-1');
  rendered[0]?.['expired-callback']();

  expect(rendered).toHaveLength(1);
  expect(first).not.toHaveBeenCalled();
  expect(latest.mock.calls).toEqual([['token-1'], ['']]);
});

it('unmounting removes the rendered widget', async () => {
  const { unmount } = render(<TurnstileWidget siteKey="key" action="login" onToken={() => {}} />);
  await waitFor(() => expect(rendered).toHaveLength(1));
  unmount();
  expect(remove).toHaveBeenCalledWith('widget-1');
});
