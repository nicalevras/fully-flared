import { createFileRoute, redirect, type SearchSchemaInput } from '@tanstack/react-router';
import { normalizeProductSearch } from '../../../lib/product-search';

// The editor now lives in a sheet on the product list; this route keeps old
// bookmarks working by landing on the list with that product's sheet open.
export const Route = createFileRoute('/admin/products/$id')({
  validateSearch: (search: { q?: unknown; mode?: unknown; cursor?: unknown } & SearchSchemaInput) =>
    normalizeProductSearch(search),
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/admin/products', search: { ...search, edit: params.id } });
  },
});
