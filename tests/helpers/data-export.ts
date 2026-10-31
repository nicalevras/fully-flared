import { z } from './json';
import { collectDataExport } from '../../web/src/lib/data-export';
import { readDataExportPage } from '../../web/src/server/data-export';
import type { ExportTarget } from '../../web/src/schemas/data-export';

export const exportSecret = 'local-export-regression-secret-at-least-32-bytes';

export async function exportJson<T>(
  db: D1Database,
  actor: Parameters<typeof readDataExportPage>[2],
  target: ExportTarget,
  schema: z.ZodType<T>
): Promise<T> {
  const blob = await collectDataExport(
    target,
    (input) => readDataExportPage(db, exportSecret, actor, input),
    new AbortController().signal
  );
  const json: unknown = JSON.parse(await blob.text());
  return schema.parse(json);
}
