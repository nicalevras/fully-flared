// @vitest-environment happy-dom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AdminActionFeedbackState } from '@/components/AdminActionFeedback';
import { renderRoute } from './render-route';

const adminAction = vi.hoisted(() =>
  vi.fn<(action: string, payload: object) => Promise<{ ok: boolean; error?: string }>>(
    async () => ({ ok: true })
  )
);
vi.mock('@/components/AdminNav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/AdminNav')>()),
  useAdminAction: () => adminAction,
}));

const { PageEditor } = await import('@/components/PageEditor');

const page = {
  id: 'pg1',
  slug: 'about',
  title: 'About',
  content_html: '<p>Hello</p>',
  seo_title: null,
  seo_description: null,
  updated_at: '2026-10-01T00:00:00.000Z',
};

beforeEach(() => adminAction.mockClear());

async function renderEditor() {
  const onFeedback = vi.fn<(feedback: AdminActionFeedbackState) => void>();
  const onSaved = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  await renderRoute(() => (
    <PageEditor page={page} onClose={onClose} onFeedback={onFeedback} onSaved={onSaved} />
  ));
  return { onFeedback, onSaved, onClose, title: await screen.findByLabelText('Title') };
}

it('saving a page sends the version it was loaded at and reports it', async () => {
  const { onFeedback, onSaved, title } = await renderEditor();
  expect(screen.queryByRole('button', { name: 'Save changes', hidden: true })).toBeNull();

  await userEvent.type(title, ' us');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));

  expect(adminAction).toHaveBeenCalledTimes(1);
  expect(adminAction).toHaveBeenCalledWith('page.save', {
    id: 'pg1',
    slug: 'about',
    title: 'About us',
    contentHtml: '<p>Hello</p>',
    seoTitle: '',
    seoDescription: '',
    expectedUpdatedAt: '2026-10-01T00:00:00.000Z',
  });
  expect(onFeedback).toHaveBeenCalledWith({
    kind: 'status',
    message: 'Page saved. It is live on the storefront now.',
  });
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('a refused save reports the error and does not refresh', async () => {
  adminAction.mockResolvedValueOnce({ ok: false, error: 'This page changed elsewhere.' });
  const { onFeedback, onSaved, title } = await renderEditor();

  await userEvent.type(title, ' us');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes', hidden: true }));

  expect(onFeedback).toHaveBeenCalledWith({
    kind: 'error',
    message: 'This page changed elsewhere.',
  });
  expect(onSaved).not.toHaveBeenCalled();
});

it('closing with unsaved changes asks first', async () => {
  const { onClose, title } = await renderEditor();
  await userEvent.type(title, ' us');

  await userEvent.keyboard('{Escape}');
  const dialog = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
  expect(onClose).not.toHaveBeenCalled();

  await userEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(adminAction).not.toHaveBeenCalled();
});
