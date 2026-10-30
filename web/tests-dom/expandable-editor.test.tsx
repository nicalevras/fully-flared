// @vitest-environment happy-dom
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

vi.mock('@/components/BlogEditor', () => ({
  BlogEditor: function DraftField() {
    const [text, setText] = useState('');
    return <input aria-label="Draft" value={text} onChange={(e) => setText(e.target.value)} />;
  },
}));

const { ExpandableEditor } = await import('@/components/ExpandableEditor');

function renderEditor() {
  return render(
    <ExpandableEditor
      label="Body"
      editorKey="post-1"
      initialHtml=""
      onChange={() => {}}
      onUploadPendingChange={() => {}}
    />
  );
}

it('expanding moves the one mounted editor into the dialog and Done moves it back', async () => {
  const user = userEvent.setup();
  renderEditor();
  await user.type(await screen.findByRole('textbox', { name: 'Draft' }), 'hello');

  await user.click(screen.getByRole('button', { name: 'Expand' }));
  const dialog = await screen.findByRole('dialog', { name: 'Body' });
  expect(within(dialog).getByRole('textbox', { name: 'Draft' })).toHaveProperty('value', 'hello');
  expect(screen.getAllByRole('textbox', { name: 'Draft' })).toHaveLength(1);

  await user.click(within(dialog).getByRole('button', { name: 'Done' }));
  const inline = screen.getByRole('textbox', { name: 'Draft' });
  expect(inline.closest('[role="dialog"]')).toBeNull();
  expect(inline).toHaveProperty('value', 'hello');
});

it('unmounting removes the editor host from the page', async () => {
  const { unmount } = renderEditor();
  await screen.findByRole('textbox', { name: 'Draft' });
  unmount();
  expect(document.querySelector('input[aria-label="Draft"]')).toBeNull();
});
