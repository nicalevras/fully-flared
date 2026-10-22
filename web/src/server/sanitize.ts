import sanitize from 'sanitize-html';

// Allowlist HTML sanitizer for staff-authored blog/page content. Backed by
// sanitize-html (a real HTML parser, not regexes): anything not explicitly
// allowed — tags, attributes, URL schemes, classes, styles — is removed.
// Applied when content is saved and again when it is read for rendering, so
// rows written before this sanitizer existed are also safe.
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
