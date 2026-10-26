import { Alert, AlertDescription } from './ui/alert';

export type AdminActionFeedbackState =
  { kind: 'status'; message: string } | { kind: 'error'; message: string } | null;

export function AdminActionFeedback({ value }: { value: AdminActionFeedbackState }) {
  if (!value) return null;
  return (
    <Alert
      className="sticky top-4 z-20 mt-5 border-zinc-200 px-4 py-3"
      variant={value.kind === 'error' ? 'destructive' : 'default'}
      role={value.kind === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
    >
      <AlertDescription>{value.message}</AlertDescription>
    </Alert>
  );
}
