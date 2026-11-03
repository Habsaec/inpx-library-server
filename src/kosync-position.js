/**
 * KOReader xpointer ↔ reader v4 text anchor for FB2 (KOSync position bridge, src/routes/kosync.js).
 *
 * The web / Android reader (Foliate `fb2.js`) shows the first <body> as one section (index 0) and
 * anchors a position as `textOffset` into that section's text with whitespace runs collapsed
 * (`normalizedSectionText` in foliate `view.js`) + a 96-char `textQuote`. KOReader (crengine) keeps
 * the FB2 tree as is and stores `/FictionBook/body/section[3]/p[12]/text().5`.
 *
 * `scanFb2Body` walks the FB2 source once and rebuilds the reader's section text by the same rules
 * as Foliate's converter (which elements keep their text, stanza verses appended at the stanza end),
 * so offsets agree; the quote lets the reader re-find the spot within ±2000 chars anyway.
 * Generated xpointers point at the start of a block (paragraph / verse) and always carry explicit
 * `[n]` indexes — both crengine parsers (V1 and normalized V2) accept that form.
 */

const WS_RE = /[\t\n\f\r ]+/g;
const STYLE_NAMES = new Set(['strong', 'emphasis', 'style', 'strikethrough', 'sub', 'sup', 'code', 'a']);
/** Elements a generated xpointer may point at (text blocks). */
const BLOCK_NAMES = new Set(['p', 'v', 'subtitle', 'text-author', 'date', 'td', 'th']);
const BOXING_NAMES = new Set(['autoBoxing', 'floatBoxing', 'inlineBox', 'pseudoElem']);
const QUOTE_LENGTH = 96;
const QUOTE_SEARCH_WINDOW = 2000;

/**
 * Foliate FB2Converter defs (BODY, SECTION, STYLE, POEM, TABLE, stanza) as kinds: which child
 * keeps its text. `null` drops the element with its whole subtree.
 */
function childKind(kind, name) {
  switch (kind) {
    case 'BODY':
      if (name === 'title') return 'TITLE';
      return name === 'epigraph' || name === 'section' ? 'SECTION' : null;
    case 'SECTION':
      if (name === 'title') return 'TITLE';
      if (name === 'epigraph' || name === 'section' || name === 'cite') return 'SECTION';
      if (name === 'annotation') return 'TEXT_ONLY';
      if (name === 'p' || name === 'subtitle' || name === 'text-author') return 'STYLE';
      if (name === 'poem') return 'POEM';
      if (name === 'table') return 'TABLE';
      return null;
    case 'TITLE':
    case 'STANZA_TITLE':
      return name === 'p' ? 'STYLE' : null;
    case 'STYLE':
      return STYLE_NAMES.has(name) ? 'STYLE' : null;
    case 'POEM':
      if (name === 'epigraph') return 'SECTION';
      if (name === 'subtitle' || name === 'text-author' || name === 'date') return 'STYLE';
      return name === 'stanza' ? 'STANZA' : null;
    case 'STANZA':
      if (name === 'title') return 'STANZA_TITLE';
      if (name === 'subtitle') return 'STYLE';
      return name === 'v' ? 'V' : null;
    case 'TABLE':
      return name === 'tr' ? 'TR' : null;
    case 'TR':
      return name === 'td' || name === 'th' ? 'STYLE' : null;
    case 'V':
      return 'V';
    case 'OUT':
      return name === 'body' ? 'BODY' : 'OUT';
    default:
      return null;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e] ?? m;
  });
}

