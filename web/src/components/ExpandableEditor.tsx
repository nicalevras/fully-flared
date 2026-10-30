import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '@base-ui/react/dialog';
import { Maximize2Icon } from 'lucide-react';
import { BlogEditor } from './BlogEditor';
import { btnGhost, btnSmall } from './ui';

function moveEditor(host: HTMLDivElement, slot: HTMLDivElement) {
  if (host.parentElement === slot) return;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const editorRange =
    range && host.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
  slot.appendChild(host);
  if (selection && editorRange) {
    selection.removeAllRanges();
    selection.addRange(editorRange);
  }
}

export function ExpandableEditor({
  label,
  editorKey,
  initialHtml,
  onChange,
  onUploadPendingChange,
}: {
  label: string;
  editorKey: string;
  initialHtml: string;
  onChange: (html: string, json: string) => void;
  onUploadPendingChange: (pending: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const inlineSlot = useRef<HTMLDivElement>(null);
  const [dialogSlot, setDialogSlot] = useState<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const attachInlineSlot = useCallback((slot: HTMLDivElement) => {
    inlineSlot.current = slot;
    const node = document.createElement('div');
    node.className = 'h-full';
    slot.appendChild(node);
    setHost(node);
    return () => {
      node.remove();
      inlineSlot.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const slot = open ? dialogSlot : inlineSlot.current;
    if (host && slot) moveEditor(host, slot);
  }, [host, open, dialogSlot]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && host && inlineSlot.current) moveEditor(host, inlineSlot.current);
        setOpen(next);
      }}
    >
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-sm font-medium text-zinc-900">{label}</p>
          <Dialog.Trigger className={btnGhost}>
            <Maximize2Icon className="size-4" />
            Expand
          </Dialog.Trigger>
        </div>
        <div ref={attachInlineSlot} />
      </div>
      <Dialog.Portal keepMounted>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-zinc-950/40 data-closed:hidden" />
        <Dialog.Popup
          ref={popupRef}
          initialFocus={popupRef}
          aria-label={`${label} editor`}
          className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-2xl bg-white shadow-xl outline-none data-closed:hidden sm:inset-6"
        >
          <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
            <Dialog.Title className="text-sm font-medium text-zinc-900">{label}</Dialog.Title>
            <Dialog.Close className={btnSmall}>Done</Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 p-4 sm:p-5">
            <div ref={setDialogSlot} className="article-editor-dialog h-full" />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
      {host
        ? createPortal(
            <BlogEditor
              key={editorKey}
              initialHtml={initialHtml}
              onChange={onChange}
              onUploadPendingChange={onUploadPendingChange}
            />,
            host
          )
        : null}
    </Dialog.Root>
  );
}
