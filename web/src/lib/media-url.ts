import { isRecord } from './is-record';

export type MediaSource = {
  key: string;
  publicUrl?: string | null | undefined;
  variants?: Array<{ width: number; url: string }> | undefined;
};

/** Only advertised, successfully stored variants enter a public srcset. */
export function mediaUrl(source: MediaSource, width?: number) {
  if (width && source.variants?.length) {
    const sorted = [...source.variants].sort((a, b) => a.width - b.width);
    const chosen = sorted.find((v) => v.width >= width) ?? sorted.at(-1);
    if (chosen) return chosen.url;
  }
  return source.publicUrl || `/media/${encodeURIComponent(source.key)}`;
}
export function mediaSrcSet(source: MediaSource) {
  return source.variants?.map((v) => `${v.url} ${v.width}w`).join(',') || undefined;
}

function isStoredVariant(value: unknown): value is { width: number; url?: string | null } {
  return (
    isRecord(value) &&
    typeof value.width === 'number' &&
    (value.url === undefined || value.url === null || typeof value.url === 'string')
  );
}

/** Variants from stored JSON, filled the way the catalog publisher fills
 *  them: a variant without a public URL is served through the media route
 *  at its width. Unreadable or malformed JSON yields no variants. */
export function storedVariants(
  json: string | null | undefined,
  key: string
): MediaSource['variants'] {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || !parsed.every(isStoredVariant)) return undefined;
    return parsed.map((variant) => ({
      ...variant,
      url: variant.url || `/media/${encodeURIComponent(key)}?w=${variant.width}`,
    }));
  } catch {
    return undefined;
  }
}
