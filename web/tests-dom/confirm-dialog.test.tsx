// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@/components/ConfirmDialog';

afterEach(cleanup);

it('confirms through the dialog', async () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      request={{ title: 'Approve return?', body: 'Refunds money', confirmLabel: 'Approve' }}
      busy={false}
      onConfirm={onConfirm}
      onCancel={() => {}}
    />
  );
  expect(await screen.findByText('Approve return?')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
