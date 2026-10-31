/** Shared reading-position LWW + cross-device prompt helpers (reader.js, tests). */

export const READING_POSITION_SCALE = 1e6;
export const PROGRESS_PERCENT_SCALE = 1e4;

export const IDLE_MS = 4 * 60 * 1000;
export const POSITION_SESSION_ID_MAX = 128;

export function parseSyncTs(iso) {
  if (!iso) return 0;
  const raw = String(iso).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) {
    const ts = Date.parse(`${raw.replace(' ', 'T')}Z`);
    return Number.isFinite(ts) ? ts : 0;
  }
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : 0;
}

export function normalizeSessionId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > POSITION_SESSION_ID_MAX) return null;
  return id;
}

export function sessionStatusFromActivityAt(lastUserActivityAt, nowMs = Date.now()) {
  const ts = parseSyncTs(lastUserActivityAt);
  if (!ts) return 'idle';
  return (nowMs - ts) > IDLE_MS ? 'idle' : 'active';
}

export const USER_POSITION_SAVE_REASONS = Object.freeze(['page', 'snap', 'scroll', 'navigation']);

export function isUserPositionSaveReason(reason) {
  return USER_POSITION_SAVE_REASONS.includes(String(reason || ''));
}

/** Stale CAS may overwrite if the holder is a different, idle session. */
export function shouldIdleSteal(current, incomingSessionId, nowMs = Date.now()) {
  const incoming = normalizeSessionId(incomingSessionId);
  if (!incoming) return false;
  const holder = normalizeSessionId(current?.sessionId);
  if (!holder || holder === incoming) return false;
  return sessionStatusFromActivityAt(current?.lastUserActivityAt, nowMs) === 'idle';
}

/**
 * Matching-revision CAS may take over only if the writer is legacy (no sessionId),
 * the same session, or the holder is idle. A different active session cannot overwrite.
 */
export function canOverwriteHolder(current, incomingSessionId, nowMs = Date.now()) {
  const incoming = normalizeSessionId(incomingSessionId);
  if (!incoming) return true;
  const holder = normalizeSessionId(current?.sessionId);
  if (!holder || holder === incoming) return true;
  return sessionStatusFromActivityAt(current?.lastUserActivityAt, nowMs) === 'idle';
}

export function normalizeReadingFraction(fraction) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  return Math.round(f * READING_POSITION_SCALE) / READING_POSITION_SCALE;
}

export function progressToFraction(progress) {
  return normalizeReadingFraction(Number(progress) / 100);
}

export function fractionToProgress(fraction) {
  return Math.round(normalizeReadingFraction(fraction) * 100 * PROGRESS_PERCENT_SCALE) / PROGRESS_PERCENT_SCALE;
}

/** FB2 href: section index + optional #block id (Foliate). */
export function parseFb2HrefParts(href) {
  const h = String(href || '').trim();
  if (!h) return { section: NaN, blockId: null };
  const hashPos = h.indexOf('#');
  const section = Number(hashPos === -1 ? h : h.slice(0, hashPos));
  const blockRaw = hashPos === -1 ? '' : h.slice(hashPos + 1);
  const blockId = blockRaw === '' ? null : Number(blockRaw);
  return {
    section,
    blockId: Number.isFinite(blockId) ? blockId : null,
  };
}

export function isFb2HrefFormat(href) {
  const { section, blockId } = parseFb2HrefParts(href);
  if (!Number.isFinite(section)) return false;
  if (blockId != null && !Number.isFinite(blockId)) return false;
  return true;
}

export function compareFb2Hrefs(a, b) {
  const pa = parseFb2HrefParts(a);
  const pb = parseFb2HrefParts(b);
  if (!Number.isFinite(pa.section) || !Number.isFinite(pb.section)) return 0;
  if (pa.section !== pb.section) return pa.section - pb.section;
  const ba = pa.blockId ?? 0;
  const bb = pb.blockId ?? 0;
  return ba - bb;
}

