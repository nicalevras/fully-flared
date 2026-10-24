import { Parser } from 'htmlparser2';
import postcss from 'postcss';
import { inspectRaster, MAX_SVG_BYTES } from '../lib/image-input';

function checkCss(css: string): void {
  if (css.includes('\\')) throw Error('CSS escapes are not accepted in SVG.');
  const root = postcss.parse(css);
  root.walkAtRules((rule) => {
    if (/(?:^|-)keyframes$/i.test(rule.name)) throw Error('Animated SVGs are not accepted.');
  });
  root.walkDecls((decl) => {
    for (const match of decl.value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi))
      if (!match[2]?.trim().startsWith('#'))
        throw Error('SVG CSS URLs must reference a local fragment.');
    if (/^(?:-[a-z]+-)?(?:animation|transition)(?:-|$)/i.test(decl.prop))
      throw Error('Animated SVGs are not accepted.');
  });
}

export function checkStaticSvg(bytes: Uint8Array): void {
  let styleDepth = 0;
  let css = '';
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const local = name.toLowerCase().split(':').at(-1);
        if (
          [
            'animate',
            'animatemotion',
            'animatetransform',
            'animatecolor',
            'set',
            'discard',
          ].includes(local ?? '')
        )
          throw Error('Animated SVGs are not accepted.');
        if (local === 'style') styleDepth++;
        for (const [name, value] of Object.entries(attributes)) {
          if (name.toLowerCase() === 'style') checkCss(`svg{${value}}`);
          if (name.toLowerCase().split(':').at(-1) !== 'href' || !/^data:/i.test(value.trim()))
            continue;
          const match = /^data:image\/(png|jpeg);base64,([a-z0-9+/=\s]+)$/i.exec(value.trim());
          if (!match?.[2]) throw Error('Embedded SVG images must be static PNG or JPEG.');
          const data = Uint8Array.from(atob(match[2].replace(/\s/g, '')), (c) => c.charCodeAt(0));
          const meta = inspectRaster(data);
          if (meta.type !== 'png' && meta.type !== 'jpg' && meta.type !== 'jpeg')
            throw Error('Embedded SVG images must be static PNG or JPEG.');
        }
      },
      ontext(value) {
        if (styleDepth) css += value;
      },
      onclosetag(name) {
        if (name.toLowerCase().split(':').at(-1) === 'style') {
          styleDepth--;
          checkCss(css);
          css = '';
        }
      },
    },
    { xmlMode: true, decodeEntities: true }
  );
  parser.end(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function sanitizeStaticSvg(bytes: Uint8Array): Promise<Uint8Array> {
  if (!bytes.length || bytes.length > MAX_SVG_BYTES) throw Error('SVG must be at most 2 MiB.');
  checkStaticSvg(bytes);
  const { sanitizeSvg } = await import('@zeropress/svg-hush/workerd');
  const sanitized = sanitizeSvg(bytes);
  if (sanitized.length > 4 * 1024 * 1024) throw Error('Sanitized SVG exceeds 4 MiB.');
  checkStaticSvg(sanitized);
  return sanitized;
}
