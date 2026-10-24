import type { SearchSchemaInput } from '@tanstack/react-router';

// Route search validators run in the browser, so they are plain functions
// rather than zod schemas. Invalid values fall back instead of throwing.

/** Keeps offset arithmetic safe at the largest admin page size (200). */
export const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / 200);
export const MAX_STOREFRONT_PAGE = 100_000;

function page(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : 1;
}
const numericPage = (value: unknown, max: number) => page(Number(value), max);
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length <= max ? value : '';
const optionalText = (value: unknown, max = Infinity) =>
  typeof value === 'string' && value.length <= max ? value : undefined;

export const pageSearch = (search: { page?: unknown } & SearchSchemaInput) => ({
  page: page(search.page, MAX_PAGE),
});

export const orderPagesSearch = (
  search: { page?: unknown; returnsPage?: unknown } & SearchSchemaInput
) => ({ page: page(search.page, MAX_PAGE), returnsPage: page(search.returnsPage, MAX_PAGE) });

export const accountSearch = (search: { page?: unknown } & SearchSchemaInput) => ({
  page: numericPage(search.page, MAX_PAGE),
});

export const storefrontPageSearch = (search: { page?: unknown } & SearchSchemaInput) => ({
  page: numericPage(search.page, MAX_STOREFRONT_PAGE),
});

export const catalogSearch = (search: { q?: unknown; cursor?: unknown } & SearchSchemaInput) => ({
  q: text(search.q, 200),
  cursor: optionalText(search.cursor, 500),
});

export const successSearch = (search: { order?: unknown; t?: unknown } & SearchSchemaInput) => ({
  order: text(search.order, 100),
  t: text(search.t, 200),
});

export const resetSearch = (search: { token?: unknown; error?: unknown } & SearchSchemaInput) => ({
  token: optionalText(search.token),
  error: optionalText(search.error),
});
