import { btnPrimary, btnSecondary, cardCls } from './ui';

export type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
};

export function ConfirmDialog({
  request,
  busy,
  onConfirm,
  onCancel,
}: {
  request: ConfirmRequest | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!request) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-950/40 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className={`${cardCls} w-full max-w-md p-5`}
      >
        <h2 id="confirm-title" className="text-sm font-medium text-zinc-950">
          {request.title}
        </h2>
        <p id="confirm-body" className="mt-2 text-sm text-zinc-600">
          {request.body}
        </p>
        <div className="mt-4 flex gap-2">
          <button type="button" className={btnPrimary} disabled={busy} onClick={onConfirm}>
            {request.confirmLabel}
          </button>
          <button
            type="button"
            className={btnSecondary}
            disabled={busy}
            autoFocus
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
