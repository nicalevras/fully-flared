import { useRef } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root
      open={request !== null}
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) details.cancel();
        else onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[60] bg-zinc-950/40" />
        <AlertDialog.Popup
          initialFocus={cancelRef}
          className={`${cardCls} fixed top-1/2 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 p-5 outline-none`}
        >
          <AlertDialog.Title className="text-sm font-medium text-zinc-950">
            {request?.title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-zinc-600">
            {request?.body}
          </AlertDialog.Description>
          <div className="mt-4 flex gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={onConfirm}>
              {request?.confirmLabel}
            </button>
            <AlertDialog.Close ref={cancelRef} className={btnSecondary} disabled={busy}>
              Cancel
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
