// Minimal RFC 4180 CSV parser: quoted fields, escaped double-quotes,
// commas and newlines inside quotes, CRLF or LF row endings. The importer
// reports per-row errors, so rows must survive real-world spreadsheet
// exports (product titles with commas are the common case).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

export function serializeCsvCell(value: unknown): string {
  let s = String(value ?? '');
  // Spreadsheet formula injection: neutralize leading formula characters.
  if (/^[=+\-@|\t\r]/.test(s)) s = `'${s}`;
  return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return '';
  const headers = Object.keys(first);
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => serializeCsvCell(r[h])).join(',')),
  ].join('\n');
}
