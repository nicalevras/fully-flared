import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createServerFn } from '@tanstack/react-start';
import { Link } from '@tanstack/react-router';
import { EllipsisIcon, PlusIcon, XIcon } from 'lucide-react';
import { staffMiddleware } from '../server/staff-middleware';
import { requireStaffPermission } from '../server/session';
import { validateServerInput } from '../server/function-boundary';
import { idString } from '../schemas/common';
import { ExpandableEditor } from './ExpandableEditor';
import { useAdminAction } from './AdminNav';
import type { AdminActionFeedbackState } from './AdminActionFeedback';
import { ConfirmDialog } from './ConfirmDialog';
import { SeoPreview } from './SeoPreview';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Button } from './ui/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from './ui/drawer';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { slugify, utcToLocalDateTimeInput, type LoadedSchedule } from '../lib/format';
import { saveBlogPost } from '../lib/blog-save';
import { uploadMedia } from '../lib/upload';
import { mediaUrl, storedVariants } from '../lib/media-url';
import { btnPrimary, btnSmall, inputCls, labelCls, textareaCls } from './ui';

type PostRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  excerpt: string;
  content_html: string;
  content_json: string | null;
  seo_title: string | null;
  seo_description: string | null;
  published_at: string | null;
  cover_media_id: string | null;
  cover_key: string | null;
  cover_public_url: string | null;
  cover_variants_json: string | null;
  updated_at: string;
  tags: string;
};

export const getPostDetail = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .validator(validateServerInput(idString))
  .handler(async ({ data: postId, context }): Promise<PostRow | null> => {
    requireStaffPermission(context.staff, 'post', 'view');
    const { env } = await import('cloudflare:workers');
    const row = await env.DB.prepare(
      `SELECT p.id, p.slug, p.title, p.status, p.excerpt, p.content_html, p.content_json,
              p.seo_title, p.seo_description, p.published_at, p.cover_media_id, p.updated_at,
              m.r2_key AS cover_key, m.public_url AS cover_public_url,
              (SELECT json_group_array(json_object('width', width, 'url', COALESCE(public_url, '')))
               FROM (SELECT width, public_url FROM media_variants
                     WHERE media_id = m.id AND ready = 1 ORDER BY width)) AS cover_variants_json,
              COALESCE(GROUP_CONCAT(t.name, ', '), '') AS tags
       FROM posts p
       LEFT JOIN media m ON m.id = p.cover_media_id AND m.ready = 1 AND m.deletion_pending = 0
       LEFT JOIN post_tags pt ON pt.post_id = p.id
       LEFT JOIN tags t ON t.id = pt.tag_id
       WHERE p.id = ?
       GROUP BY p.id`
    )
      .bind(postId)
      .first<PostRow>();
    return row ?? null;
  });

function coverPreviewUrl(post: PostRow | null): string {
  if (!post?.cover_key) return '';
  const variants = storedVariants(post.cover_variants_json, post.cover_key);
  return mediaUrl({ key: post.cover_key, publicUrl: post.cover_public_url, variants }, 1280);
}

const EMPTY = {
  updatedAt: '',
  id: '',
  slug: '',
  title: '',
  status: 'draft',
  excerpt: '',
  contentHtml: '',
  seoTitle: '',
  seoDescription: '',
  tags: '',
  coverMediaId: '',
  publishedAt: '',
};

export type BlogPostDetail = PostRow;

