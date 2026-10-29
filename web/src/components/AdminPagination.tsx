import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from './ui/pagination';

export function AdminPagination({
  page,
  total,
  pageSize,
  onPage,
  label,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  label: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;
  const wanted = new Set([1, pageCount, page - 2, page - 1, page, page + 1, page + 2]);
  const pages = [...wanted].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const items: Array<number | 'gap'> = [];
  for (const n of pages) {
    if (
      items.length > 0 &&
      typeof items[items.length - 1] === 'number' &&
      n - (items[items.length - 1] as number) > 1
    )
      items.push('gap');
    items.push(n);
  }
  const go = (next: number) => (event: { preventDefault: () => void }) => {
    event.preventDefault();
    onPage(next);
  };
  return (
    <Pagination className="mt-6 justify-start" aria-label={label}>
      <PaginationContent>
        {page > 1 ? (
          <PaginationItem>
            <PaginationPrevious href="#" onClick={go(page - 1)} />
          </PaginationItem>
        ) : null}
        {items.map((item, i) =>
          item === 'gap' ? (
            <PaginationItem key={`gap-${i}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={item}>
              <PaginationLink href="#" isActive={item === page} onClick={go(item)}>
                {item}
              </PaginationLink>
            </PaginationItem>
          )
        )}
        {page < pageCount ? (
          <PaginationItem>
            <PaginationNext href="#" onClick={go(page + 1)} />
          </PaginationItem>
        ) : null}
      </PaginationContent>
    </Pagination>
  );
}
