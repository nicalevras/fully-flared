import { Link, createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../server/function-boundary';
import { PostNotFound } from '../../components/NotFound';
import { richTextCls } from '../../lib/rich-text';
import { loadPostPage } from '../../server/storefront-pages';
import { requestCanonicalBase } from '../../server/canonical-base';
import { slugParamSchema } from '../../schemas/checkout';
import { absoluteUrl, jsonLd, seoMeta } from '../../lib/seo';
import { formatDate } from '../../lib/format';

type Post = {
  slug: string;
  title: string;
  excerpt: string;
  content_html: string;
  published_at: string;
  seo_title: string | null;
  seo_description: string | null;
  cover_key: string | null;
  cover_url: string | null;
  tags: string | null;
  author_name: string | null;
  storeName: string;
  seoTitleTemplate: string;
  canonicalBaseUrl: string;
};

const getPost = createServerFn({ method: 'GET' })
  .validator(validateServerInput(slugParamSchema))
  .handler(async ({ data: slug }): Promise<Post> => {
    const { env } = await import('cloudflare:workers');
    const { layout: settings, doc: row } = await loadPostPage(env.DB, env, slug);
    return {
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      published_at: row.publishedAt ?? '',
      seo_title: row.seoTitle,
      seo_description: row.seoDescription,
      cover_key: row.coverKey,
      cover_url: row.coverPublicUrl ?? null,
      tags: row.tags,
      author_name: row.authorName,
      content_html: row.contentHtml,
      storeName: settings.storeName,
      seoTitleTemplate: settings.seoTitleTemplate,
      canonicalBaseUrl: requestCanonicalBase(settings.canonicalBaseUrl),
    };
  });

export const Route = createFileRoute('/_shop/blog/$slug')({
  loader: async ({ params }) => getPost({ data: params.slug }),
  staleTime: 20_000,
  notFoundComponent: PostNotFound,
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: 'Store' }] };
    const url = absoluteUrl(loaderData.canonicalBaseUrl, `/blog/${loaderData.slug}`);
    return {
      meta: [
        ...seoMeta({
          title:
            loaderData.seo_title ??
            loaderData.seoTitleTemplate
              .replaceAll('{product}', loaderData.title)
              .replaceAll('{title}', loaderData.title)
              .replaceAll('{store_name}', loaderData.storeName),
          description: loaderData.seo_description ?? loaderData.excerpt,
          url,
          type: 'article',
          image: loaderData.cover_key
            ? (loaderData.cover_url ??
              absoluteUrl(loaderData.canonicalBaseUrl, `/media/${loaderData.cover_key}`))
            : undefined,
        }),
        { property: 'article:published_time', content: loaderData.published_at },
      ],
      links: [{ rel: 'canonical', href: url }],
      ...jsonLd({
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: loaderData.title,
        description: loaderData.excerpt,
        datePublished: loaderData.published_at,
        url,
        ...(loaderData.author_name
          ? { author: { '@type': 'Person', name: loaderData.author_name } }
          : {}),
      }),
    };
  },
  component: BlogPost,
});

function BlogPost() {
  const post = Route.useLoaderData();
  return (
    <main className="mx-auto max-w-3xl py-10 lg:py-14">
      <nav aria-label="Breadcrumb" className="text-[13px] text-zinc-500">
        <Link to="/blog" className="hover:text-zinc-950">
          Journal
        </Link>
        <span className="mx-1.5 text-zinc-300">/</span>
        <span className="text-zinc-950">{post.title}</span>
      </nav>
      <h1 className="mt-5 text-[38px] leading-[1.15] font-normal tracking-tight">{post.title}</h1>
      <p className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
        <time dateTime={post.published_at}>{formatDate(post.published_at)}</time>
        {post.author_name ? <span>· by {post.author_name}</span> : null}
        {post.tags ? <span>· {post.tags}</span> : null}
      </p>
      {post.cover_key ? (
        <img
          src={post.cover_url ?? `/media/${post.cover_key}`}
          alt={post.title}
          className="mt-8 aspect-[16/8] w-full rounded-2xl object-cover"
        />
      ) : null}
      {post.excerpt ? (
        <p className="mt-5 border-l-2 border-zinc-300 pl-4 text-[17px] leading-8 text-zinc-500">
          {post.excerpt}
        </p>
      ) : null}
      <article
        className={`${richTextCls} mt-6`}
        dangerouslySetInnerHTML={{ __html: post.content_html }}
      />
      <div className="mt-12 border-t border-zinc-200 pt-6">
        <Link to="/blog" className="text-sm font-medium text-zinc-950 hover:underline">
          ← Back to the journal
        </Link>
      </div>
    </main>
  );
}
