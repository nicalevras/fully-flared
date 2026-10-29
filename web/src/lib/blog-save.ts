import { resolveScheduledIso, slugify, type LoadedSchedule } from './format';

export type BlogActionResult = { ok: boolean; error?: string; data?: unknown };
export type BlogAction = (
  action: string,
  payload: Record<string, string>
) => Promise<BlogActionResult>;

export type BlogPostForm = {
  updatedAt?: string;
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  contentHtml: string;
  contentJson: string;
  status: string;
  seoTitle: string;
  seoDescription: string;
  tags: string;
  coverMediaId: string;
  publishedAt: string;
};

/** The blog editor's save flow. A scheduled post with a blank/invalid
 * date fails here without calling the action; an unchanged scheduled
 * value sends the originally stored ISO (see resolveScheduledIso). */
export async function saveBlogPost(
  action: BlogAction,
  form: BlogPostForm,
  loaded?: LoadedSchedule | null
): Promise<
  | { ok: true; created: boolean; postId: string; updatedAt?: string | undefined }
  | { ok: false; error: string }
> {
  const scheduled = resolveScheduledIso(form.status, form.publishedAt, loaded);
  if (!scheduled.ok) return { ok: false, error: scheduled.error };
  const result = await action('post.save', {
    ...(form.updatedAt ? { expectedUpdatedAt: form.updatedAt } : {}),
    id: form.id,
    slug: form.slug || slugify(form.title),
    title: form.title,
    excerpt: form.excerpt,
    contentHtml: form.contentHtml,
    contentJson: form.contentJson,
    status: form.status,
    seoTitle: form.seoTitle,
    seoDescription: form.seoDescription,
    tags: form.tags,
    coverMediaId: form.coverMediaId,
    publishedAt: scheduled.iso,
  });
  if (!result.ok) return { ok: false, error: result.error ?? 'Save failed' };
  const data = result.data as { postId?: unknown; updatedAt?: unknown } | undefined;
  return {
    ok: true,
    created: !form.id,
    postId: typeof data?.postId === 'string' ? data.postId : form.id,
    updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : form.updatedAt,
  };
}

/** Run an editor save with saving-state bookkeeping that cannot wedge:
 * the saving flag clears in finally even when the save rejects. */
export async function runEditorSave(args: {
  onSave: () => Promise<void>;
  setSaving: (saving: boolean) => void;
}): Promise<void> {
  args.setSaving(true);
  try {
    await args.onSave();
  } finally {
    args.setSaving(false);
  }
}