/** Text stream with whitespace collapsed like Foliate (`[\t\n\f\r ]+` → ' ', trimmed). */
class NormalizedText {
  constructor() {
    this.parts = [];
    this.length = 0;
    this.pendingSpace = false;
  }
  /** Offset the next non-space character will get. */
  get next() {
    return this.length + (this.pendingSpace && this.length > 0 ? 1 : 0);
  }
  push(raw) {
    if (!raw) return;
    let s = raw.replace(WS_RE, ' ');
    const leading = s[0] === ' ';
    const trailing = s.length > 1 && s[s.length - 1] === ' ';
    s = s.slice(leading ? 1 : 0, trailing ? -1 : undefined);
    if (leading && this.length > 0) this.pendingSpace = true;
    if (s) {
      if (this.pendingSpace) s = ` ${s}`;
      this.pendingSpace = false;
      this.parts.push(s);
      this.length += s.length;
    }
    if (trailing && this.length > 0) this.pendingSpace = true;
  }
  toString() {
    const s = this.parts.join('');
    this.parts = [s];
    return s;
  }
}

/**
 * One pass over the first <body> of an FB2 string.
 * visitor.open(entry, offset) / visitor.close(entry, startOffset, endOffset) / visitor.text(entry, raw, offset)
 * (`entry` = { name, idx, kind, parent }, `offset` = index into the reader's section text).
 * Returns `{ text }` — the reader section text — or null when there is no <body>.
 */
export function scanFb2Body(xml, visitor = {}) {
  const src = String(xml || '');
  const out = new NormalizedText();
  const rootCounts = new Map();
  const stack = [];
  let seenBody = false;
  let pos = 0;

  const openElement = (name, selfClosing) => {
    const parent = stack[stack.length - 1] || null;
    const counts = parent ? parent.counts : rootCounts;
    const idx = (counts.get(name) || 0) + 1;
    counts.set(name, idx);
    let kind;
    if (!parent) kind = 'OUT';
    else if (parent.kind === 'OUT') kind = name === 'body' && !seenBody ? 'BODY' : 'OUT';
    else kind = childKind(parent.kind, name);
    if (kind === 'BODY') seenBody = true;
    const entry = {
      name, idx, kind, parent, counts: new Map(),
      start: out.next, stanza: kind === 'STANZA' ? [] : null,
      verse: kind === 'V' ? (parent.kind === 'V' ? parent.verse : { entry: null, text: '' }) : null,
    };
    if (kind === 'V' && parent.kind !== 'V') {
      entry.verse.entry = entry;
      findStanza(entry)?.stanza.push(entry.verse);
    }
    stack.push(entry);
    visitor.open?.(entry, entry.start);
    if (selfClosing) closeElement();
  };

  const findStanza = (entry) => {
    for (let e = entry.parent; e; e = e.parent) if (e.kind === 'STANZA') return e;
    return null;
  };

  const closeElement = () => {
    const entry = stack.pop();
    if (!entry) return false;
    if (entry.stanza) {
      // Foliate: `v` lines are appended after the stanza's other children, with no separator.
      for (const verse of entry.stanza) {
        const start = out.next;
        out.push(verse.text);
        verse.entry.start = start;
        visitor.close?.(verse.entry, start, out.length);
      }
    }
    if (entry.kind !== 'V') visitor.close?.(entry, entry.start, out.length);
    // Text after the first body is not part of the reader section.
    return entry.kind === 'BODY';
  };

  const onText = (raw) => {
    const entry = stack[stack.length - 1];
    if (!entry || !raw) return;
    const kind = entry.kind;
    if (!kind || kind === 'OUT' || kind === 'BODY') return;
    const text = decodeEntities(raw);
    if (kind === 'V') {
      entry.verse.text += text;
      visitor.text?.(entry, text, -1);
      return;
    }
    visitor.text?.(entry, text, out.next);
    out.push(text);
  };

  while (pos < src.length) {
    const lt = src.indexOf('<', pos);
    if (lt < 0) break;
    if (lt > pos && seenBody) onText(src.slice(pos, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      pos = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const stop = end < 0 ? src.length : end;
      // CDATA text is literal (no entity decoding), like DOM textContent.
      const entry = stack[stack.length - 1];
      if (seenBody && entry?.kind && entry.kind !== 'OUT' && entry.kind !== 'BODY') {
        const text = src.slice(lt + 9, stop);
        if (entry.kind === 'V') entry.verse.text += text;
        else out.push(text);
      }
      pos = end < 0 ? src.length : end + 3;
      continue;
    }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) break;
    const tag = src.slice(lt + 1, gt);
    pos = gt + 1;
    if (tag[0] === '?' || tag[0] === '!') continue;
    if (tag[0] === '/') {
      if (closeElement()) break;
      continue;
    }
    const m = /^([^\s/>]+)/.exec(tag);
    if (!m) continue;
    openElement(m[1], tag.endsWith('/'));
  }
  if (!seenBody) return null;
  return { text: out.toString() };
}

