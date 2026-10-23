/** A cosmetic count only. The HttpOnly cart capability remains server-owned. */
export function cartCountFromCookie(header: string | null): number {
  const value = header
    ?.split(';')
    .find((part) => part.trim().startsWith('cart_count='))
    ?.split('=')[1];
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}
