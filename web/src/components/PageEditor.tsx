import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createServerFn } from '@tanstack/react-start';
import { staffMiddleware } from '../server/staff-middleware';
import { validateServerInput } from '../server/function-boundary';
import { idString } from '../schemas/common';
import { Maximize2Icon } from 'lucide-react';
import { BlogEditor } from './BlogEditor';
import { useAdminAction } from './AdminNav';
import type { AdminActionFeedbackState } from './AdminActionFeedback';
import { ConfirmDialog } from './ConfirmDialog';
import { SeoPreview } from './SeoPreview';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { btnGhost, btnPrimary, btnSmall, inputCls, labelCls } from './ui';

type PageRow = {
  id: string;
  slug: string;
  title: string;
  content_html: string;
  seo_title: string | null;
  seo_description: string | null;
  updated_at: string;
};

export const getPageDetail = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(async ({ data: pageId }): Promise<PageRow | null> => {
    const { env } = await import('cloudflare:workers');
    const row = await env.DB.prepare(
      'SELECT id, slug, title, content_html, seo_title, seo_description, updated_at FROM pages WHERE id = ?'
    )
      .bind(pageId)
      .first<PageRow>();
    return row ?? null;
  });

export type PageDetail = PageRow;

const EMPTY = {
  updatedAt: '',
  id: '',
  slug: '',
  title: '',
  contentHtml: '',
  seoTitle: '',
  seoDescription: '',
};

export function PageEditor({
  page,
  onClose,
  onFeedback,
  onSaved,
}: {
  page: PageRow | null;
  onClose: () => void;
  onFeedback: (feedback: AdminActionFeedbackState) => void;
  onSaved: () => void;
}) {
  const [closeDiscard, setCloseDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadPending, setUploadPending] = useState(false);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  const requestClose = () => {
    if (dirty) {
      setCloseDiscard(true);
      return;
    }
    onClose();
  };
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <SheetContent
        className="w-full gap-0 overflow-hidden p-0 sm:max-w-4xl"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SheetHeader className="p-5 pr-24 pb-0 sm:p-6 sm:pr-24 sm:pb-0">
          <SheetTitle>{page ? page.title : 'New page'}</SheetTitle>
          <SheetDescription>
            {page ? `/pages/${page.slug}` : 'Write a page for the store.'}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <EditorForm
            key={page?.id ?? 'new'}
            page={page}
            saveRef={saveRef}
            onDirtyChange={setDirty}
            onUploadPendingChange={setUploadPending}
            onFeedback={onFeedback}
            onSaved={onSaved}
          />
        </div>
        {dirty ? (
          <div className="border-t border-zinc-100 bg-white px-5 py-3.5 sm:px-6">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" className={btnSmall} disabled={busy} onClick={onClose}>
                Discard
              </button>
              <button
                type="button"
                className={btnPrimary}
                disabled={busy || uploadPending}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await saveRef.current();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
            {uploadPending ? (
              <p className="mt-2 text-right text-[13px] text-zinc-500" role="status">
                Finish or remove image uploads before saving.
              </p>
            ) : null}
          </div>
        ) : null}
        <ConfirmDialog
          request={
            closeDiscard
              ? {
                  title: 'Discard unsaved changes?',
                  body: "Your changes to this page haven't been saved.",
                  confirmLabel: 'Discard changes',
                }
              : null
          }
          busy={false}
          onCancel={() => setCloseDiscard(false)}
          onConfirm={() => {
            setCloseDiscard(false);
            onClose();
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

function EditorForm({
  page,
  saveRef,
  onDirtyChange,
  onUploadPendingChange,
  onFeedback,
  onSaved,
}: {
  page: PageRow | null;
  saveRef: { current: () => Promise<void> };
  onDirtyChange: (dirty: boolean) => void;
  onUploadPendingChange: (pending: boolean) => void;
  onFeedback: (feedback: AdminActionFeedbackState) => void;
  onSaved: () => void;
}) {
  const adminAction = useAdminAction();
  const [form, setForm] = useState(() =>
    page
      ? {
          updatedAt: page.updated_at,
          id: page.id,
          slug: page.slug,
          title: page.title,
          contentHtml: page.content_html,
          seoTitle: page.seo_title ?? '',
          seoDescription: page.seo_description ?? '',
        }
      : EMPTY
  );
  const [openSections, setOpenSections] = useState<string[]>(['details']);
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
  const [contentHtml, setContentHtml] = useState(form.contentHtml);
  const initialRef = useRef(form);
  const dirty =
    JSON.stringify(form) !== JSON.stringify(initialRef.current) ||
    contentHtml !== initialRef.current.contentHtml;
  useEffect(() => {
    onDirtyChange(dirty);
  });
  saveRef.current = async () => {
    const result = await adminAction('page.save', {
      id: form.id,
      slug: form.slug,
      title: form.title,
      contentHtml,
      seoTitle: form.seoTitle,
      seoDescription: form.seoDescription,
      ...(form.updatedAt ? { expectedUpdatedAt: form.updatedAt } : {}),
    });
    if (result.ok) {
      onFeedback({ kind: 'status', message: 'Page saved. It is live on the storefront now.' });
      onSaved();
    } else onFeedback({ kind: 'error', message: result.error ?? 'Failed' });
  };

  const editorPortalTarget = editorDialogOpen ? dialogSlot : inlineSlot;
  return (
    <>
      <Accordion type="multiple" value={openSections} onValueChange={setOpenSections}>
        <AccordionItem value="details">
          <AccordionTrigger>Details</AccordionTrigger>
          <AccordionContent>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className={labelCls} htmlFor="pg-title">
                  Title
                </label>
                <input
                  id="pg-title"
                  placeholder="Page title"
                  className={inputCls}
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="pg-slug">
                  Slug
                </label>
                <input
                  id="pg-slug"
                  placeholder="page-slug"
                  className={inputCls}
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                />
              </div>
              <div className="min-w-0">
                <div className="mb-1.5 flex items-center justify-between">
                  <div className="text-sm font-medium text-zinc-900">Content</div>
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
            </div>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="metadata">
          <AccordionTrigger>Metadata</AccordionTrigger>
          <AccordionContent>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className={labelCls} htmlFor="pg-seo-title">
                  SEO title
                </label>
                <input
                  id="pg-seo-title"
                  className={inputCls}
                  placeholder="Optional"
                  value={form.seoTitle}
                  onChange={(e) => setForm({ ...form, seoTitle: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="pg-seo-desc">
                  SEO description
                </label>
                <input
                  id="pg-seo-desc"
                  className={inputCls}
                  placeholder="Optional"
                  value={form.seoDescription}
                  onChange={(e) => setForm({ ...form, seoDescription: e.target.value })}
                />
              </div>
              <SeoPreview
                path={`/pages/${form.slug}`}
                seoTitle={form.seoTitle}
                seoDescription={form.seoDescription}
                titleFallback={form.title || 'Page title'}
                descriptionFallback=""
                emptyDescription="No description yet. Search engines will use the page content."
              />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
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
          aria-label="Content editor"
          tabIndex={-1}
          className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-white shadow-xl outline-none"
        >
          <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3">
            <div className="text-sm font-medium text-zinc-900">Content</div>
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
              key={form.id || 'new'}
              initialHtml={contentHtml}
              onChange={(html) => {
                setContentHtml(html);
              }}
              onUploadPendingChange={onUploadPendingChange}
            />,
            editorPortalTarget
          )
        : null}
    </>
  );
}
