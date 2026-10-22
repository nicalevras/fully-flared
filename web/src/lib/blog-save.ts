import { resolveScheduledIso, slugify, type LoadedSchedule } from './format';

export type BlogActionResult = { ok: boolean; error?: string };
export type BlogAction = (
  action: string,
  payload: Record<string, string>
) => Promise<BlogActionResult>;

export type BlogPostForm = {
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
): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const scheduled = resolveScheduledIso(form.status, form.publishedAt, loaded);
  if (!scheduled.ok) return { ok: false, error: scheduled.error };
  const result = await action('post.save', {
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
  return { ok: true, created: !form.id };
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