/**
 * Fraction aligned with fb2Href (section#block). Prefers flat TOC; interpolates within section.
 * @param {string} href
 * @param {string[]} [tocHrefs] flat TOC href list
 */
export function fractionFromFb2HrefWithToc(href, tocHrefs) {
  if (!isFb2HrefFormat(href)) return null;
  const flatToc = Array.isArray(tocHrefs) ? tocHrefs.map((t) => String(t || '')) : [];
  if (flatToc.length >= 2) {
    const exactIdx = flatToc.findIndex((h) => h === href);
    if (exactIdx >= 0) return normalizeReadingFraction(exactIdx / flatToc.length);

    const { section, blockId } = parseFb2HrefParts(href);
    const sectionEntries = [];
    for (let i = 0; i < flatToc.length; i++) {
      const p = parseFb2HrefParts(flatToc[i]);
      if (p.section === section) sectionEntries.push({ idx: i, blockId: p.blockId });
    }
    if (sectionEntries.length > 0) {
      if (blockId != null) {
        const withBlocks = sectionEntries
          .filter((e) => e.blockId != null)
          .sort((a, b) => a.blockId - b.blockId);
        if (withBlocks.length > 0) {
          let chosen = withBlocks[0];
          for (const e of withBlocks) {
            if (e.blockId <= blockId) chosen = e;
            else break;
          }
          let frac = chosen.idx / flatToc.length;
          const next = withBlocks.find((e) => e.blockId > blockId);
          if (next && chosen.blockId < blockId) {
            const span = (next.idx - chosen.idx) / flatToc.length;
            const blockSpan = next.blockId - chosen.blockId;
            frac += span * ((blockId - chosen.blockId) / blockSpan);
          } else if (!next && chosen.blockId < blockId) {
            frac += 0.5 / flatToc.length;
          }
          return normalizeReadingFraction(frac);
        }
      }
      return normalizeReadingFraction(Math.min(...sectionEntries.map((e) => e.idx)) / flatToc.length);
    }
  }
  return null;
}

/** Effective fraction for display/sync — stored fraction only (never TOC interpolation). */
export function effectiveSavedFraction(saved, _tocHrefs) {
  return savedFraction(saved);
}

const CHAPTER_LABEL_MAX = 60;

function trimChapterLabel(label) {
  const s = String(label || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > CHAPTER_LABEL_MAX ? `${s.slice(0, CHAPTER_LABEL_MAX - 1)}…` : s;
}

/**
 * Нормализовать flat TOC к [{ href, label, startFraction }] (в порядке чтения).
 * `startFraction` (доля по объёму текста) — если читалка её передала; иначе null.
 * Принимает массив строк-href или объектов.
 */
function normalizeFlatTocEntries(flatToc) {
  if (!Array.isArray(flatToc)) return [];
  return flatToc
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        const finiteOrNull = (value) => {
          if (value == null || value === '') return null;
          const number = Number(value);
          return Number.isFinite(number) ? number : null;
        };
        const sf = finiteOrNull(entry.startFraction);
        const sectionStartFraction = finiteOrNull(entry.sectionStartFraction);
        const sectionFraction = finiteOrNull(entry.sectionFraction);
        const sectionTextLength = finiteOrNull(entry.sectionTextLength);
        return {
          href: String(entry.href || '').trim(),
          label: String(entry.label || '').trim(),
          startFraction: sf,
          sectionIndex: entry.sectionIndex == null || entry.sectionIndex === ''
            ? null
            : Number(entry.sectionIndex),
          textOffset: entry.textOffset == null || entry.textOffset === ''
            ? null
            : Number(entry.textOffset),
          sectionStartFraction,
          sectionFraction,
          sectionTextLength,
        };
      }
      return {
        href: String(entry || '').trim(),
        label: '',
        startFraction: null,
        sectionIndex: null,
        textOffset: null,
        sectionStartFraction: null,
        sectionFraction: null,
        sectionTextLength: null,
      };
    })
    .filter((e) => e.href !== '' || e.label !== '');
}

