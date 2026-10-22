import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AnyStatus } from '../db/schema';

type Tone = 'green' | 'yellow' | 'red' | 'gray';

// Exhaustive over every status union in the schema: adding a status to a
// column without a tone here is a compile error, and spellings that are not
// stored values (such as 'cancelled') cannot be passed at all.
const TONES: Record<AnyStatus, Tone> = {
  pending_payment: 'yellow',
  paid: 'green',
  processing: 'yellow',
  shipped: 'green',
  delivered: 'green',
  refunded: 'red',
  partially_refunded: 'yellow',
  canceled: 'red',
  unpaid: 'yellow',
  failed: 'red',
  disputed: 'red',
  active: 'green',
  draft: 'yellow',
  archived: 'gray',
  scheduled: 'yellow',
  published: 'green',
  pending: 'yellow',
  requires_action: 'yellow',
  uncertain: 'yellow',
  succeeded: 'green',
  requested: 'yellow',
  refund_failed: 'red',
  approved: 'green',
  rejected: 'red',
  committed: 'green',
  released: 'gray',
  expired: 'gray',
  inactive: 'gray',
};

const TONE_CLASSES: Record<Tone, string> = {
  green: 'bg-green-50 text-green-700 ring-1 ring-green-600/20 ring-inset',
  gray: 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-500/20 ring-inset',
  yellow: 'bg-yellow-50 text-yellow-800 ring-1 ring-yellow-600/20 ring-inset',
  red: 'bg-red-50 text-red-700 ring-1 ring-red-600/20 ring-inset',
};

export function StatusBadge({ value }: { value: AnyStatus }) {
  return (
    <Badge variant="outline" className={cn('border-transparent', TONE_CLASSES[TONES[value]])}>
      {value.replace(/_/g, ' ')}
    </Badge>
  );
}
