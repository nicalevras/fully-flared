export function SeoPreview({
  path,
  seoTitle,
  seoDescription,
  titleFallback,
  descriptionFallback,
  emptyDescription,
}: {
  path: string;
  seoTitle: string;
  seoDescription: string;
  titleFallback: string;
  descriptionFallback: string;
  emptyDescription: string;
}) {
  return (
    <div className="rounded-md border border-zinc-200 p-4">
      <h3 className="text-sm font-medium text-zinc-950">Search result preview</h3>
      <p className="mt-2 text-sm font-medium text-blue-800">
        {seoTitle.trim() || titleFallback.trim() || 'Untitled'}
      </p>
      <p className="truncate text-xs text-zinc-500">{path}</p>
      <p className="mt-1 text-sm text-zinc-600">
        {seoDescription.trim() || descriptionFallback.trim() || emptyDescription}
      </p>
    </div>
  );
}
