import sanitize from 'sanitize-html';

// Allowlist HTML sanitizer for staff-authored blog/page content. Backed by
// sanitize-html (a real HTML parser, not regexes): anything not explicitly
// allowed — tags, attributes, URL schemes, classes, styles — is removed.
// Applied when content is saved; storefront reads render the stored result.
const ALLOWED_TAGS = [
  ...sanitize.defaults.allowedTags,
  'img',
  'figure',
  'figcaption',
  'picture',
  'source',
];

export function sanitizeHtml(html: string): string {
  return sanitize(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
      source: ['src', 'srcset', 'type'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
      ol: ['start'],
      time: ['datetime'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'], source: ['http', 'https'] },
    allowProtocolRelative: false,
    allowedClasses: {},
    parseStyleAttributes: false,
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'iframe',
      'object',
      'embed',
      'form',
      'noscript',
    ],
    enforceHtmlBoundary: true,
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Derive searchable plain text from already-sanitized HTML. The input must
 *  be sanitizeHtml output, never raw merchant input. */
export function plainTextFromHtml(html: string): string {
  return html
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}
