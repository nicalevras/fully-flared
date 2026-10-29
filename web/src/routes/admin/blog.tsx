import { createFileRoute, redirect, type SearchSchemaInput } from '@tanstack/react-router';

// The articles list moved to /admin/articles; this route keeps old admin
// bookmarks working, including a post whose editor sheet was open.
export const Route = createFileRoute('/admin/blog')({
  validateSearch: (search: { edit?: unknown } & SearchSchemaInput) => ({
    edit: typeof search.edit === 'string' && search.edit ? search.edit : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/admin/articles', search: { edit: search.edit } });
  },
});
