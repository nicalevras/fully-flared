import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2Icon } from 'lucide-react';
import { BlogEditor } from './BlogEditor';
import { btnGhost, btnSmall } from './ui';

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
  onChange: (html: string) => void;
  onUploadPendingChange: (pending: boolean) => void;
}) {
  const [editorDialogOpen, setEditorDialogOpen] = useState(false);
  const [inlineSlot, setInlineSlot] = useState<HTMLDivElement | null>(null);
  const [dialogSlot, setDialogSlot] = useState<HTMLDivElement | null>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const dialogPanelRef = useRef<HTMLDivElement>(null);
  const closeEditorDialog = useCallback(() => {
    setEditorDialogOpen(false);
    requestAnimationFrame(() => expandButtonRef.current?.focus({ preventScroll: true }));
  }, []);
  useEffect(() => {
    if (!editorDialogOpen) return;
    dialogPanelRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeEditorDialog();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editorDialogOpen, closeEditorDialog]);

  const editorPortalTarget = editorDialogOpen ? dialogSlot : inlineSlot;
  return (
    <>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-sm font-medium text-zinc-900">{label}</p>
          <button
            ref={expandButtonRef}
            type="button"
            className={btnGhost}
            aria-haspopup="dialog"
            aria-expanded={editorDialogOpen}
            onClick={() => setEditorDialogOpen(true)}
          >
            <Maximize2Icon className="size-4" />
            Expand
          </button>
        </div>
        <div ref={setInlineSlot} />
      </div>
      <div
        className={editorDialogOpen ? 'fixed inset-0 z-50 bg-zinc-950/40 p-4 sm:p-6' : 'hidden'}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeEditorDialog();
        }}
      >
        <div
          ref={dialogPanelRef}
          role="dialog"
          aria-modal="true"
          aria-label={`${label} editor`}
          tabIndex={-1}
          className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-white shadow-xl outline-none"
        >
          <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
            <div className="text-sm font-medium text-zinc-900">{label}</div>
            <button type="button" className={btnSmall} onClick={closeEditorDialog}>
              Done
            </button>
          </div>
          <div className="min-h-0 flex-1 p-4 sm:p-5">
            <div ref={setDialogSlot} className="article-editor-dialog h-full" />
          </div>
        </div>
      </div>
      {editorPortalTarget
        ? createPortal(
            <BlogEditor
              key={editorKey}
              initialHtml={initialHtml}
              onChange={onChange}
              onUploadPendingChange={onUploadPendingChange}
            />,
            editorPortalTarget
          )
        : null}
    </>
  );
}
