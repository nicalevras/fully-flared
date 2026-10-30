'use client';

import * as React from 'react';
import { cn } from 'cn';
import {
  useTable,
  type Column,
  type ColumnDef,
  type OnChangeFn,
  type PaginationState,
  type Row,
  type RowData,
  type RowSelectionState,
  type SortingState,
  type ReactTable,
  type Table as TanStackTable,
} from '@tanstack/react-table';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeOffIcon,
  SearchIcon,
} from 'lucide-react';

import { dataTableFeatures, type DataTableFeatures } from '../data-table-features';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table';

export function DataTableColumnHeader<TData extends RowData, TValue>({
  column,
  title,
  className,
}: {
  column: Column<DataTableFeatures, TData, TValue>;
  title: string;
  className?: string;
}) {
  if (!column.getCanSort()) {
    return <div className={cn(className)}>{title}</div>;
  }
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-3 h-8 rounded-md data-[state=open]:bg-accent"
          >
            <span>{title}</span>
            {column.getIsSorted() === 'desc' ? (
              <ArrowDownIcon />
            ) : column.getIsSorted() === 'asc' ? (
              <ArrowUpIcon />
            ) : (
              <ArrowUpDownIcon />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuCheckboxItem
            checked={column.getIsSorted() === 'asc'}
            onCheckedChange={() => column.toggleSorting(false)}
          >
            <ArrowUpIcon className="h-3.5 w-3.5 text-muted-foreground/70" /> Asc
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={column.getIsSorted() === 'desc'}
            onCheckedChange={() => column.toggleSorting(true)}
          >
            <ArrowDownIcon className="h-3.5 w-3.5 text-muted-foreground/70" /> Desc
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={false}
            onCheckedChange={() => column.toggleVisibility(false)}
          >
            <EyeOffIcon className="h-3.5 w-3.5 text-muted-foreground/70" /> Hide
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// Right-side header controls match the Columns button exactly: h-8, rounded-md,
// zinc-300 outline. Every table reuses this instead of inventing its own select style.
export const dataTableControlClassName =
  'h-8 rounded-md border border-zinc-300 bg-background px-3 text-[13px] font-medium shadow-none hover:bg-zinc-50 focus-visible:border-zinc-400';

// Select menus mirror the Columns DropdownMenu: same width, radius, padding,
// item shape, and the check indicator on the left at the same size.
export const dataTableMenuClassName = 'w-44 min-w-44 rounded-md p-1';
export const dataTableMenuItemClassName =
  'rounded-sm py-1.5 pr-2 pl-8 [&>span:first-child]:left-2 [&>span:first-child]:size-3.5 [&_svg]:size-3.5';

export function DataTableViewOptions<TData extends RowData>({
  table,
}: {
  table: TanStackTable<DataTableFeatures, TData>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-8 rounded-md lg:flex"
        >
          Columns <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {table
          .getAllColumns()
          .filter((column) => typeof column.accessorFn !== 'undefined' && column.getCanHide())
          .map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              className="capitalize"
              checked={column.getIsVisible()}
              onCheckedChange={(value) => column.toggleVisibility(!!value)}
              onSelect={(event) => event.preventDefault()}
            >
              {column.id.replace(/_/g, ' ')}
            </DropdownMenuCheckboxItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DataTablePagination<TData extends RowData>({
  table,
  pageSizeOptions,
}: {
  table: ReactTable<DataTableFeatures, TData>;
  pageSizeOptions?: readonly number[];
}) {
  const pageCount = table.getPageCount();
  const hasPages = pageCount > 0;
  return (
    <div className="flex items-center justify-between px-2 py-3">
      <div className="flex-1 text-sm text-muted-foreground" role="status">
        {table.getSelectedRowModel().rows.length} of {table.getRowCount()} row(s) selected.
      </div>
      <div className="flex items-center space-x-6 lg:space-x-8">
        {pageSizeOptions ? (
          <div className="flex items-center space-x-2">
            <p className="text-sm font-medium">Rows per page</p>
            <Select
              value={`${table.state.pagination.pageSize}`}
              onValueChange={(value) => table.setPageSize(Number(value))}
            >
              <SelectTrigger className="h-8 w-[70px] rounded-md">
                <SelectValue placeholder={table.state.pagination.pageSize} />
              </SelectTrigger>
              <SelectContent side="top">
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={`${size}`}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="flex w-[100px] items-center justify-center text-sm font-medium">
          Page {hasPages ? table.state.pagination.pageIndex + 1 : 0} of {pageCount}
        </div>
        <div className="flex items-center space-x-2">
          <Button
            type="button"
            variant="outline"
            className="hidden h-8 w-8 rounded-md p-0 lg:flex"
            onClick={() => table.setPageIndex(0)}
            disabled={!hasPages || !table.getCanPreviousPage()}
            aria-label="Go to first page"
          >
            <ChevronsLeftIcon />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-8 w-8 rounded-md p-0"
            onClick={() => table.previousPage()}
            disabled={!hasPages || !table.getCanPreviousPage()}
            aria-label="Go to previous page"
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-8 w-8 rounded-md p-0"
            onClick={() => table.nextPage()}
            disabled={!hasPages || !table.getCanNextPage()}
            aria-label="Go to next page"
          >
            <ChevronRightIcon />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="hidden h-8 w-8 rounded-md p-0 lg:flex"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!hasPages || !table.getCanNextPage()}
            aria-label="Go to last page"
          >
            <ChevronsRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

export type ServerDataTableProps<TData extends RowData> = {
  columns: ColumnDef<DataTableFeatures, TData>[];
  data: TData[];
  caption: string;
  pageIndex: number;
  pageSize: number;
  rowCount: number;
  onPaginationChange: OnChangeFn<PaginationState>;
  pageSizeOptions?: readonly number[];
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  enableRowSelection?: boolean | ((row: Row<DataTableFeatures, TData>) => boolean);
  getRowId?: (row: TData) => string;
  toolbar?: React.ReactNode;
  toolbarActions?: React.ReactNode;
  toolbarEnd?: React.ReactNode;
  hideViewOptions?: boolean;
  onRowClick?: (row: TData) => void;
  getRowClassName?: (row: TData) => string | undefined;
  emptyMessage?: React.ReactNode;
  tableClassName?: string;
  paginationFooter?: React.ReactNode;
};

// Docs Data Table, server-side: TanStack renders only the page D1 returned.
// manualPagination/manualSorting/manualFiltering keep every heavy operation
// in the Worker query (LIMIT/OFFSET or cursor), never in the browser.
export function DataTable<TData extends RowData>({
  columns,
  data,
  caption,
  pageIndex,
  pageSize,
  rowCount,
  onPaginationChange,
  pageSizeOptions,
  sorting: sortingProp,
  onSortingChange,
  rowSelection: rowSelectionProp,
  onRowSelectionChange,
  enableRowSelection,
  getRowId,
  toolbar,
  toolbarActions,
  toolbarEnd,
  hideViewOptions,
  onRowClick,
  getRowClassName,
  emptyMessage = 'No results.',
  tableClassName,
  paginationFooter,
}: ServerDataTableProps<TData>) {
  const [internalSorting, setInternalSorting] = React.useState<SortingState>([]);
  const [internalSelection, setInternalSelection] = React.useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = React.useState({});
  const sorting = sortingProp ?? internalSorting;
  const rowSelection = rowSelectionProp ?? internalSelection;

  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    rowCount,
    ...(enableRowSelection !== undefined ? { enableRowSelection } : {}),
    ...(getRowId ? { getRowId } : {}),
    onPaginationChange,
    onSortingChange: onSortingChange ?? setInternalSorting,
    onRowSelectionChange: onRowSelectionChange ?? setInternalSelection,
    onColumnVisibilityChange: setColumnVisibility,
    state: {
      pagination: { pageIndex, pageSize },
      sorting,
      rowSelection,
      columnVisibility,
    },
  });

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white [&_td]:px-3 [&_td]:py-3 [&_th]:px-3 [&_th]:py-3">
      {toolbar || toolbarActions || toolbarEnd || !hideViewOptions ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-3">
          {toolbar}
          {toolbarActions || toolbarEnd || !hideViewOptions ? (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {toolbarActions}
              {!hideViewOptions ? <DataTableViewOptions table={table} /> : null}
              {toolbarEnd}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <Table className={tableClassName}>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className={cn(onRowClick && 'cursor-pointer', getRowClassName?.(row.original))}
                  onClick={
                    onRowClick
                      ? (event) => {
                          if (
                            event.target instanceof Element &&
                            event.target.closest(
                              'a, button, select, input, [role="menu"], [data-slot="dropdown-menu-content"]'
                            )
                          )
                            return;
                          onRowClick(row.original);
                        }
                      : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={Math.max(1, table.getVisibleLeafColumns().length)}
                  className="h-24 text-center"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="border-t border-zinc-200">
        {paginationFooter ?? (
          <DataTablePagination table={table} {...(pageSizeOptions ? { pageSizeOptions } : {})} />
        )}
      </div>
    </div>
  );
}

// Shared admin toolbar search: debounced live filter, URL stays the source of
// truth via onSearch. Searches fire only at 3+ characters. 300ms debounce
// keeps a typed search to ~1 Worker invocation instead of one per keystroke.
export function DataTableSearch({
  value,
  onSearch,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onSearch: (q: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const [text, setText] = React.useState(value);
  const lastSent = React.useRef(value);
  const onSearchRef = React.useRef(onSearch);
  React.useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);
  // Adopt external changes only (clear, back navigation). Our own emit echoing
  // back through the URL must not overwrite newer keystrokes.
  React.useEffect(() => {
    if (value === lastSent.current) return;
    lastSent.current = value;
    setText(value);
  }, [value]);
  React.useEffect(() => {
    const trimmed = text.trim();
    const effective = trimmed.length >= 3 ? trimmed : '';
    if (effective === lastSent.current) return;
    const timer = setTimeout(() => {
      lastSent.current = effective;
      onSearchRef.current(effective);
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <div className="min-w-0 grow basis-64 sm:max-w-sm">
        <div className="flex h-9 w-full items-stretch overflow-hidden rounded-md border border-zinc-300 bg-white focus-within:border-zinc-400">
          <div className="flex shrink-0 items-center border-r border-zinc-200 bg-white pr-2 pl-3">
            <SearchIcon className="size-4 shrink-0 text-zinc-400" />
          </div>
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={placeholder}
            aria-label={ariaLabel}
            maxLength={200}
            className="min-w-0 flex-1 appearance-none bg-transparent pr-3 pl-2 text-sm text-zinc-950 shadow-none outline-none placeholder:text-zinc-400 [&::-webkit-search-cancel-button]:hidden"
          />
          {text ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setText('');
                lastSent.current = '';
                onSearch('');
              }}
              className="flex w-7 shrink-0 items-center justify-center text-zinc-400 hover:text-zinc-950"
            >
              <span aria-hidden="true">✕</span>
            </button>
          ) : null}
        </div>
      </div>
      {text.trim().length > 0 && text.trim().length < 3 ? (
        <span className="text-xs text-zinc-500">Type 3 or more characters to search</span>
      ) : null}
    </div>
  );
}
