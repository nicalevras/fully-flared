// Typography for rendered blog/page HTML (utilities only, no custom class).
export const richTextCls =
  'text-[15px] leading-7 text-zinc-800 [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-medium [&_h2]:tracking-tight [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-medium [&_p]:my-4 [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_a]:text-zinc-950 [&_a]:underline [&_a]:underline-offset-2 [&_img]:my-6 [&_img]:w-full [&_img]:rounded-lg [&_blockquote]:my-6 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-4 [&_blockquote]:text-zinc-500';

// Rich product HTML always starts with a block element the editor
// produces; anything else (including inline fragments like <b>) is
// legacy plain text and stays literal everywhere.
const BLOCK_START = /^\s*<(?:p|h[1-6]|ul|ol|blockquote|pre|figure|table|hr|img)(?:\s|>|\/>)/i;

export function isRichTextHtml(value: string): boolean {
  return BLOCK_START.test(value);
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function plainTextToRichHtml(value: string): string {
  if (!value || isRichTextHtml(value)) return value;
  return value
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeText(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function richHtmlToPlainText(value: string): string {
  if (!isRichTextHtml(value)) return value;
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