function entryPath(entry) {
  const segs = [];
  for (let e = entry; e; e = e.parent) segs.push(`${e.name}[${e.idx}]`);
  return `/${segs.reverse().join('/')}`;
}

/**
 * `/FictionBook/body/section[2]/p[5]/text().12` → { steps: [[name, idx]…], textIndex, textOffset }.
 * Boxing elements crengine may insert are skipped. Null when the string is not an element path.
 */
export function parseXPointer(xpointer) {
  const s = String(xpointer || '').trim();
  if (!s.startsWith('/') || s.length > 2000) return null;
  const steps = [];
  let textIndex = null;
  let textOffset = null;
  const parts = s.slice(1).split('/');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const text = /^text\(\)(?:\[(\d+)\])?(?:\.(\d+))?$/.exec(part);
    if (text) {
      if (i !== parts.length - 1) return null;
      textIndex = text[1] ? Number(text[1]) : 1;
      textOffset = text[2] ? Number(text[2]) : 0;
      break;
    }
    const el = /^([^[\]/.()]+)(?:\[(\d+)\])?(?:\.\d+)?$/.exec(part);
    if (!el) return null;
    if (BOXING_NAMES.has(el[1])) continue;
    steps.push([el[1], el[2] ? Math.max(1, Number(el[2])) : 1]);
  }
  return steps.length ? { steps, textIndex, textOffset } : null;
}

/** Like the reader's own quote: the next 96 characters, across block ends (a short «Да.» repeats). */
function quoteAt(text, offset) {
  return text.slice(offset, offset + QUOTE_LENGTH);
}

/**
 * KOReader xpointer → reader v4 anchor
 * `{ sectionIndex: 0, textOffset, textQuote, textSectionLength, fraction }`, or null when the
 * xpointer is not inside the first body of this FB2 (notes body, another format, stale path).
 */
export function fb2XPointerToAnchor(xml, xpointer) {
  const parsed = parseXPointer(xpointer);
  if (!parsed) return null;
  const target = parsed.steps;
  if (target.length < 2 || target[0][0] !== 'FictionBook' || target[1][0] !== 'body' || target[1][1] !== 1) return null;
  let found = null;
  let textNodes = 0;
  const matches = (entry) => {
    let e = entry;
    for (let i = target.length - 1; i >= 0; i--, e = e.parent) {
      if (!e || e.name !== target[i][0] || e.idx !== target[i][1]) return false;
    }
    return !e;
  };
  const scan = scanFb2Body(xml, {
    open(entry, offset) {
      if (found || entry.kind === 'OUT' || !matches(entry)) return;
      // Inside <emphasis>, <a>…: the paragraph around it bounds the quote.
      let block = entry;
      while (STYLE_NAMES.has(block.name) && block.parent) block = block.parent;
      found = { entry, block, offset, blockStart: offset, end: -1, textAt: null };
    },
    text(entry, raw, offset) {
      if (!found || found.end >= 0 || entry !== found.entry || parsed.textIndex == null || found.textAt != null) return;
      if (!raw.trim()) return;
      textNodes++;
      if (textNodes === parsed.textIndex && offset >= 0) {
        found.textAt = offset + raw.slice(0, parsed.textOffset || 0).replace(WS_RE, ' ').trimStart().length;
      }
    },
    close(entry, start, end) {
      if (!found) return;
      if (entry === found.entry) found.offset = start;
      if (entry === found.block) {
        found.blockStart = start;
        found.end = end;
      }
    },
  });
  if (!scan || !found || !scan.text.length) return null;
  const { text } = scan;
  const blockEnd = found.end >= 0 ? found.end : text.length;
  let offset = found.textAt != null ? Math.min(found.textAt, Math.max(found.offset, blockEnd - 1)) : found.offset;
  // Near the end of a paragraph the quote would be too short to re-find: anchor its start instead.
  if (blockEnd - offset < 16) offset = found.blockStart;
  offset = Math.max(0, Math.min(offset, text.length - 1));
  // `<p> Text` / `<p>&#160;Text` (leading space in the paragraph): anchor the first letter.
  while (offset + 1 < Math.min(text.length, blockEnd) && /\s/.test(text[offset])) offset++;
  return {
    sectionIndex: 0,
    textOffset: offset,
    textQuote: quoteAt(text, offset),
    textSectionLength: text.length,
    fraction: text.length ? offset / text.length : 0,
    blockStart: found.blockStart,
    blockEnd,
  };
}

