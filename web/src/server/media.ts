/** Responsive variant widths served by /media/$key?w=. Variants are
 * generated in the admin browser at upload time (Workers has no image
 * codec) and stored next to the original under a derived key. */
export const VARIANT_WIDTHS = [320, 640, 960, 1600] as const;

const MEDIA_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MEDIA_TOKEN = /https?:\/\/[^\s"'<>\\]+|\/media\/[^\s"'<>\\]+/g;

function acceptedOriginSet(acceptedOrigins: string[]): Set<string> {
  return new Set(acceptedOrigins.map((origin) => origin.replace(/\/+$/, '')).filter(Boolean));
}

/** Split a matched token into origin prefix, raw path, and the suffix
 * after the key (`?w=…`/fragment). Returns null for foreign/invalid. */
function parseMediaToken(
  token: string,
  origins: Set<string>
): { prefix: string; rawPath: string; rawKey: string; suffix: string } | null {
  let prefix = '';
  let path = token;
  if (token.startsWith('http')) {
    let url: URL;
    try {
      url = new URL(token);
    } catch {
      return null;
    }
    if (!origins.has(url.origin)) return null;
    prefix = token.slice(0, token.indexOf(url.pathname));
    path = url.pathname;
  }
  if (!path.startsWith('/media/')) return null;
  const rest = path.slice('/media/'.length);
  const cut = rest.search(/[?#]/);
  // For absolute tokens the query/fragment sits after the pathname in
  // the original token; for relative tokens it is part of `rest`.
  const tail = token.slice(prefix.length + path.length);
  return {
    prefix,
    rawPath: path,
    rawKey: cut >= 0 ? rest.slice(0, cut) : rest,
    suffix: (cut >= 0 ? rest.slice(cut) : '') + tail,
  };
}

/** Decode exactly once, mirroring the media route's param decoding;
 * malformed percent sequences stay as-is and simply fail the key check. */
function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey).replace(
      /^(.+)\.w(?:320|640|960|1600)(?:\.[a-f0-9]{16})?(\.[A-Za-z0-9]+)$/,
      '$1$2'
    );
  } catch {
    return rawKey;
  }
}

/** Distinct local media keys referenced by HTML or JSON content.
 * Recognized forms: relative `/media/<key>` (responsive `?w=` suffixes
 * included) and absolute URLs whose origin is in acceptedOrigins (the
 * configured canonical origin and/or the current request origin). Any
 * other host is an external image and is ignored. Escaped `\/media\/`
 * sequences (JSON string content) are normalized first, and percent-
 * encoded keys are decoded once (`%61bc.jpg` -> `abc.jpg`). */
export function mediaKeysInContent(
  text: string | null | undefined,
  acceptedOrigins: string[] = []
): string[] {
  if (!text) return [];
  const origins = acceptedOriginSet(acceptedOrigins);
  const keys = new Set<string>();
  const tokens = text.replaceAll('\\/', '/').match(MEDIA_TOKEN);
  for (const token of tokens ?? []) {
    const parsed = parseMediaToken(token, origins);
    if (!parsed) continue;
    const key = decodeKey(parsed.rawKey);
    if (MEDIA_KEY.test(key)) keys.add(key);
  }
  return [...keys];
}

/** Rewrite recognized local media URL paths to their once-decoded
 * canonical form, so stored content always uses the plain key every
 * SQL check matches. Foreign/invalid tokens pass through unchanged. */
export function canonicalizeMediaUrls(text: string, acceptedOrigins: string[] = []): string {
  const origins = acceptedOriginSet(acceptedOrigins);
  return text.replaceAll('\\/', '/').replace(MEDIA_TOKEN, (token) => {
    const parsed = parseMediaToken(token, origins);
    if (!parsed) return token;
    const key = decodeKey(parsed.rawKey);
    if (!MEDIA_KEY.test(key) || key === parsed.rawKey) return token;
    return `${parsed.prefix}/media/${key}${parsed.suffix}`;
  });
}

/** Raw `/media/…` path spellings (e.g. percent-encoded forms) found in
 * stored content that decode to one of the given keys. Used only as
 * extra search patterns for grandfathering checks; the abort decision
 * still evaluates against database content inside the save batch. */
export function mediaRawSpellings(
  text: string | null | undefined,
  keys: ReadonlySet<string>,
  acceptedOrigins: string[] = []
): Map<string, string[]> {
  const spellings = new Map<string, string[]>();
  if (!text || keys.size === 0) return spellings;
  const origins = acceptedOriginSet(acceptedOrigins);
  const tokens = text.replaceAll('\\/', '/').match(MEDIA_TOKEN);
  for (const token of tokens ?? []) {
    const parsed = parseMediaToken(token, origins);
    if (!parsed) continue;
    const key = decodeKey(parsed.rawKey);
    if (!keys.has(key)) continue;
    const plain = `/media/${key}`;
    if (parsed.rawPath === plain) continue;
    const list = spellings.get(key) ?? [];
    if (!list.includes(parsed.rawPath)) list.push(parsed.rawPath);
    spellings.set(key, list);
  }
  return spellings;
}

export function variantKey(key: string, width: number): string {
  const dot = key.lastIndexOf('.');
  return dot > 0 ? `${key.slice(0, dot)}.w${width}${key.slice(dot)}` : `${key}.w${width}`;
}

/** Widths worth generating for a source of the given natural width:
 * never upscale, and skip variants that would duplicate the original. */
export function variantWidthsFor(naturalWidth: number): number[] {
  if (!Number.isFinite(naturalWidth) || naturalWidth <= 0) return [];
  return VARIANT_WIDTHS.filter((w) => w < naturalWidth);
}