export function BlogPostEditor({
  post,
  onClose,
  onFeedback,
  onSaved,
}: {
  post: PostRow | null;
  onClose: () => void;
  onFeedback: (feedback: AdminActionFeedbackState) => void;
  onSaved: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [closeDiscard, setCloseDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadPending, setUploadPending] = useState(false);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const requestClose = () => {
    if (dirty) {
      setCloseDiscard(true);
      return;
    }
    onClose();
  };
  return (
    <Drawer
      instant
      swipeDirection="right"
      open
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DrawerContent
        className="w-full max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        initialFocus={false}
      >
        <DrawerClose
          render={
            <Button type="button" variant="ghost" size="icon-sm" className="absolute top-3 right-3">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          }
        />
        <DrawerHeader className="p-5 pr-24 pb-0 sm:p-6 sm:pr-24 sm:pb-0">
          <DrawerTitle>{post ? post.title : 'New post'}</DrawerTitle>
          <DrawerDescription>
            {post ? `/articles/${post.slug} · ${post.status}` : 'Write an article for the store.'}
          </DrawerDescription>
        </DrawerHeader>
        {post && post.status === 'published' ? (
          <div className="absolute top-3 right-12 z-20">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Actions for ${post.title}`}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-950/5 hover:text-zinc-950"
            >
              <EllipsisIcon className="size-4" />
            </button>
            {menuOpen ? (
              <div
                role="menu"
                onClick={(event) => event.stopPropagation()}
                className="absolute top-full right-0 mt-1 w-44 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg"
              >
                <Link
                  role="menuitem"
                  to="/articles/$slug"
                  params={{ slug: post.slug }}
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-lg px-3 py-2 text-[13px] font-medium text-zinc-950 transition-colors hover:bg-zinc-50"
                >
                  View on storefront
                </Link>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <EditorForm
            key={post?.id ?? 'new'}
            post={post}
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
                  body: "Your changes to this post haven't been saved.",
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
      </DrawerContent>
    </Drawer>
  );
}

function EditorForm({
  post,
  saveRef,
  onDirtyChange,
  onUploadPendingChange,
  onFeedback,
  onSaved,
}: {
  post: PostRow | null;
  saveRef: { current: () => Promise<void> };
  onDirtyChange: (dirty: boolean) => void;
  onUploadPendingChange: (pending: boolean) => void;
  onFeedback: (feedback: AdminActionFeedbackState) => void;
  onSaved: () => void;
}) {
  const adminAction = useAdminAction();
  const [form, setForm] = useState(() =>
    post
      ? {
          updatedAt: post.updated_at,
          id: post.id,
          slug: post.slug,
          title: post.title,
          status: post.status,
          excerpt: post.excerpt,
          contentHtml: post.content_html,
          seoTitle: post.seo_title ?? '',
          seoDescription: post.seo_description ?? '',
          tags: post.tags,
          coverMediaId: post.cover_media_id ?? '',
          publishedAt: post.published_at ? utcToLocalDateTimeInput(post.published_at) : '',
        }
      : EMPTY
  );
  const [loadedSchedule] = useState<LoadedSchedule | null>(() =>
    post?.published_at
      ? { localValue: utcToLocalDateTimeInput(post.published_at), iso: post.published_at }
      : null
  );
  const [slugTouched, setSlugTouched] = useState(false);
  const [openSections, setOpenSections] = useState<string[]>(['details']);
  const [contentHtml, setContentHtml] = useState(form.contentHtml);
  const [contentJson, setContentJson] = useState(post?.content_json ?? '');
  const [coverUrl, setCoverUrl] = useState(() => coverPreviewUrl(post));
  const [stagedCover, setStagedCover] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    return () => {
      if (stagedCover) URL.revokeObjectURL(stagedCover.url);
    };
  }, [stagedCover]);
  const [initial] = useState(form);
  const dirty =
    JSON.stringify(form) !== JSON.stringify(initial) ||
    contentHtml !== initial.contentHtml ||
    contentJson !== (post?.content_json ?? '') ||
    stagedCover !== null;
  useEffect(() => {
    onDirtyChange(dirty);
  });
  const save = async () => {
    let coverMediaId = form.coverMediaId;
    if (stagedCover) {
      try {
        const uploaded = await uploadMedia(stagedCover.file);
        coverMediaId = uploaded.id;
        setStagedCover(null);
        setForm((f) => ({ ...f, coverMediaId: uploaded.id }));
        setCoverUrl(uploaded.url ?? mediaUrl({ key: uploaded.key }, 1280));
      } catch (err) {
        onFeedback({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Cover upload failed',
        });
        return;
      }
    }
    const result = await saveBlogPost(
      adminAction,
      { ...form, coverMediaId, contentHtml, contentJson },
      loadedSchedule
    );
    if (result.ok) {
      onFeedback({
        kind: 'status',
        message:
          form.status === 'published'
            ? 'Post saved and published. It is live on the storefront.'
            : form.status === 'scheduled'
              ? 'Post saved and scheduled.'
              : 'Post saved as a draft. It is not on the storefront.',
      });
      onSaved();
    } else onFeedback({ kind: 'error', message: result.error });
  };
  useImperativeHandle(saveRef, () => save);

  return (
    <>
      <Accordion type="multiple" value={openSections} onValueChange={setOpenSections}>
        <AccordionItem value="details">
          <AccordionTrigger>Details</AccordionTrigger>
          <AccordionContent>
            <div>
              <div className={labelCls}>Cover image</div>
              {coverUrl ? (
                <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-zinc-50">
                  <img src={coverUrl} alt="Cover" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    aria-label="Remove cover image"
                    onClick={() => {
                      setStagedCover(null);
                      setForm((f) => ({ ...f, coverMediaId: '' }));
                      setCoverUrl('');
                    }}
                    className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 transition-colors hover:text-zinc-950"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <label className="group/add block w-full cursor-pointer">
                  <span className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 rounded-xl bg-zinc-50 text-zinc-500 transition-colors group-hover/add:bg-zinc-100 group-hover/add:text-zinc-950">
                    <PlusIcon className="size-5" />
                    <span className="text-xs font-medium">Add</span>
                  </span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="sr-only"
                    aria-label="Upload cover image"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      const url = URL.createObjectURL(file);
                      setStagedCover({ file, url });
                      setCoverUrl(url);
                    }}
                  />
                </label>
              )}
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4">
              <div>
                <label className={labelCls} htmlFor="b-title">
                  Title
                </label>
                <input
                  id="b-title"
                  placeholder="Post title"
                  className={inputCls}
                  value={form.title}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      title: e.target.value,
                      slug: form.id || slugTouched ? form.slug : slugify(e.target.value),
                    })
                  }
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls} htmlFor="b-slug">
                    Slug
                  </label>
                  <input
                    id="b-slug"
                    placeholder="post-slug"
                    className={inputCls}
                    value={form.slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      setForm({ ...form, slug: e.target.value });
                    }}
                  />
                </div>
                <div>
                  <label className={labelCls} htmlFor="b-status">
                    Status
                  </label>
                  <Select
                    value={form.status}
                    onValueChange={(value) => setForm({ ...form, status: value })}
                  >
                    <SelectTrigger
                      id="b-status"
                      className="w-full rounded-lg data-[size=default]:h-10"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="published">Published</SelectItem>
                      <SelectItem value="scheduled">Scheduled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {form.status === 'scheduled' ? (
                <div>
                  <label className={labelCls} htmlFor="b-when">
                    Publish at
                  </label>
                  <input
                    id="b-when"
                    type="datetime-local"
                    className={inputCls}
                    value={form.publishedAt}
                    onChange={(e) => setForm({ ...form, publishedAt: e.target.value })}
                  />
                </div>
              ) : null}
              <ExpandableEditor
                label="Post"
                editorKey={form.id || 'new'}
                initialHtml={contentHtml}
                onChange={(html, json) => {
                  setContentHtml(html);
                  setContentJson(json);
                }}
                onUploadPendingChange={onUploadPendingChange}
              />
              <div>
                <label className={labelCls} htmlFor="b-tags">
                  Tags
                </label>
                <input
                  id="b-tags"
                  className={inputCls}
                  placeholder="care, cotton, news"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="b-excerpt">
                  Excerpt
                </label>
                <textarea
                  id="b-excerpt"
                  className={textareaCls}
                  rows={2}
                  placeholder="One or two sentences shown in listings and search results."
                  value={form.excerpt}
                  onChange={(e) => setForm({ ...form, excerpt: e.target.value })}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="metadata">
          <AccordionTrigger>Metadata</AccordionTrigger>
          <AccordionContent>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className={labelCls} htmlFor="b-seo-title">
                  SEO title
                </label>
                <input
                  id="b-seo-title"
                  className={inputCls}
                  placeholder="Optional"
                  value={form.seoTitle}
                  onChange={(e) => setForm({ ...form, seoTitle: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="b-seo-desc">
                  SEO description
                </label>
                <input
                  id="b-seo-desc"
                  className={inputCls}
                  placeholder="Optional, defaults to the excerpt"
                  value={form.seoDescription}
                  onChange={(e) => setForm({ ...form, seoDescription: e.target.value })}
                />
              </div>
              <SeoPreview
                path={`/articles/${form.slug || slugify(form.title)}`}
                seoTitle={form.seoTitle}
                seoDescription={form.seoDescription}
                titleFallback={form.title || 'Post title'}
                descriptionFallback={form.excerpt}
                emptyDescription="No description yet. Search engines will use the post content."
              />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}