/**
 * Название главы из оглавления для позиции.
 * Для названия главы приоритет у FB2 TOC href, который Foliate определил в момент
 * сохранения. Текстовый якорь отвечает за переход, но сам по себе не является
 * названием главы. Fallback — textOffset, затем общий fraction.
 */
export function tocChapterLabelForPosition(saved, flatToc) {
  const entries = normalizeFlatTocEntries(flatToc);
  if (entries.length === 0 || !entries.some((e) => e.label)) return '';

  const labelBeforeIndex = (idx) => {
    for (let i = Math.min(idx, entries.length - 1); i >= 0; i--) {
      if (entries[i].label) return entries[i].label;
    }
    return '';
  };

  const frac = savedFraction(saved);

  // 1) Название главы, которое Foliate сохранил вместе с точной позицией.
  const href = String(saved?.fb2Href || saved?.position || '').trim();
  if (isFb2HrefFormat(href)) {
    let bestIdx = -1;
    for (let i = 0; i < entries.length; i++) {
      if (!isFb2HrefFormat(entries[i].href)) continue;
      if (compareFb2Hrefs(entries[i].href, href) <= 0) bestIdx = i;
    }
    if (bestIdx >= 0) {
      const label = labelBeforeIndex(bestIdx);
      if (label) return label;
    }
  }

  // 2) Текстовый якорь для записей без сохранённого TOC href.
  const sectionIndex = Number(saved?.sectionIndex);
  const textOffset = Number(saved?.textOffset);
  if (Number.isFinite(sectionIndex) && Number.isFinite(textOffset)) {
    let bestIdx = -1;
    let bestOffset = -1;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].sectionIndex !== sectionIndex || !Number.isFinite(entries[i].textOffset)) continue;
      if (entries[i].textOffset <= textOffset && entries[i].textOffset >= bestOffset) {
        bestIdx = i;
        bestOffset = entries[i].textOffset;
      }
    }
    if (bestIdx >= 0) {
      const label = labelBeforeIndex(bestIdx);
      if (label) return label;
    }
  }

  // 3) Size-aware общий fraction — резерв для старых записей без точного якоря.
  if (frac > 0 && entries.some((e) => Number.isFinite(e.startFraction))) {
    let bestIdx = -1;
    for (let i = 0; i < entries.length; i++) {
      if (Number.isFinite(entries[i].startFraction) && entries[i].startFraction <= frac + 1e-9) bestIdx = i;
    }
    if (bestIdx >= 0) {
      const label = labelBeforeIndex(bestIdx);
      if (label) return label;
    }
  }

  // 4) Грубая оценка по индексу (последний резерв).
  if (frac > 0) {
    const idx = Math.min(entries.length - 1, Math.max(0, Math.floor(frac * entries.length)));
    const label = labelBeforeIndex(idx);
    if (label) return label;
  }
  return '';
}

export function formatPositionDetail(meta) {
  if (!meta) return '';
  const chapter = trimChapterLabel(meta.chapterLabel);
  if (chapter) return chapter;
  if (meta.paginatorPage != null && meta.paginatorPages != null) {
    return `стр. ${meta.paginatorPage} из ${meta.paginatorPages}`;
  }
  if (meta.sectionIndex != null && Number.isFinite(Number(meta.sectionIndex))) {
    return `раздел ${Number(meta.sectionIndex) + 1}`;
  }
  const href = String(meta.fb2Href || '').trim();
  if (href && isFb2HrefFormat(href)) return `глава ${href}`;
  const pos = String(meta.position || '').trim();
  if (/^(?:app:)?ch\d+(?::p\d+)?$/i.test(pos)) {
    return `глава ${pos.replace(/^app:/i, '')}`;
  }
  if (isFb2HrefFormat(pos)) return `глава ${pos}`;
  return '';
}

