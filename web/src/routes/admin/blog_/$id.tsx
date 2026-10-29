import { createFileRoute, redirect } from '@tanstack/react-router';

// The editor now lives in a sheet on the articles list; this route keeps old
// bookmarks working by landing on the list with that post's sheet open.
export const Route = createFileRoute('/admin/blog_/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/admin/articles', search: { edit: params.id } });
  },
});
