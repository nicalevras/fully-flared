import type { ReactNode } from 'react';
import { cn } from 'cn';
import { ChevronDownIcon, MoreHorizontalIcon } from 'lucide-react';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

// Admin-only docs chrome: bordered rounded-md wrapper + squared controls.
// The [&_button]/[&_input] overrides are scoped to this wrapper, so
// storefront pill styling (ui/button, ui/input) is untouched.
export function AdminDataTableShell({
  toolbar,
  toolbarActions,
  footer,
  children,
  className,
}: {
  toolbar?: ReactNode;
  toolbarActions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="admin-data-table"
      className={cn(
        'overflow-hidden rounded-lg border border-zinc-200 bg-white [&_button]:rounded-md [&_input]:rounded-md [&_[data-slot=select-trigger]]:rounded-md [&_td]:px-3 [&_td]:py-3 [&_th]:px-3 [&_th]:py-3',
        className
      )}
    >
      {toolbar || toolbarActions ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-3">
          {toolbar}
          {toolbarActions ? (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {toolbarActions}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
      {footer ? <div className="border-t border-zinc-200 px-3 py-2">{footer}</div> : null}
    </div>
  );
}

export type AdminColumn = { id: string; label: string };

export function AdminColumnToggle({
  columns,
  hidden,
  onToggle,
}: {
  columns: AdminColumn[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string, visible: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-md">
          Columns <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={!hidden.has(column.id)}
            onCheckedChange={(checked) => onToggle(column.id, checked)}
            onSelect={(event) => event.preventDefault()}
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AdminRowActions({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className="rounded-md"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontalIcon />
          <span className="sr-only">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
