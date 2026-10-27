import { parseMoneyCents } from './format';

export type VariantOptionGroup = { name: string; valuesText: string };
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

export function parseOptionValues(text: string): string[] {
  return text
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export type CleanOptionGroup = { name: string; values: string[] };

export function cleanOptionGroups(groups: VariantOptionGroup[]): CleanOptionGroup[] {
  return groups
    .map((group) => ({ name: group.name.trim(), values: parseOptionValues(group.valuesText) }))
    .filter((group) => group.name && group.values.length > 0);
}

export function validateOptionGroups(groups: VariantOptionGroup[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  let hasDuplicateName = false;
  for (const group of groups) {
    const name = group.name.trim();
    if (name && names.has(name.toLowerCase())) hasDuplicateName = true;
    if (name) names.add(name.toLowerCase());
    const values = parseOptionValues(group.valuesText);
    if (values.length > MAX_VALUES_PER_GROUP)
      errors.push(
        `Option ${name || 'group'} has more than ${MAX_VALUES_PER_GROUP} values. Remove some before creating variants.`
      );
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value.toLowerCase())) {
        errors.push(`Values in ${name || 'this option'} must be unique.`);
        break;
      }
      seen.add(value.toLowerCase());
    }
  }
  if (hasDuplicateName) errors.push('Option names must be unique.');
  return errors;
}

export function droppedEditedCombinations(
  combinations: VariantCombination[],
  editedKeys: ReadonlySet<string>,
  next: VariantCombination[]
): VariantCombination[] {
  const nextKeys = new Set(next.map((combo) => combo.key));
  return combinations.filter((combo) => editedKeys.has(combo.key) && !nextKeys.has(combo.key));
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

export function validateVariantCombinations(
  combinations: VariantCombination[],
  combinationCount?: number
): string[] {
  const errors: string[] = [];
  if (combinations.length === 0) {
    if (combinationCount !== undefined && combinationCount > MAX_VARIANT_COMBINATIONS)
      errors.push(
        `${combinationCount} combinations exceed the limit of ${MAX_VARIANT_COMBINATIONS} variants. Reduce option values.`
      );
    else errors.push('Add at least one option value to generate variants.');
    return errors;
  }
  if (combinations.length > MAX_VARIANT_COMBINATIONS)
    errors.push(`At most ${MAX_VARIANT_COMBINATIONS} variants can be created at once.`);
  const seen = new Map<string, number>();
  combinations.forEach((combo, index) => {
    const sku = combo.sku.trim();
    if (!sku) errors.push(`Variant ${index + 1} needs a SKU.`);
    else if (sku.length > 100)
      errors.push(
        `Variant ${combo.title} has a SKU over 100 characters. Shorten the SKU in the table.`
      );
    else if (seen.has(sku)) errors.push(`SKU ${sku} is used more than once.`);
    else seen.set(sku, index);
    if (combo.title.length > 200)
      errors.push(
        `Variant ${combo.title} has a title over 200 characters. Shorten the option values.`
      );
    if (!parseMoneyCents(combo.price).ok)
      errors.push(
        `Variant ${combo.title} needs a price with at most two decimal places, up to 1,000,000.00.`
      );
    const stock = Number(combo.stock);
    if (combo.stock.trim() === '' || !Number.isInteger(stock) || stock < 0 || stock > 1_000_000)
      errors.push(`Variant ${index + 1} needs whole stock from 0 to 1,000,000.`);
  });
  return errors;
}
