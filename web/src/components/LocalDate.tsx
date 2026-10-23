import { useSyncExternalStore } from 'react';
import { formatDate, formatDateTime } from '../lib/format';

const subscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = () => 'UTC';

/** Match SSR during hydration, then display the viewer's local calendar date. */
export function LocalDate({ value, withTime = false }: { value: string; withTime?: boolean }) {
  const timeZone = useSyncExternalStore(subscribe, browserZone, serverZone);
  return (
    <time dateTime={value} title={timeZone}>
      {withTime ? formatDateTime(value, timeZone) : formatDate(value, timeZone)}
    </time>
  );
}
