import {
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
} from '@tanstack/react-table';

// Server-side (manual) tables: no client row models are registered, so
// sorting/filtering/pagination never run in the browser over a full dataset.
// D1 does LIMIT/OFFSET (or cursor) per page; TanStack only renders the page
// it is given and owns table state. Anything not listed is tree-shaken out.
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
});

export type DataTableFeatures = typeof dataTableFeatures;