/** Метаданные для подписи в диалоге; название главы берём из TOC, иначе оценка по доле. */
export function resolvePositionDisplayMeta(saved, flatToc) {
  const toc = normalizeFlatTocEntries(flatToc);
  const meta = {
    fb2Href: saved?.fb2Href ?? null,
    position: saved?.position ?? null,
    paginatorPage: saved?.paginatorPage ?? null,
    paginatorPages: saved?.paginatorPages ?? null,
    sectionIndex: saved?.sectionIndex ?? null,
  };
  const sectionIndex = Number(saved?.sectionIndex);
  const textOffset = Number(saved?.textOffset);
  const textSectionLength = Number(saved?.textSectionLength);
  if (Number.isFinite(sectionIndex) && Number.isFinite(textOffset)) {
    const section = toc.find((entry) => (
      entry.sectionIndex === sectionIndex
      && Number.isFinite(entry.sectionStartFraction)
      && Number.isFinite(entry.sectionFraction)
    ));
    const length = Number.isFinite(textSectionLength) && textSectionLength > 0
      ? textSectionLength
      : section?.sectionTextLength;
    if (section && Number.isFinite(length) && length > 0) {
      meta.canonicalFraction = normalizeReadingFraction(
        section.sectionStartFraction
        + section.sectionFraction * Math.max(0, Math.min(1, textOffset / length)),
      );
    }
  }
  const chapterLabel = tocChapterLabelForPosition(saved, flatToc);
  if (chapterLabel) {
    meta.chapterLabel = chapterLabel;
    return meta;
  }
  if (formatPositionDetail(meta)) return meta;
  const frac = savedFraction(saved);
  if (frac > 0.02 && toc.length >= 2) {
    const idx = Math.min(toc.length - 1, Math.max(0, Math.floor(frac * toc.length)));
    const href = String(toc[idx]?.href || '').trim();
    if (href) return { ...meta, fb2Href: href };
  }
  return meta;
}

export function formatPositionProgressLabel(fraction, _progress, meta) {
  const displayFraction = Number.isFinite(Number(meta?.canonicalFraction))
    ? Number(meta.canonicalFraction)
    : fraction;
  const frac = Number.isFinite(Number(displayFraction))
    ? normalizeReadingFraction(displayFraction)
    : progressToFraction(Number(_progress) || 0);
  const pct = Math.round(fractionToProgress(frac));
  const detail = formatPositionDetail(meta);
  return detail ? `${pct}% · ${detail}` : `${pct}%`;
}

export function buildCrossDevicePromptLines(localCtx, serverPos, flatToc) {
  const localFrac = savedFraction(localCtx);
  const serverFrac = savedFraction(serverPos);
  const localMeta = resolvePositionDisplayMeta(localCtx, flatToc);
  const serverMeta = resolvePositionDisplayMeta(serverPos, flatToc);
  return {
    localLine: formatPositionProgressLabel(localFrac, fractionToProgress(localFrac), localMeta),
    serverLine: formatPositionProgressLabel(serverFrac, fractionToProgress(serverFrac), serverMeta),
  };
}

export function hasMeaningfulServerPosition(input) {
  return (
    input.serverFraction > 0
    || (input.serverProgress ?? 0) > 0
    || Boolean(String(input.serverPosition || '').trim())
    || Boolean(String(input.serverFb2Href || '').trim())
    || (
      Number.isInteger(input.serverSectionIndex)
      && Number.isInteger(input.serverTextOffset)
    )
  );
}

export function hasMeaningfulLocalPosition(input) {
  return (
    input.localFraction > 0.02
    || Boolean(String(input.localPosition || '').trim())
    || Boolean(String(input.localFb2Href || '').trim())
    || (
      Number.isInteger(input.localSectionIndex)
      && Number.isInteger(input.localTextOffset)
    )
  );
}

