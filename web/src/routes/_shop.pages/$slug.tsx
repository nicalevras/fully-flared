import { absoluteUrl, seoMeta } from '../../lib/seo';
import { type StorefrontLayoutSnapshot } from '../../server/catalog-read';
import { loadEditorialPage } from '../../server/storefront-pages';
import { withRequestCanonicalBase } from '../../server/canonical-base';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { validateServerInput } from '../../server/function-boundary';
import { PageNotFound } from '../../components/NotFound';
import { richTextCls } from '../../lib/rich-text';
import { slugParamSchema } from '../../schemas/checkout';

type Page = {
  slug: string;
  title: string;
  content_html: string;
  seo_title: string | null;
  seo_description: string | null;
};

const getPage = createServerFn({ method: 'GET' })
  .validator(validateServerInput(slugParamSchema))
  .handler(async ({ data: slug }): Promise<Page & { layout: StorefrontLayoutSnapshot }> => {
    const { env } = await import('cloudflare:workers');
    const { layout, doc: row } = await loadEditorialPage(env.DB, env, slug);
    return {
      slug: row.slug,
      title: row.title,
      seo_title: row.seoTitle,
      seo_description: row.seoDescription,
      layout: withRequestCanonicalBase(layout),
      content_html: row.contentHtml,
    };
  });

export const Route = createFileRoute('/_shop/pages/$slug')({
  loader: async ({ params }) => getPage({ data: params.slug }),
  notFoundComponent: PageNotFound,
  head: ({ loaderData }) => ({
    meta: loaderData
      ? seoMeta({
          title: loaderData.seo_title || `${loaderData.title} · ${loaderData.layout.storeName}`,
          description: loaderData.seo_description || '',
          url: absoluteUrl(loaderData.layout.canonicalBaseUrl, `/pages/${loaderData.slug}`),
        })
      : [],
    links: loaderData
      ? [
          {
            rel: 'canonical',
            href: absoluteUrl(loaderData.layout.canonicalBaseUrl, `/pages/${loaderData.slug}`),
          },
        ]
      : [],
  }),
  component: ContentPage,
});

function ContentPage() {
  const page = Route.useLoaderData();
  return (
    <main className="mx-auto max-w-3xl py-10 lg:py-14">
      <h1 className="text-[36px] font-normal tracking-tight">{page.title}</h1>
      <article
        className={`${richTextCls} mt-4`}
        dangerouslySetInnerHTML={{ __html: page.content_html }}
      />
    </main>
  );
}
