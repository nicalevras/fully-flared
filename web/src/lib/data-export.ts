import type { ExportPage, ExportRequest, ExportTarget } from '../schemas/data-export';

export async function collectDataExport(
  target: ExportTarget,
  readPage: (request: ExportRequest) => Promise<ExportPage>,
  signal: AbortSignal
): Promise<Blob> {
  const parts: string[] = [];
  let request: ExportRequest = { target };
  for (;;) {
    signal.throwIfAborted();
    const page = await readPage(request);
    signal.throwIfAborted();
    parts.push(page.chunk);
    if (!page.nextCursor) return new Blob(parts, { type: 'application/json' });
    request = { cursor: page.nextCursor };
  }
}

export function saveDataExport(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
