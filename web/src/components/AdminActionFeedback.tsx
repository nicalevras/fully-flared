import { useEffect, useState } from 'react';
import { CheckCircle2Icon, CircleAlertIcon } from 'lucide-react';

export type AdminActionFeedbackState =
  { kind: 'status'; message: string } | { kind: 'error'; message: string } | null;

export function AdminActionFeedback({ value }: { value: AdminActionFeedbackState }) {
  const [dismissed, setDismissed] = useState<AdminActionFeedbackState>(null);

  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => setDismissed(value), 3000);
    return () => clearTimeout(timer);
  }, [value]);

  if (!value || dismissed === value) return null;
  const error = value.kind === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      aria-atomic="true"
      className={`fixed bottom-6 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-white shadow-lg ${
        error ? 'bg-red-600' : 'bg-green-600'
      }`}
    >
      {error ? (
        <CircleAlertIcon className="size-4 shrink-0" />
      ) : (
        <CheckCircle2Icon className="size-4 shrink-0" />
      )}
      <span>{value.message}</span>
    </div>
  );
}