export function positionsMeaningfullyDiffer(
  localFraction,
  localPosition,
  localFb2Href,
  serverFraction,
  serverPosition,
  serverFb2Href,
  localTextOffset,
  serverTextOffset,
  localSectionIndex,
  serverSectionIndex,
) {
  const lh = String(localFb2Href || '').trim();
  const sh = String(serverFb2Href || '').trim();
  const localHasTextAnchor =
    localSectionIndex != null
    && localTextOffset != null
    && Number.isInteger(Number(localSectionIndex))
    && Number(localSectionIndex) >= 0
    && Number.isInteger(Number(localTextOffset))
    && Number(localTextOffset) >= 0;
  const serverHasTextAnchor =
    serverSectionIndex != null
    && serverTextOffset != null
    && Number.isInteger(Number(serverSectionIndex))
    && Number(serverSectionIndex) >= 0
    && Number.isInteger(Number(serverTextOffset))
    && Number(serverTextOffset) >= 0;
  if (localHasTextAnchor || serverHasTextAnchor) {
    if (!localHasTextAnchor || !serverHasTextAnchor) return true;
    return Number(localSectionIndex) !== Number(serverSectionIndex)
      || Number(localTextOffset) !== Number(serverTextOffset);
  }
  if (Math.abs(localFraction - serverFraction) > 1e-5) return true;
  const lp = String(localPosition || '').trim();
  const sp = String(serverPosition || '').trim();
  if (lp && sp && lp !== sp) return true;
  if ((lh || sh) && lh !== sh) return true;
  return false;
}

export function serverEditUnseenOnThisClient(input) {
  const serverRev = parseSyncTs(input.serverPosUpdatedAt);
  const lastKnownServerRev = parseSyncTs(input.localServerPositionUpdatedAt);
  if (serverRev <= 0) return false;
  if (lastKnownServerRev <= 0) return hasMeaningfulServerPosition(input);
  return serverRev > lastKnownServerRev;
}

/** @deprecated Use serverEditUnseenOnThisClient (timestamp-only). */
export function serverPositionChangedSinceLastSync(input) {
  return serverEditUnseenOnThisClient(input);
}

/** LWW по времени: подтянуть с сервера, если его правка новее локальной. */
export function shouldUseServerPosition(input) {
  if (input.skipPosition) return false;

  const serverClearedPosition =
    input.serverProgress <= 0
    && !String(input.serverPosition || '').trim()
    && !String(input.serverFb2Href || '').trim()
    && parseSyncTs(input.localServerPositionUpdatedAt) > 0
    && !input.serverPosUpdatedAt
    && (input.localServerPositionProgress ?? 0) > 0;
  if (serverClearedPosition) return true;
  if (!hasMeaningfulServerPosition(input)) return false;

  // Пользователь явно отклонил именно эту серверную правку («Остаться здесь») —
  // не подтягивать её молча при последующей синхронизации.
  const serverUpdatedAt = input.serverPosUpdatedAt || '';
  if (serverUpdatedAt && serverUpdatedAt === (input.dismissedServerPositionUpdatedAt || '')) {
    return false;
  }

  const serverRev = parseSyncTs(input.serverPosUpdatedAt);
  const localRev = parseSyncTs(input.localPositionRev);
  return serverRev > localRev;
}

/** Диалог: локальная позиция при открытии; предложить серверную, если она отличается (вперёд/назад) и новее по времени или ещё не просмотрена. */
export function shouldShowCrossDevicePositionPrompt(input) {
  if (input.skipPosition) return false;
  if (!hasMeaningfulServerPosition(input)) return false;

  const serverUpdatedAt = input.serverPosUpdatedAt || '';
  if (serverUpdatedAt && serverUpdatedAt === (input.dismissedServerPositionUpdatedAt || '')) {
    return false;
  }

  if (!hasMeaningfulLocalPosition(input)) {
    return serverEditUnseenOnThisClient(input);
  }

  if (!positionsMeaningfullyDiffer(
    input.localFraction,
    input.localPosition,
    input.localFb2Href,
    input.serverFraction,
    input.serverPosition,
    input.serverFb2Href,
    input.localTextOffset,
    input.serverTextOffset,
    input.localSectionIndex,
    input.serverSectionIndex,
  )) {
    return false;
  }

  const localRev = parseSyncTs(input.localPositionRev);
  const serverRev = parseSyncTs(input.serverPosUpdatedAt);
  if (serverEditUnseenOnThisClient(input)) return true;
  if (localRev > serverRev) return true;
  return false;
}