/**
 * Reader position → KOReader xpointer of the block at that spot: `{ xpointer, fraction }` or null.
 * `textOffset` (+ `textQuote`, re-found within ±2000 chars like the reader does) wins; otherwise
 * `fraction` of the section text.
 */
export function fb2AnchorToXPointer(xml, { textOffset = null, textQuote = '', fraction = null } = {}) {
  const blocks = [];
  const scan = scanFb2Body(xml, {
    close(entry, start, end) {
      if (BLOCK_NAMES.has(entry.name) && entry.kind && end > start) blocks.push({ start, end, entry });
    },
  });
  if (!scan || !scan.text.length || !blocks.length) return null;
  const { text } = scan;
  let offset;
  if (Number.isInteger(textOffset) && textOffset >= 0) {
    offset = Math.min(textOffset, text.length - 1);
    const quote = String(textQuote || '').replace(WS_RE, ' ').trim();
    if (quote && text.slice(offset, offset + quote.length) !== quote) {
      const nearby = text.indexOf(quote, Math.max(0, offset - QUOTE_SEARCH_WINDOW));
      if (nearby >= 0 && nearby <= offset + QUOTE_SEARCH_WINDOW) offset = nearby;
    }
  } else if (Number.isFinite(Number(fraction)) && Number(fraction) > 0) {
    offset = Math.min(text.length - 1, Math.round(Math.min(1, Number(fraction)) * text.length));
  } else {
    return null;
  }
  // Blocks close in document order (verses at their stanza end), so sort by start.
  blocks.sort((a, b) => a.start - b.start);
  let block = null;
  for (const b of blocks) {
    if (b.start <= offset && offset < b.end) block = b;
    else if (b.start > offset) {
      block ??= b;
      break;
    }
  }
  block ??= blocks[blocks.length - 1];
  return { xpointer: entryPath(block.entry), fraction: text.length ? block.start / text.length : 0 };
}

/**
 * FB2 bytes → string the way the reader does (foliate `fb2.js` parseXML): the declared encoding,
 * whatever it is (windows-1252, koi8-r…), UTF-8 when absent or unknown.
 */
export function decodeFb2LikeReader(buffer) {
  const head = buffer.subarray(0, 200).toString('latin1');
  const encoding = /^<\?xml\s+version\s*=\s*["']1.\d+"\s+encoding\s*=\s*["']([A-Za-z0-9._-]*)["']/.exec(head)?.[1];
  if (encoding && encoding.toLowerCase() !== 'utf-8') {
    try {
      return new TextDecoder(encoding).decode(buffer);
    } catch { /* unknown label: UTF-8 like the reader */ }
  }
  return new TextDecoder('utf-8').decode(buffer);
}

/** Cut an FB2 string after its first </body>: the reader section never needs notes or binaries. */
export function truncateFb2AfterFirstBody(xml) {
  const s = String(xml || '');
  const end = s.indexOf('</body>');
  return end < 0 ? s : s.slice(0, end + 7);
}
