export type VariantOptionGroup = { name: string; values: string[] };
export type VariantCombination = {
  key: string;
  title: string;
  values: string[];
  sku: string;
  price: string;
  stock: string;
};

export const MAX_OPTION_GROUPS = 3;
export const MAX_VALUES_PER_GROUP = 10;
export const MAX_VARIANT_COMBINATIONS = 100;

export function combinationKey(values: string[]): string {
  return values.join('\u001f');
}

export function cleanOptionGroups(groups: VariantOptionGroup[]): VariantOptionGroup[] {
  return groups
    .map((group) => ({
      name: group.name.trim(),
      values: group.values.map((value) => value.trim()).filter(Boolean),
    }))
    .filter((group) => group.name && group.values.length > 0);
}

export function countCombinations(groups: VariantOptionGroup[]): number {
  const cleaned = cleanOptionGroups(groups);
  if (cleaned.length === 0) return 0;
  return cleaned.reduce((total, group) => total * group.values.length, 1);
}

export function generateVariantCombinations(
  groups: VariantOptionGroup[],
  productSlug: string,
  defaults: { price: string; stock: string },
  previous: VariantCombination[] = []
): VariantCombination[] {
  const cleaned = cleanOptionGroups(groups);
  if (cleaned.length === 0) return [];
  let combos: string[][] = [[]];
  for (const group of cleaned) {
    combos = combos.flatMap((prefix) => group.values.map((value) => [...prefix, value]));
  }
  if (combos.length > MAX_VARIANT_COMBINATIONS) return [];
  const previousByKey = new Map(previous.map((combo) => [combo.key, combo]));
  const base = (productSlug || 'product').toUpperCase().replace(/[^A-Z0-9]+/g, '-');
  return combos.map((values) => {
    const key = combinationKey(values);
    const prior = previousByKey.get(key);
    if (prior) return { ...prior, title: values.join(' / '), values };
    const suffix = values
      .join('-')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return {
      key,
      title: values.join(' / '),
      values,
      sku: suffix ? `${base}-${suffix}` : base,
      price: defaults.price,
      stock: defaults.stock,
    };
  });
}

export function validateVariantCombinations(combinations: VariantCombination[]): string[] {
  const errors: string[] = [];
  if (combinations.length === 0) {
    errors.push('Add at least one option value to generate variants.');
    return errors;
  }
  if (combinations.length > MAX_VARIANT_COMBINATIONS)
    errors.push(`At most ${MAX_VARIANT_COMBINATIONS} variants can be created at once.`);
  const seen = new Map<string, number>();
  combinations.forEach((combo, index) => {
    const sku = combo.sku.trim();
    if (!sku) errors.push(`Variant ${index + 1} needs a SKU.`);
    else if (seen.has(sku)) errors.push(`SKU ${sku} is used more than once.`);
    else seen.set(sku, index);
    const price = Number(combo.price);
    if (combo.price.trim() === '' || !Number.isFinite(price) || price < 0)
      errors.push(`Variant ${index + 1} needs a price of zero or more.`);
    const stock = Number(combo.stock);
    if (combo.stock.trim() === '' || !Number.isInteger(stock) || stock < 0 || stock > 1_000_000)
      errors.push(`Variant ${index + 1} needs whole stock from 0 to 1,000,000.`);
  });
  return errors;
}
