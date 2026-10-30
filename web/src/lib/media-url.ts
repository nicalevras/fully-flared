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
