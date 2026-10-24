export type VariantEdits<Row extends { id: string }> = Record<string, Partial<Row>>;

export function applyVariantEdits<Row extends { id: string }>(
  loaded: readonly Row[],
  edits: VariantEdits<Row>
): Row[] {
  return loaded.map((row) => ({ ...row, ...edits[row.id] }));
}
