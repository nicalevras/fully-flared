export function exactDevOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((v) => {
    const origin = v.trim();
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || /[*]/.test(origin))
      throw new Error('DEV_TRUSTED_ORIGINS must contain exact HTTP origins');
    return origin;
  });
}
