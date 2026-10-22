export type ReorderItem = { sku: string; title: string; qty: number };

/** Add a past order's items to the cart one by one. A failure never stops
 * the remaining items and never throws: the result reports what was added
 * and what failed, classifying only the server's "no longer available"
 * (archived/inactive) as unavailable — cart limits and network failures
 * are generic add failures. Callers show the failures and open the cart
 * when anything was added so partial success is inspectable. */
export async function reorderItems(
  items: ReorderItem[],
  add: (sku: string, qty: number) => Promise<unknown>
): Promise<{ added: ReorderItem[]; failed: Array<{ title: string; unavailable: boolean }> }> {
  const added: ReorderItem[] = [];
  const failed: Array<{ title: string; unavailable: boolean }> = [];
  for (const item of items) {
    try {
      await add(item.sku, item.qty);
      added.push(item);
    } catch (error) {
      failed.push({
        title: item.title,
        unavailable: error instanceof Error && /no longer available/.test(error.message),
      });
    }
  }
  return { added, failed };
}
