import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ExportTarget } from '../schemas/data-export';
import { dataExportPageFn } from '../lib/dataExportFns';
import { collectDataExport, saveDataExport } from '../lib/data-export';

export function DataExportButton({
  target,
  filename,
  children,
  className,
  disabled,
  onSuccess,
  onError,
}: {
  target: ExportTarget;
  filename: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onSuccess?: () => void;
  onError?: (message: string) => void;
}) {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    []
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={className}
        disabled={disabled || busy}
        onClick={async () => {
          const controller = new AbortController();
          pending.current = controller;
          setBusy(true);
          setError('');
          try {
            const blob = await collectDataExport(
              target,
              (data) => dataExportPageFn({ data, signal: controller.signal }),
              controller.signal
            );
            controller.signal.throwIfAborted();
            saveDataExport(blob, filename);
            onSuccess?.();
          } catch (cause) {
            if (!controller.signal.aborted) {
              const message = cause instanceof Error ? cause.message : 'Export failed. Try again.';
              setError(message);
              onError?.(message);
            }
          } finally {
            if (!controller.signal.aborted) setBusy(false);
            if (pending.current === controller) pending.current = null;
          }
        }}
      >
        {busy ? 'Preparing export…' : children}
      </button>
      {busy ? (
        <button
          type="button"
          className="text-sm underline"
          onClick={() => {
            pending.current?.abort();
            pending.current = null;
            setBusy(false);
          }}
        >
          Cancel export
        </button>
      ) : null}
      {error && !onError ? (
        <span className="text-sm text-red-600" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