/**
 * Deferred prompt in reader iframe after local restore.
 * When pendingCrossDevicePrompt was set by parent sync, trust it: snapshot write
 * sets serverPositionUpdatedAt to the new server rev, so shouldShowCrossDevicePositionPrompt
 * would treat the edit as already seen (localServerPositionUpdatedAt uses the same field).
 */
export function needsDeferredCrossDevicePromptFromStore(store) {
  if (store?.crossDeviceResolvedAt && !store?.pendingCrossDevicePrompt) return false;
  if (store?.pendingCrossDevicePrompt) {
    const serverUpdatedAt = store.serverPositionUpdatedAt || '';
    if (serverUpdatedAt && serverUpdatedAt === (store.dismissedServerPositionUpdatedAt || '')) {
      return false;
    }
    return true;
  }
  return shouldShowCrossDevicePositionPrompt(buildMergeInputFromOfflineStore(store));
}

export function savedFraction(saved) {
  const fraction = saved?.fraction;
  const hasExplicitFraction =
    fraction != null
    && !(typeof fraction === 'string' && fraction.trim() === '');
  if (hasExplicitFraction && Number.isFinite(Number(fraction))) {
    return normalizeReadingFraction(saved.fraction);
  }
  const progress = Number(saved?.progress);
  if (Number.isFinite(progress)) return progressToFraction(progress);
  return 0;
}

/**
 * A position saved while reading the other format of the same book: the Android app may keep a
 * server-converted EPUB of an FB2 («Формат скачивания»). FB2 coordinates carry `fb2Href` and no
 * CFI, EPUB ones an `epubcfi(…)`; their CFI, section / offset anchor and page mean nothing in the
 * other format (Foliate failed on `goTo('0#2')` in an EPUB), so only the book-wide fraction is kept.
 */
