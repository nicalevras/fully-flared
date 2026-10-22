import { btnSmall } from './ui';

export function AdminPager({
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
  return (
    <nav aria-label={label} className="my-4 flex items-center gap-3 text-sm">
      <button className={btnSmall} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {Math.max(1, Math.ceil(total / pageSize))} · {total} total
      </span>
      <button
        className={btnSmall}
        disabled={page * pageSize >= total}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
