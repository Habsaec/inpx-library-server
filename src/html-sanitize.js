/**
 * Shared HTML fragment helpers for Flibusta sidecar / templates.
 * Keeps sanitizers free of circular imports with templates/shared.js.
 */

const VOID_HTML_TAGS = new Set(['br', 'hr', 'img']);

const REAL_MARKUP_RE = /<\/?[a-z][^>]*>/i;
/** Flibusta `etc/annotations.7z` stores the annotation as XML text: `&lt;p&gt;…&lt;/p&gt;`. */
const ESCAPED_MARKUP_RE = /&(?:amp;)*(?:lt|#60|#x3c);\s*\/?[a-z]/i;

function decodeXmlEntitiesOnce(value) {
  return String(value)
    .replace(/&#(\d+);/g, (all, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    })
    .replace(/&#x([0-9a-f]+);/gi, (all, hex) => {
      const code = parseInt(hex, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * Turn a fully entity-encoded fragment into real tags.
 * Leaves markup that already contains real tags untouched, so an intentional
 * `&lt;` inside HTML stays escaped.
 */
export function unwrapEscapedMarkup(html) {
  let s = String(html || '');
  if (!s || !ESCAPED_MARKUP_RE.test(s)) return s;
  for (let i = 0; i < 2; i++) {
    if (REAL_MARKUP_RE.test(s) || !ESCAPED_MARKUP_RE.test(s)) break;
    const next = decodeXmlEntitiesOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Cached annotations may store Flibusta markup still entity-encoded. */
export function normalizeCachedAnnotation(annotation, annotationIsHtml = false) {
  const raw = String(annotation || '');
  const text = unwrapEscapedMarkup(raw);
  const gainedTags = text !== raw && REAL_MARKUP_RE.test(text);
  const isHtml = Boolean(annotationIsHtml) || gainedTags;
  return { annotation: isHtml ? text : raw, annotationIsHtml: isHtml };
}

/**
 * Flibusta/FLibrary author & annotation markup uses image slots like:
 *   [float=right]$$0$$[/float]
 *   $$0$$
 * Portrait is rendered separately from etc/authors/pictures — strip these
 * placeholders so they never appear as literal text in bio HTML.
 */
export function stripFlibustaMediaPlaceholders(html) {
  let s = String(html || '');
  if (!s) return '';
  /*
   * Image slots from Flibusta author HTML / BBCode:
   *   $$0$$, $$1$$
   *   $$somefile.jpg$$
   *   [float=right]$$0$$[/float]
   * Portrait is shown separately — never leave these as visible text.
   */
  const slot = '\\$\\$[^$\\r\\n]{1,200}\\$\\$';
  s = s.replace(new RegExp(`\\[(?:float|img|photo|pic)(?:=[^\\]]*)?\\]\\s*${slot}\\s*\\[\\/(?:float|img|photo|pic)\\]`, 'gi'), '');
  s = s.replace(new RegExp(slot, 'g'), '');
  /* Empty / orphan float-style BBCode left after slot removal */
  s = s.replace(/\[(?:float|img|photo|pic)(?:=[^\]]*)?\]\s*\[\/(?:float|img|photo|pic)\]/gi, '');
  s = s.replace(/\[\/?(?:float|img|photo|pic)(?:=[^\]]*)?\]/gi, '');
  /* Collapse leftover leading breaks from a removed right-float portrait */
  s = s.replace(/^(?:\s*<br\s*\/?\s*>)+/i, '');
  s = s.replace(/(?:<br\s*\/?\s*>\s*){3,}/gi, '<br><br>');
  return s.trim();
}

/**
 * Append missing closing tags so an unclosed <a href> from Flibusta bio
 * cannot wrap later page controls (favorite / sort).
 */
export function balanceHtmlFragment(html) {
  const s = String(html || '');
  if (!s) return '';
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  while ((m = re.exec(s))) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    if (VOID_HTML_TAGS.has(tag) || /\/\s*>$/.test(full)) continue;
    if (full.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === tag) {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }
    stack.push(tag);
  }
  if (!stack.length) return s;
  let out = s;
  for (let i = stack.length - 1; i >= 0; i--) {
    out += `</${stack[i]}>`;
  }
  return out;
}

/* ---------- BB-codes in annotations (Flibusta / Librusec / RuTracker texts) ---------- */

const BBCODE_NAMES = 'b|i|u|s|del|quote|spoiler|hide|url|center|left|right|justify|color|size|font|list|\\*';
const BBCODE_TAG_RE = new RegExp(`\\[\\/?(?:${BBCODE_NAMES})(?:=[^\\]\\r\\n]{0,200})?\\]`, 'i');
const BBCODE_SAFE_URL_RE = /^https?:\/\/[^\s"'<>[\]]+$/i;
const BBCODE_MAX_PASSES = 4;

function escapeBbText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Spoiler / quote titles become plain text: no tags, no quotes. */
function bbTitleText(value, fallback) {
  // `=` as an entity: sanitizeHtml strips `on…=` handlers even from text and would eat the closing tag.
  const s = String(value || '').replace(/<[^>]*>/g, '').replace(/["<>]/g, '').replace(/=/g, '&#61;').trim();
  return s || fallback;
}

function bbLink(href, text) {
  // Plain-text annotations were escaped already; sanitizeHtml escapes the href again.
  const url = String(href || '').trim().replace(/&amp;/g, '&');
  if (!BBCODE_SAFE_URL_RE.test(url)) return text;
  return `<a href="${url}">${text || url}</a>`;
}

/** Repeat a replacement until the text stops changing, so nested pairs ([b][i]…[/i][/b]) all convert. */
function replaceNested(s, re, fn) {
  let out = s;
  for (let i = 0; i < BBCODE_MAX_PASSES; i++) {
    const next = out.replace(re, fn);
    if (next === out) break;
    out = next;
  }
  return out;
}

export function hasBbCode(text) {
  return BBCODE_TAG_RE.test(String(text || ''));
}

/**
 * BB-codes → HTML for book annotations: [b] [i] [u] [s]/[del], [quote(=who)], [spoiler(=title)] → <details>,
 * [url(=…)] (http/https only), [list][*]; [color] [size] [font] [center] … keep only their text.
 * Plain text is HTML-escaped first; an HTML annotation keeps its markup. The result is still raw
 * HTML — callers render it through sanitizeHtml (server) / sanitizeHtml.ts (Android), which allow
 * only the produced tags and rebuild every <a href>.
 * → { annotation, annotationIsHtml } (unchanged when there is no BB-code).
 */
export function annotationBbCodeToHtml(annotation, annotationIsHtml = false) {
  const raw = String(annotation || '');
  if (!raw || !hasBbCode(raw)) return { annotation: raw, annotationIsHtml: Boolean(annotationIsHtml) };
  let s = annotationIsHtml
    ? unwrapEscapedMarkup(raw)
    : escapeBbText(raw).replace(/\r\n?/g, '\n').trim().replace(/\n/g, '<br>');

  s = replaceNested(s, /\[(spoiler|hide)(?:=([^\]\r\n]{0,200}))?\]([\s\S]*?)\[\/\1\]/gi,
    (_m, _tag, title, body) => `<details><summary>${bbTitleText(title, 'Спойлер')}</summary><div>${body.trim()}</div></details>`);
  s = replaceNested(s, /\[quote(?:=([^\]\r\n]{0,200}))?\]([\s\S]*?)\[\/quote\]/gi,
    (_m, who, body) => `<blockquote>${who ? `<p><strong>${bbTitleText(who, '')}:</strong></p>` : ''}${body.trim()}</blockquote>`);
  s = replaceNested(s, /\[list(?:=[^\]\r\n]{0,20})?\]([\s\S]*?)\[\/list\]/gi, (_m, body) => {
    const items = body.split(/\[\*\]/).map((x) => x.replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, '')).filter(Boolean);
    return items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '';
  });
  const inline = { b: 'strong', i: 'em', u: 'u', s: 's', del: 's' };
  s = replaceNested(s, /\[(b|i|u|s|del)\]([\s\S]*?)\[\/\1\]/gi,
    (_m, tag, body) => `<${inline[tag.toLowerCase()]}>${body}</${inline[tag.toLowerCase()]}>`);
  s = s.replace(/\[url=([^\]\r\n]{1,2000})\]([\s\S]*?)\[\/url\]/gi, (_m, href, text) => bbLink(href, text));
  s = s.replace(/\[url\]([^[\]\s]{1,2000})\[\/url\]/gi, (_m, href) => bbLink(href, ''));
  // Layout-only tags: keep the text. Then drop any unpaired leftover of a known tag.
  s = s.replace(new RegExp(`\\[\\/?(?:${BBCODE_NAMES})(?:=[^\\]\\r\\n]{0,200})?\\]`, 'gi'), '');
  return { annotation: s, annotationIsHtml: true };
}