export function positionForBookFormat(saved, isFb2Book) {
  if (!saved || typeof saved !== 'object') return saved;
  const hasCfi = /^epubcfi\(/i.test(String(saved.position || '').trim());
  const hasFb2Href = Boolean(String(saved.fb2Href || '').trim());
  const foreign = isFb2Book ? hasCfi && !hasFb2Href : hasFb2Href && !hasCfi;
  if (!foreign) return saved;
  return {
    ...saved,
    position: '',
    fb2Href: null,
    sectionIndex: null,
    textOffset: null,
    textQuote: '',
    textSectionLength: null,
    paginatorPage: null,
  };
}

/** Map bootstrap / offline reader store to merge-input shape for cross-device prompt. */
export function buildMergeInputFromOfflineStore(store) {
  const localFrac = savedFraction(store);
  const serverPos = {
    progress: store.serverPositionProgress,
    fraction: store.serverPositionFraction,
    fb2Href: store.serverFb2Href || null,
    position: store.serverPosition || '',
    sectionIndex: store.serverSectionIndex,
    textOffset: store.serverTextOffset,
    textQuote: store.serverTextQuote,
    textSectionLength: store.serverTextSectionLength,
  };
  const serverFrac = savedFraction(serverPos);
  return {
    skipPosition: false,
    localFraction: localFrac,
    localPosition: String(store.position || ''),
    localFb2Href: store.fb2Href || null,
    localSectionIndex: store.sectionIndex ?? null,
    localTextOffset: store.textOffset ?? null,
    localPositionRev: store.positionChangedAt || store.updatedAt || null,
    localHasPaginator: Number.isFinite(Number(store.paginatorPage)),
    serverFraction: serverFrac,
    serverProgress: Number(store.serverPositionProgress) || 0,
    serverPosition: String(store.serverPosition || ''),
    serverFb2Href: store.serverFb2Href || null,
    serverSectionIndex: store.serverSectionIndex ?? null,
    serverTextOffset: store.serverTextOffset ?? null,
    serverPosUpdatedAt: store.serverPositionUpdatedAt || null,
    localServerPositionUpdatedAt: store.serverPositionUpdatedAt || null,
    localServerPositionProgress: store.serverPositionProgress ?? -1,
    localServerPositionFraction: store.serverPositionFraction ?? -1,
    dismissedServerPositionUpdatedAt: store.dismissedServerPositionUpdatedAt || null,
  };
}

export function buildCrossDevicePromptDetailsFromStore(store, flatToc) {
  return buildCrossDevicePromptLines(
    {
      progress: store.progress,
      fraction: store.fraction,
      fb2Href: store.fb2Href,
      position: store.position,
      paginatorPage: store.paginatorPage,
      paginatorPages: store.paginatorPages,
      sectionIndex: store.sectionIndex,
      textOffset: store.textOffset,
      textQuote: store.textQuote,
      textSectionLength: store.textSectionLength,
    },
    {
      progress: store.serverPositionProgress,
      fraction: store.serverPositionFraction,
      fb2Href: store.serverFb2Href,
      position: store.serverPosition,
      paginatorPage: store.serverPaginatorPage,
      paginatorPages: store.serverPaginatorPages,
      sectionIndex: store.serverSectionIndex,
      textOffset: store.serverTextOffset,
      textQuote: store.serverTextQuote,
      textSectionLength: store.serverTextSectionLength,
    },
    flatToc,
  );
}

export function buildMergeInputFromLocalCtx(localCtx, serverPos) {
  const serverFrac = savedFraction(serverPos);
  const localFrac = savedFraction(localCtx);
  return {
    skipPosition: false,
    localFraction: localFrac,
    localPosition: String(localCtx?.position || ''),
    localFb2Href: localCtx?.fb2Href || null,
    localSectionIndex: localCtx?.sectionIndex ?? null,
    localTextOffset: localCtx?.textOffset ?? null,
    localPositionRev: localCtx?.updatedAt || null,
    localHasPaginator: false,
    serverFraction: serverFrac,
    serverProgress: Number(serverPos?.progress) || 0,
    serverPosition: String(serverPos?.position || ''),
    serverFb2Href: serverPos?.fb2Href || null,
    serverSectionIndex: serverPos?.sectionIndex ?? null,
    serverTextOffset: serverPos?.textOffset ?? null,
    serverPosUpdatedAt: serverPos?.updatedAt || null,
    localServerPositionUpdatedAt: localCtx?.serverUpdatedAt || null,
    localServerPositionProgress: Number.isFinite(Number(localCtx?.serverProgress))
      ? Number(localCtx.serverProgress)
      : -1,
    localServerPositionFraction: Number.isFinite(Number(localCtx?.serverFraction))
      ? Number(localCtx.serverFraction)
      : -1,
    dismissedServerPositionUpdatedAt: localCtx?.dismissedUpdatedAt || null,
  };
}

export function localCtxFromSaved(saved) {
  if (!saved) return null;
  return {
    position: saved.position || '',
    progress: Number(saved.progress) || 0,
    fraction: savedFraction(saved),
    fb2Href: saved.fb2Href || null,
    sectionIndex: saved.sectionIndex ?? null,
    textOffset: saved.textOffset ?? null,
    textQuote: saved.textQuote ?? null,
    textSectionLength: saved.textSectionLength ?? null,
    updatedAt: saved.updatedAt || null,
    serverUpdatedAt: saved.updatedAt || null,
    serverProgress: Number(saved.progress) || 0,
    dismissedUpdatedAt: null,
  };
}
