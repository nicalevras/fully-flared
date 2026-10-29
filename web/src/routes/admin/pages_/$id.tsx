import { createFileRoute, redirect } from '@tanstack/react-router';

// The editor now lives in a sheet on the pages list; this route keeps old
// bookmarks working by landing on the list with that page's sheet open.
export const Route = createFileRoute('/admin/pages_/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/admin/pages', search: { edit: params.id } });
  },
});
