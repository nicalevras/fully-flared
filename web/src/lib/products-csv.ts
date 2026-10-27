export const REQUIRED_PRODUCT_CSV_COLUMNS = ['title', 'slug', 'sku', 'price_cents', 'stock'];
export const MAX_PRODUCT_CSV_ROWS = 1000;
export const MAX_PRODUCT_CSV_BYTES = 2_000_000;

export function parseProductsCsv(text: string): string[][] {
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
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

export type ProductsCsvPreview = {
  headers: string[];
  missingColumns: string[];
  totalRows: number;
  previewRows: string[][];
  byteSize: number;
  problems: string[];
};

export function previewProductsCsv(text: string): ProductsCsvPreview {
  const rows = parseProductsCsv(text);
  const headers = (rows[0] ?? []).map((header) => header.trim());
  const missingColumns = REQUIRED_PRODUCT_CSV_COLUMNS.filter((column) => !headers.includes(column));
  const totalRows = Math.max(0, rows.length - 1);
  const byteSize = new TextEncoder().encode(text).byteLength;
  const problems: string[] = [];
  if (rows.length === 0) problems.push('The file is empty.');
  if (missingColumns.length > 0)
    problems.push(`Missing required columns: ${missingColumns.join(', ')}.`);
  if (totalRows > MAX_PRODUCT_CSV_ROWS)
    problems.push(
      `The file has ${totalRows} product rows. The limit is ${MAX_PRODUCT_CSV_ROWS} per import.`
    );
  if (byteSize > MAX_PRODUCT_CSV_BYTES) problems.push('The file is larger than 2 MB.');
  return {
    headers,
    missingColumns,
    totalRows,
    previewRows: rows.slice(1, 6),
    byteSize,
    problems,
  };
}
