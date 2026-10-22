/** Clamp a requested 1-based page into the valid range for a total. */
export function pageWindow(
  total: number,
  page: number,
  pageSize: number
): { page: number; pageCount: number; offset: number } {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  return { page: clamped, pageCount, offset: (clamped - 1) * pageSize };
}
