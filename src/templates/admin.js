/**
 * Admin template functions.
 */
import {
  escapeHtml, csrfHiddenField, pageShell, renderPagination, renderEmptyState,
  renderEventDetailsHtml, renderAlert,
  t, tp, getLocale, plural, countLabel, formatLocaleInt,
  formatLocaleDateShort, formatLocaleDateTimeShort, formatLanguageLabel,
  formatGenreLabel
} from './shared.js';

function renderCollapsibleAdminCard({ id, title, subtitle = '', body, open = false }) {
  const openAttr = open ? ' open' : '';
  return `
    <details class="admin-card admin-card-collapsible" data-admin-collapse="${escapeHtml(id)}"${openAttr}>
      <summary>
        <div class="admin-card-title">${escapeHtml(title)}</div>
        ${subtitle ? `<div class="admin-card-subtitle" style="margin-bottom:0;">${escapeHtml(subtitle)}</div>` : ''}
      </summary>
      <div class="admin-card-collapsible-body">
        ${body}
      </div>
    </details>`;
}
import { getGenreGroups } from '../genre-map.js';
import { config } from '../config.js';
import {
  FORMAT_LABELS,
  getConfiguredDownloadFormats,
  setDisabledDownloadFormats
} from '../download-formats.js';
import { DOWNLOAD_FILENAME_STYLES } from '../download-filename.js';
import { FB2_WEBP_MODES } from '../fb2-webp-images.js';
import {
  TELEGRAM_DEFAULT_PROFILE_DESCRIPTION,
  TELEGRAM_DEFAULT_PROFILE_SHORT,
  TELEGRAM_DEFAULT_WELCOME,
  TELEGRAM_DEFAULT_NEW_BOOKS_ANNOUNCE,
} from '../telegram-bot-defaults.js';
import { buildGlassPanelBackground, adjustLightTextForGlassOpacity, DEFAULT_GLASS_LIGHT, DEFAULT_GLASS_DARK, MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX, MIN_HEADING_SCALE, MAX_HEADING_SCALE, MIN_RADIUS_SCALE, MAX_RADIUS_SCALE, THEME_PRESETS } from '../services/theme-engine.js';
export function renderOperations({ user, stats = {}, indexStatus = {}, operations = {}, defaultLocale = 'auto', csrfToken = '' }) {
  /* Сплошной цвет по тому же градиенту (для одиночных элементов — donut, иконки и т.п.).
     0-70% → зелёный → жёлтый; 70-100% → жёлтый → красный. */
  const monitorSeverityColor = (value) => {
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    const c0 = { r: 63, g: 185, b: 94 };
    const c1 = { r: 226, g: 187, b: 79 };
    const c2 = { r: 217, g: 80, b: 80 };
    const lerp = (a, b, t) => Math.round(a + (b - a) * t);
    let out;
    if (pct <= 70) {
      const t = pct / 70;
      out = { r: lerp(c0.r, c1.r, t), g: lerp(c0.g, c1.g, t), b: lerp(c0.b, c1.b, t) };
    } else {
      const t = (pct - 70) / 30;
      out = { r: lerp(c1.r, c2.r, t), g: lerp(c1.g, c2.g, t), b: lerp(c1.b, c2.b, t) };
    }
    return `rgb(${out.r}, ${out.g}, ${out.b})`;
  };
  const monitorBarGradient = (value) => {
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    const c0 = { r: 63, g: 185, b: 94 };   // green
    const c1 = { r: 226, g: 187, b: 79 };  // yellow
    const c2 = { r: 217, g: 80, b: 80 };   // red
    const lerp = (a, b, t) => Math.round(a + (b - a) * t);
    let out;
    if (pct <= 70) {
      const t = pct / 70;
      out = {
        r: lerp(c0.r, c1.r, t),
        g: lerp(c0.g, c1.g, t),
        b: lerp(c0.b, c1.b, t)
      };
    } else {
      const t = (pct - 70) / 30;
      out = {
        r: lerp(c1.r, c2.r, t),
        g: lerp(c1.g, c2.g, t),
        b: lerp(c1.b, c2.b, t)
      };
    }
    return `linear-gradient(90deg, rgb(${c0.r}, ${c0.g}, ${c0.b}) 0%, rgb(${out.r}, ${out.g}, ${out.b}) 100%)`;
  };
  const uptimeSec = operations.uptimeSeconds || 0;
  const days = Math.floor(uptimeSec / 86400);
  const hrs = Math.floor((uptimeSec % 86400) / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const dU = t('time.dayShort');
  const hU = t('time.hourShort');
  const mU = t('time.minShort');
  const uptimeStr = days ? `${days}${dU} ${hrs}${hU} ${mins}${mU}` : hrs ? `${hrs}${hU} ${mins}${mU}` : `${mins}${mU}`;
  const dbSizeMB = operations.dbSizeBytes ? (operations.dbSizeBytes / 1024 / 1024).toFixed(1) : t('common.dash');
  const loc = getLocale() === 'en' ? 'en-US' : 'ru-RU';
  /* CPU: % от общей мощности (нормирован на количество ядер). */
  const cpuAllPct = Number(operations.cpuAll ?? operations.cpuPercent);
  const cpuSinglePct = Number(operations.cpuSingle);
  const fmtPct = (n) => Number.isFinite(n) ? n.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : t('common.dash');
  const cpuStr = `${fmtPct(cpuAllPct)}%`;
  /* «Память приложения»: RSS (Resident Set Size) — то, что показывает ОС в htop.
     Раньше я показывал V8 heap, но это лишь ~5% от реальной памяти процесса —
     SQLite page cache живёт в нативной C++-памяти и в heap не видна. Админу нужна
     цифра, совпадающая с тем, что он видит в системных мониторах. Полоска —
     доля памяти всего хоста: на 4 ГБ NAS 600 МБ даст осязаемые ~15%. */
  const rssMemMb = Number(operations.memoryMB);
  const systemMemMb = Number(operations.systemMemoryMB);
  const memPct = Number.isFinite(rssMemMb) && Number.isFinite(systemMemMb) && systemMemMb > 0
    ? Math.max(0, Math.min(100, (rssMemMb / systemMemMb) * 100))
    : 0;
  /* Тот же auto-unit как в БД: МБ при <1 ГБ, иначе ГБ. */
  const fmtMemMb = (mb, totalMb) => {
    if (!Number.isFinite(mb)) return t('common.dash');
    const cur = mb >= 1024
      ? `${(mb / 1024).toLocaleString(loc, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${t('common.unitGB')}`
      : `${mb.toLocaleString(loc, { maximumFractionDigits: 0 })} ${t('common.unitMB')}`;
    if (!Number.isFinite(totalMb) || totalMb <= 0) return cur;
    const totalStr = totalMb >= 1024
      ? `${(totalMb / 1024).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${t('common.unitGB')}`
      : `${totalMb.toLocaleString(loc, { maximumFractionDigits: 0 })} ${t('common.unitMB')}`;
    return `${cur} ${escapeHtml(tp('admin.monitor.memOfTotal', { total: totalStr }))}`;
  };
  const memStr = fmtMemMb(rssMemMb, systemMemMb);
  /* Event-loop lag — главный индикатор «висит/не висит» сервер.
     Полоска нормализована к 200мс (всё что выше 200мс — это уже плохо). */
  const loopP50 = Number(operations.loopLagP50Ms);
  const loopP99 = Number(operations.loopLagP99Ms);
  const loopPct = Number.isFinite(loopP99)
    ? Math.max(0, Math.min(100, (loopP99 / 200) * 100))
    : 0;
  const loopStr = Number.isFinite(loopP50) && Number.isFinite(loopP99)
    ? `p50 ${loopP50.toLocaleString(loc, { maximumFractionDigits: 1 })} · p99 ${loopP99.toLocaleString(loc, { maximumFractionDigits: 1 })} ${escapeHtml(t('common.unitMs'))}`
    : t('common.dash');

  const diskTotal = Number(operations.diskTotalMB);
  const diskFree = Number(operations.diskFreeMB);
  const diskUsed = Number.isFinite(diskTotal) && Number.isFinite(diskFree)
    ? Math.max(0, diskTotal - diskFree)
    : NaN;
  const diskTotalGb = Number.isFinite(diskTotal) ? (diskTotal / 1024) : NaN;
  const diskFreeGb = Number.isFinite(diskFree) ? (diskFree / 1024) : NaN;
  const diskPct = Number.isFinite(diskUsed) && Number.isFinite(diskTotal) && diskTotal > 0
    ? Math.max(0, Math.min(100, (diskUsed / diskTotal) * 100))
    : 0;
  const diskStr = Number.isFinite(diskFreeGb) && Number.isFinite(diskTotalGb)
    ? escapeHtml(tp('admin.monitor.diskFreeOf', {
      free: diskFreeGb.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
      total: diskTotalGb.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
      unit: t('common.unitGB')
    }))
    : t('common.dash');
  /* Раздельные значения для статистики под полосой (used / free / total).
     Авто-единица: при ≥1 ГБ — ГБ, иначе МБ. */
  const fmtDiskMb = (mb) => {
    if (!Number.isFinite(mb)) return t('common.dash');
    if (mb >= 1024) return `${(mb / 1024).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${t('common.unitGB')}`;
    return `${mb.toLocaleString(loc, { maximumFractionDigits: 0 })} ${t('common.unitMB')}`;
  };
  const diskUsedStr = fmtDiskMb(diskUsed);
  const diskFreeStr = fmtDiskMb(diskFree);
  const diskTotalStr = fmtDiskMb(diskTotal);
  /* «База данных»: цветной сегментированный бар по категориям содержимого
     (Книги / Каталоги / Кеш обложек / Сайдкары / Активность / Прочее).
     dbSize/diskTotal-полоска всегда болталась у нуля — не информативно.
     Здесь сразу видно «что весит больше всего» — обычно либо книги+FTS,
     либо кеш обложек, а каталоги и активность остаются тонкой полоской. */
  const dbMbNum = Number(dbSizeMB);
  const dbStr = Number.isFinite(dbMbNum)
    ? (dbMbNum >= 1024
      ? `${(dbMbNum / 1024).toLocaleString(loc, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${escapeHtml(t('common.unitGB'))}`
      : `${dbMbNum.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${escapeHtml(t('common.unitMB'))}`)
    : t('common.dash');
  const dbBreakdown = operations.dbBreakdown || { supported: false, segments: [], total: 0 };
  /* Подготовка читаемого формата размера сегмента для tooltip и легенды. */
  const fmtBytes = (bytes) => {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024 * 1024) return `${(n / (1024*1024*1024)).toLocaleString(loc, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${t('common.unitGB')}`;
    if (n >= 1024 * 1024) return `${(n / (1024*1024)).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${t('common.unitMB')}`;
    if (n >= 1024) return `${(n / 1024).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${t('common.unitKB') || 'KB'}`;
    return `${n} B`;
  };
  const dbSegmentsHtml = dbBreakdown.segments && dbBreakdown.segments.length
    ? dbBreakdown.segments.map((s) => `<span class="db-seg db-seg-${escapeHtml(s.key)}" style="width:${s.pct.toFixed(2)}%" title="${escapeHtml(t('admin.monitor.dbSeg.' + s.key) || s.key)}: ${escapeHtml(fmtBytes(s.bytes))}"></span>`).join('')
    : '';
  const dbLegendHtml = dbBreakdown.segments && dbBreakdown.segments.length
    ? dbBreakdown.segments.map((s) => `<span class="db-legend-item"><i class="db-seg-dot db-seg-${escapeHtml(s.key)}"></i><span class="db-legend-label">${escapeHtml(t('admin.monitor.dbSeg.' + s.key) || s.key)}</span><span class="db-legend-size muted">${escapeHtml(fmtBytes(s.bytes))}</span></span>`).join('')
    : '';
  const cacheMB =
    operations.cacheApproxBytes != null
      ? (operations.cacheApproxBytes / 1024 / 1024).toLocaleString(loc, {
          maximumFractionDigits: 1,
          minimumFractionDigits: 1
        })
      : t('common.dash');
  const srcCount = (operations.sources || []).length;
  const sourcesLine = srcCount ? countLabel('source', srcCount) : t('admin.sourcesNone');
  /* Сводка по последней (или текущей) индексации для чипа в верхней панели:
     показываем только если есть что показать (после первой индексации). */
  const lastImported = Number(operations.lastIndexImported) || 0;
  const lastUnique = Number(operations.lastIndexUnique) || 0;
  const lastIndexSummary = (lastImported > 0 || lastUnique > 0)
    ? tp('admin.statsLastIndex', {
        imported: lastImported.toLocaleString(loc),
        unique: lastUnique.toLocaleString(loc)
      })
    : t('admin.statsLastIndexEmpty');
  const content = `
    <div data-operations-dashboard>

      <div class="admin-status-bar">
        <span class="admin-chip"><strong data-operations-field="statsBooks">${escapeHtml(countLabel('book', Number(operations.totalBooks ?? stats.totalBooks) || 0))}</strong></span>
        <span class="admin-chip"><strong data-operations-field="statsAuthors">${escapeHtml(countLabel('author', Number(operations.totalAuthors ?? stats.totalAuthors) || 0))}</strong></span>
        <span class="admin-chip"><strong data-operations-field="statsSeries">${escapeHtml(countLabel('series', Number(operations.totalSeries ?? stats.totalSeries) || 0))}</strong></span>
        <span class="admin-chip" title="${escapeHtml(t('admin.duplicates.suppressedTitle'))}"><strong data-operations-field="statsSuppressed">${escapeHtml(tp('admin.statsSuppressed', { n: (Number(operations.suppressedCount) || 0).toLocaleString(loc) }))}</strong></span>
        <span class="admin-chip" title="${escapeHtml(t('admin.statsDeletedTitle'))}"><strong data-operations-field="statsDeleted">${escapeHtml(tp('admin.statsDeleted', { n: (Number(operations.deletedCount) || 0).toLocaleString(loc) }))}</strong></span>
        <span class="admin-sep"></span>
        <span class="admin-chip" data-index-field="active">${indexStatus.active ? escapeHtml(t('admin.indexUpdating')) : escapeHtml(t('admin.indexReady'))}</span>
        ${(() => {
          const fts = indexStatus?.ftsStatus || operations?.ftsStatus || {};
          const st = fts.status || '';
          const warn = st === 'dirty' || st === 'desynced' || st === 'rebuilding' || operations?.ftsRebuildRunning;
          const label = st === 'ok' ? t('admin.ftsStatusOk')
            : st === 'dirty' ? t('admin.ftsStatusDirty')
              : st === 'rebuilding' || operations?.ftsRebuildRunning ? t('admin.ftsStatusRebuilding')
                : st === 'desynced' ? t('admin.ftsStatusDesynced')
                  : st === 'empty' ? t('admin.ftsStatusEmpty')
                    : t('admin.ftsStatusUnknown');
          const tip = tp('admin.ftsStatusTip', {
            books: Number(fts.booksCount) || 0,
            fts: Number(fts.ftsDocCount) || 0
          });
          return `<span class="admin-chip${warn ? ' admin-chip--warn' : ''}" title="${escapeHtml(tip)}" data-operations-field="ftsStatus" data-fts-status="${escapeHtml(st)}">${escapeHtml(label)}</span>`;
        })()}
        <span class="admin-chip" title="${escapeHtml(t('admin.statsLastIndexTitle'))}"><span data-operations-field="statsLastIndex">${escapeHtml(lastIndexSummary)}</span></span>
        <span class="admin-sep"></span>
        <span class="admin-chip" data-operations-field="uptime">${escapeHtml(tp('admin.uptime', { s: uptimeStr }))}</span>
        <span class="admin-chip">${escapeHtml(tp('admin.ram', { mb: operations.memoryMB || t('common.dash') }))}</span>
        <span class="admin-chip">${escapeHtml(tp('admin.db', { mb: dbSizeMB }))}</span>
      </div>

      <div class="admin-card">
        <form action="/admin/settings/site-name" method="post" data-track-dirty>
          ${csrfHiddenField(csrfToken)}
          <div class="admin-field-group" style="margin-top:12px">
            <label for="admin-default-locale">${escapeHtml(t('admin.defaultLocale'))}</label>
            <select id="admin-default-locale" name="defaultLocale" style="max-width:280px">
              <option value="auto" ${defaultLocale === 'auto' || (defaultLocale !== 'ru' && defaultLocale !== 'en') ? 'selected' : ''}>${escapeHtml(t('admin.defaultLocaleAuto'))}</option>
              <option value="ru" ${defaultLocale === 'ru' ? 'selected' : ''}>${escapeHtml(t('admin.defaultLocaleRu'))}</option>
              <option value="en" ${defaultLocale === 'en' ? 'selected' : ''}>${escapeHtml(t('admin.defaultLocaleEn'))}</option>
            </select>
            <span class="admin-field-hint">${escapeHtml(t('admin.defaultLocaleHint'))}</span>
          </div>
          <div class="admin-actions-row">
            <button type="submit">${escapeHtml(t('admin.save'))}</button>
          </div>
        </form>
        <hr class="admin-divider">
        <div class="admin-action-item">
          <div class="admin-action-item-info">
            <strong>${escapeHtml(t('admin.sourcesBlock'))}</strong>
            <span class="muted">${escapeHtml(sourcesLine)}</span>
          </div>
          <div class="admin-actions-row">
            <a href="/admin/sources" class="button">${escapeHtml(t('admin.manage'))}</a>
          </div>
        </div>
        <hr class="admin-divider">
        <div class="admin-action-item">
          <div class="admin-action-item-info">
            <strong>${escapeHtml(t('admin.monitor.title'))}</strong>
            <span class="muted">${escapeHtml(t('admin.monitor.hint'))}</span>
            <div class="monitor-grid">
              <div class="monitor-item monitor-item--graph" data-monitor-key="cpu" title="${escapeHtml(t('admin.monitor.cpuHint'))}">
                <div class="monitor-item-top">
                  <span class="monitor-label">${escapeHtml(t('admin.monitor.cpu'))}</span>
                  <span class="monitor-value" data-operations-field="monitorCpu">${cpuStr}</span>
                </div>
                <div class="monitor-meter"><span data-operations-field="monitorCpuBar" style="width:${Number.isFinite(cpuSinglePct) ? cpuSinglePct : 0}%;background:${monitorBarGradient(Number.isFinite(cpuSinglePct) ? cpuSinglePct : 0)}"></span></div>
                <div class="spark-stats" data-operations-field="monitorCpuStats"></div>
                <svg class="monitor-spark monitor-spark--lg" data-operations-field="monitorCpuSpark" aria-hidden="true"></svg>
              </div>
              <div class="monitor-item monitor-item--graph" data-monitor-key="mem" title="${escapeHtml(t('admin.monitor.memHint'))}">
                <div class="monitor-item-top">
                  <span class="monitor-label">${escapeHtml(t('admin.monitor.mem'))}</span>
                  <span class="monitor-value" data-operations-field="monitorMem">${memStr}</span>
                </div>
                <div class="monitor-meter"><span data-operations-field="monitorMemBar" style="width:${memPct.toFixed(1)}%;background:${monitorBarGradient(memPct)}"></span></div>
                <div class="spark-stats" data-operations-field="monitorMemStats"></div>
                <svg class="monitor-spark monitor-spark--lg" data-operations-field="monitorMemSpark" aria-hidden="true"></svg>
              </div>
              <div class="monitor-item" data-monitor-key="db" title="${escapeHtml(t('admin.monitor.dbHint'))}">
                <div class="monitor-item-top">
                  <span class="monitor-label">${escapeHtml(t('admin.monitor.dbTile'))}</span>
                  <span class="monitor-value" data-operations-field="monitorDb">${dbStr}</span>
                </div>
                <div class="db-stacked-bar" data-operations-field="monitorDbStack">${dbSegmentsHtml}</div>
                <div class="db-legend" data-operations-field="monitorDbLegend">${dbLegendHtml}</div>
                <small class="monitor-hint">${escapeHtml(t('admin.monitor.dbHint'))}</small>
              </div>
              <div class="monitor-item monitor-item--disk" data-monitor-key="disk" title="${escapeHtml(t('admin.monitor.diskHint'))}">
                <div class="monitor-item-top">
                  <span class="monitor-label">${escapeHtml(t('admin.monitor.disk'))}</span>
                  <span class="monitor-value" data-operations-field="monitorDiskPct">${diskPct.toFixed(0)}%</span>
                </div>
                <div class="disk-bar-track" data-disk-thresholds aria-hidden="true">
                  <span class="disk-bar-fill"
                        data-operations-field="monitorDiskBar"
                        style="width:${diskPct.toFixed(1)}%;background:${monitorBarGradient(diskPct)}"></span>
                  <span class="disk-bar-tick disk-bar-tick--warn" style="left:75%"></span>
                  <span class="disk-bar-tick disk-bar-tick--alert" style="left:90%"></span>
                </div>
                <div class="disk-bar-stats">
                  <span class="disk-bar-stat" data-operations-field="monitorDiskUsed">
                    <span class="muted">${escapeHtml(t('admin.monitor.diskUsedLabel'))}</span>
                    <strong>${escapeHtml(diskUsedStr)}</strong>
                  </span>
                  <span class="disk-bar-stat" data-operations-field="monitorDiskFree">
                    <span class="muted">${escapeHtml(t('admin.monitor.diskFreeLabel'))}</span>
                    <strong>${escapeHtml(diskFreeStr)}</strong>
                  </span>
                  <span class="disk-bar-stat" data-operations-field="monitorDiskTotal">
                    <span class="muted">${escapeHtml(t('admin.monitor.diskTotalLabel'))}</span>
                    <strong>${escapeHtml(diskTotalStr)}</strong>
                  </span>
                </div>
              </div>
            </div>
            <div class="monitor-foot">
              <span class="muted" data-operations-field="monitorUsers">${escapeHtml(t('admin.monitor.users'))}: ${escapeHtml(tp('admin.monitor.usersFmt', { total: (Number(operations.totalUsers) || 0).toLocaleString(loc), online: (Number(operations.onlineUsers) || 0).toLocaleString(loc) }))}</span>
            </div>
          </div>
        </div>
        <div class="admin-action-item">
          <div class="admin-action-item-info">
            <strong>${escapeHtml(t('admin.ftsRebuild'))}</strong>
            <span class="muted">${escapeHtml(t('admin.ftsRebuildHint'))}</span>
          </div>
          <div class="admin-actions-row">
            <button type="button" data-operation-action="fts-rebuild" data-operation-label="${escapeHtml(t('admin.ftsRebuildBtn'))}" ${operations.ftsRebuildRunning || indexStatus.active ? 'disabled' : ''}>${escapeHtml(t('admin.ftsRebuildBtn'))}</button>
          </div>
        </div>
        <div class="admin-action-item">
          <div class="admin-action-item-info">
            <strong>${escapeHtml(t('admin.cache'))}</strong>
            <span class="muted">${escapeHtml(t('admin.cacheHint'))}</span>
            <span class="muted" data-operations-field="cacheCountInline">${countLabel('record', operations.cacheCount)} · ${cacheMB} ${escapeHtml(t('common.unitMB'))}</span>
          </div>
          <div class="admin-actions-row">
            <button type="button" data-operation-action="cache-clear" data-operation-label="${escapeHtml(t('admin.cacheClear'))}">${escapeHtml(t('admin.cacheClear'))}</button>
          </div>
        </div>
        <div class="admin-action-item">
          <div class="admin-action-item-info">
            <strong>${escapeHtml(t('admin.restart'))}</strong>
            <span class="muted">${escapeHtml(t('admin.restartHint'))}</span>
          </div>
          <div class="admin-actions-row">
            <button type="button" data-operation-action="restart" data-operation-label="${escapeHtml(t('admin.restartBtn'))}" class="button-danger">${escapeHtml(t('admin.restartBtn'))}</button>
          </div>
        </div>
      </div>

      <div style="display:none;">
        <span data-index-field="error" ${indexStatus.error ? '' : 'style="display:none"'}>${indexStatus.error ? escapeHtml(t('admin.errorPrefix')) + ' ' + escapeHtml(indexStatus.error) : ''}</span>
      </div>
    </div>
  `;
  return pageShell({ title: t('admin.ops.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.ops.title') }], mode: 'admin', currentPath: '/admin', csrfToken });
}

export function renderAdminUpdate({ user, stats = {}, indexStatus = {}, operations = {}, csrfToken = '' }) {
  const content = `
    <div class="admin-card">
      <div class="admin-card-title">${escapeHtml(t('admin.update.backupTitle'))}</div>
      <div class="admin-card-subtitle">${escapeHtml(t('admin.update.backupSubtitle'))}</div>
      <div class="admin-actions-row" style="margin-top:10px;flex-wrap:wrap;">
        <a class="button" href="/api/operations/backup">${escapeHtml(t('admin.update.downloadDb'))}</a>
        <a class="button" href="/api/operations/users-export">${escapeHtml(t('admin.update.exportUsers'))}</a>
        <a class="button" href="/api/operations/settings-export?download=1">${escapeHtml(t('admin.update.exportJson'))}</a>
        <a class="button" href="/api/operations/settings-export" target="_blank" rel="noopener noreferrer">${escapeHtml(t('admin.update.openJson'))}</a>
      </div>
      <form class="admin-field-group" style="margin-top:16px;" method="post" action="/api/operations/users-import" enctype="multipart/form-data" data-users-import>
        ${csrfHiddenField(csrfToken)}
        <span class="admin-field-hint">${escapeHtml(t('admin.update.importUsersHint'))}</span>
        <div class="admin-actions-row" style="margin-top:8px;flex-wrap:wrap;">
          <label for="users-import-input" class="button" style="cursor:pointer;">${escapeHtml(t('admin.update.importUsersPick'))}</label>
          <input type="file" id="users-import-input" name="usersJson" accept="application/json,.json" style="display:none;">
          <span id="users-import-name" class="muted"></span>
          <button type="submit" id="users-import-btn" disabled>${escapeHtml(t('admin.update.importUsers'))}</button>
        </div>
      </form>
    </div>
    <div class="admin-card" style="margin-top:20px;">
      <div class="admin-card-title">${escapeHtml(t('admin.update.checkTitle'))}</div>
      <div class="admin-card-subtitle">${escapeHtml(t('admin.update.checkSubtitle'))}</div>
      <div class="admin-inline-row" style="flex-wrap:wrap;">
        <button type="button" id="update-check-btn">${escapeHtml(t('admin.update.checkBtn'))}</button>
        <button type="button" id="update-apply-btn" style="display:none;"></button>
        <span class="muted">${escapeHtml(t('admin.update.currentVersion'))}: v${escapeHtml(String(operations.appVersion || '?'))}</span>
      </div>
      <div id="update-check-status" class="muted" style="margin-top:10px;"></div>
    </div>
    <div class="admin-card" style="margin-top:20px;">
      <div class="admin-card-title">${escapeHtml(t('admin.update.uploadTitle'))}</div>
      <div class="admin-card-subtitle">${escapeHtml(t('admin.update.uploadSubtitle'))}</div>
      <div class="admin-inline-row" style="flex-wrap:wrap;">
        <label for="update-zip-input" class="button" style="cursor:pointer;">${escapeHtml(t('admin.update.pickZip'))}</label>
        <input type="file" id="update-zip-input" accept=".zip" style="display:none;">
        <span id="update-zip-name" class="muted"></span>
        <button type="button" id="update-start-btn" disabled>${escapeHtml(t('admin.update.start'))}</button>
      </div>
      <div id="update-progress" style="display:none;margin-top:14px;">
        <div style="background:var(--field-bg);border:1px solid var(--border);border-radius:6px;overflow:hidden;height:6px;margin-bottom:8px;">
          <div id="update-progress-bar" style="height:100%;background:var(--accent);width:0%;transition:width .3s;"></div>
        </div>
        <pre id="update-log" style="max-height:260px;overflow-y:auto;font-size:.82em;line-height:1.5;white-space:pre-wrap;word-break:break-word;padding:10px;background:var(--field-bg);border:1px solid var(--border);border-radius:6px;margin:0;color:var(--text);"></pre>
      </div>
    </div>
  `;
  return pageShell({ title: t('admin.nav.backup'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.nav.backup') }], mode: 'admin', currentPath: '/admin/update', csrfToken });
}

export function renderAdminUsers({ user, stats, indexStatus, users = [], flash = '', adminCount = 0, registrationEnabled = false, registrationInviteToken = '', registrationInviteUrl = '', recaptchaSiteKey = '', recaptchaSecretKey = '', allowAnonymousBrowse = false, allowAnonymousDownload = false, allowAnonymousOpds = false, passwordResetEnabled = false, publicBaseUrl = '', oidc = null, csrfToken = '' }) {
  const admins = users.filter((account) => account.role === 'admin');
  const regularUsers = users.filter((account) => account.role !== 'admin');
  const fmtDate = (d) => formatLocaleDateShort(d);
  const isSelf = (account) => account.username === user?.username;
  const accountFlagOn = (value) => Number(value ?? 1) !== 0;
  const accountAutocompleteSection = (account) => `section-admin-${String(account.username).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const userField = (base, account) => `${base}__${String(account.username).replace(/[^\w.-]/g, '_')}`;
  const renderUserRows = (items = []) => items.map((account) => `
    <details class="admin-user-row ${account.blocked ? 'admin-user-row-blocked' : ''}">
      <summary class="admin-user-row-summary">
        <strong>${escapeHtml(account.username)}</strong>
        <span class="role-badge role-badge-${escapeHtml(account.role)}">${escapeHtml(account.role)}</span>
        ${account.blocked ? `<span class="badge-blocked">${escapeHtml(t('admin.users.blocked'))}</span>` : ''}
        ${account.telegramId ? `<span class="muted">TG ${escapeHtml(account.telegramId)}</span>` : ''}
        ${account.ereaderEmail ? `<span class="muted">${escapeHtml(account.ereaderEmail)}</span>` : ''}
        ${!accountFlagOn(account.telegramBotAllowed) ? `<span class="badge-blocked">${escapeHtml(t('admin.users.telegramDenied'))}</span>` : ''}
        ${!accountFlagOn(account.ereaderEmailAllowed) ? `<span class="badge-blocked">${escapeHtml(t('admin.users.emailDenied'))}</span>` : ''}
        ${isSelf(account) ? `<span class="badge-self">${escapeHtml(t('admin.users.self'))}</span>` : ''}
        <span class="muted admin-user-row-date">${escapeHtml(t('admin.users.created'))} ${escapeHtml(fmtDate(account.createdAt))}</span>
      </summary>
      <div class="admin-user-row-body">
        <form class="user-admin-form" action="/admin/users/update" method="post" autocomplete="off">
          ${csrfHiddenField(csrfToken)}
          <input type="hidden" name="accountUsername" value="${escapeHtml(account.username)}" autocomplete="${escapeHtml(accountAutocompleteSection(account))} username">
          <input type="hidden" name="${escapeHtml(userField('accountFieldsReady', account))}" value="0" data-admin-fields-ready>
          <div class="admin-form-grid">
            <div class="admin-field-group">
              <label>${escapeHtml(t('admin.users.role'))}</label>
              <select name="role">
                <option value="user" ${account.role === 'user' ? 'selected' : ''}>user</option>
                <option value="admin" ${account.role === 'admin' ? 'selected' : ''}>admin</option>
              </select>
            </div>
            <div class="admin-field-group">
              <label>${escapeHtml(t('admin.users.newPassword'))}</label>
              <input type="password" name="${escapeHtml(userField('newPassword', account))}" placeholder="${escapeHtml(t('admin.users.noChangePassword'))}" autocomplete="${escapeHtml(accountAutocompleteSection(account))} new-password" data-admin-no-autofill>
            </div>
            <div class="admin-field-group">
              <label>${escapeHtml(t('admin.users.telegramId'))}</label>
              <input type="text" name="${escapeHtml(userField('accountTelegramId', account))}" value="" placeholder="123456789" inputmode="numeric" pattern="\\d*" autocomplete="${escapeHtml(accountAutocompleteSection(account))} off" data-lpignore="true" data-1p-ignore="true" data-admin-no-autofill data-initial-telegram-id="${escapeHtml(account.telegramId || '')}">
              <span class="admin-field-hint">${escapeHtml(t('admin.users.telegramIdHint'))}</span>
            </div>
            <div class="admin-field-group">
              <label>${escapeHtml(t('admin.users.ereaderEmail'))}</label>
              <input type="email" name="${escapeHtml(userField('accountEreaderEmail', account))}" value="" placeholder="kindle@kindle.com" autocomplete="${escapeHtml(accountAutocompleteSection(account))} off" data-lpignore="true" data-1p-ignore="true" data-admin-no-autofill data-initial-ereader-email="${escapeHtml(account.ereaderEmail || '')}">
              <span class="admin-field-hint">${escapeHtml(t('admin.users.ereaderEmailHint'))}</span>
            </div>
            <div class="admin-field-group" style="flex-direction:row;align-items:center;gap:10px;">
              <label class="admin-checkbox-label" style="text-transform:none;letter-spacing:0;">
                <input type="checkbox" name="telegramBotAllowed" value="1" ${accountFlagOn(account.telegramBotAllowed) ? 'checked' : ''} autocomplete="off" style="accent-color:var(--accent);width:16px;height:16px;">
                ${escapeHtml(t('admin.users.telegramBotAllowed'))}
              </label>
            </div>
            <div class="admin-field-group" style="flex-direction:row;align-items:center;gap:10px;">
              <label class="admin-checkbox-label" style="text-transform:none;letter-spacing:0;">
                <input type="checkbox" name="ereaderEmailAllowed" value="1" ${accountFlagOn(account.ereaderEmailAllowed) ? 'checked' : ''} autocomplete="off" style="accent-color:var(--accent);width:16px;height:16px;">
                ${escapeHtml(t('admin.users.ereaderEmailAllowed'))}
              </label>
            </div>
          </div>
          <div class="admin-actions-row">
            <button type="submit">${escapeHtml(t('admin.save'))}</button>
          </div>
        </form>
        ${!isSelf(account) ? `
          <hr class="admin-divider">
          <div class="admin-inline-row">
            <form action="/admin/users/block" method="post" class="admin-inline-form">
              ${csrfHiddenField(csrfToken)}
              <input type="hidden" name="accountUsername" value="${escapeHtml(account.username)}" autocomplete="off">
              <input type="hidden" name="action" value="${account.blocked ? 'unblock' : 'block'}">
              <button type="submit" class="${account.blocked ? '' : 'button-danger'}">${account.blocked ? escapeHtml(t('admin.users.unblock')) : escapeHtml(t('admin.users.block'))}</button>
            </form>
            <form action="/admin/users/delete" method="post" class="admin-inline-form" data-confirm="${escapeHtml(tp('admin.users.deleteConfirm', { name: account.username }))}" data-confirm-danger>
              ${csrfHiddenField(csrfToken)}
              <input type="hidden" name="accountUsername" value="${escapeHtml(account.username)}" autocomplete="off">
              <button type="submit" class="button-danger">${escapeHtml(t('admin.users.deleteUser'))}</button>
            </form>
          </div>
        ` : ''}
      </div>
    </details>
  `).join('');
  const content = `
    ${flash ? renderAlert('success', flash) : ''}

    <div class="admin-card">
      <div class="admin-card-title">${escapeHtml(t('admin.smtp.passwordResetTitle'))}</div>
      <div class="admin-card-subtitle">${escapeHtml(t('admin.smtp.passwordResetHint'))}</div>
      <form method="POST" action="/admin/settings/password-reset" data-track-dirty>
        ${csrfHiddenField(csrfToken)}
        <div class="admin-field-group" style="flex-direction:row;align-items:center;gap:10px;">
          <label class="admin-checkbox-label" style="text-transform:none;letter-spacing:0;">
            <input type="hidden" name="enabled" value="0">
            <input type="checkbox" name="enabled" value="1" ${passwordResetEnabled ? 'checked' : ''} style="accent-color:var(--accent);width:16px;height:16px;">
            ${escapeHtml(t('admin.smtp.passwordResetEnabled'))}
          </label>
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.smtp.publicBaseUrl'))}</label>
          <input type="url" name="publicBaseUrl" value="${escapeHtml(publicBaseUrl || '')}" placeholder="https://books.example.com" autocomplete="off">
          <span class="admin-field-hint">${escapeHtml(t('admin.smtp.publicBaseUrlHint'))}</span>
        </div>
        <div class="admin-actions-row">
          <button type="submit">${escapeHtml(t('admin.save'))}</button>
        </div>
      </form>
    </div>

    ${renderCollapsibleAdminCard({
      id: 'oidc',
      title: t('admin.oidc.title'),
      subtitle: t('admin.oidc.subtitle'),
      open: Boolean(oidc?.enabled),
      body: `
      <form method="POST" action="/admin/settings/oidc" data-track-dirty>
        ${csrfHiddenField(csrfToken)}
        <div class="admin-field-group" style="flex-direction:row;align-items:center;gap:10px;">
          <label class="admin-checkbox-label" style="text-transform:none;letter-spacing:0;">
            <input type="hidden" name="enabled" value="0">
            <input type="checkbox" name="enabled" value="1" ${oidc?.enabled ? 'checked' : ''} style="accent-color:var(--accent);width:16px;height:16px;">
            ${escapeHtml(t('admin.oidc.enabled'))}
          </label>
        </div>
        <div class="admin-form-grid admin-form-grid--align-start">
          <div class="admin-field-group">
            <label>${escapeHtml(t('admin.oidc.issuer'))}</label>
            <input type="url" name="issuer" value="${escapeHtml(oidc?.issuer || '')}" placeholder="https://auth.example.com/application/o/inpx/" autocomplete="off">
            <span class="admin-field-hint">${escapeHtml(t('admin.oidc.issuerHint'))}</span>
          </div>
          <div class="admin-field-group">
            <label>${escapeHtml(t('admin.oidc.clientId'))}</label>
            <input type="text" name="clientId" value="${escapeHtml(oidc?.clientId || '')}" autocomplete="off">
          </div>
          <div class="admin-field-group">
            <label>${escapeHtml(t('admin.oidc.clientSecret'))}</label>
            <input type="password" name="clientSecret" value="" placeholder="${oidc?.clientSecret ? '••••••••' : ''}" autocomplete="new-password">
            <span class="admin-field-hint">${escapeHtml(t('admin.oidc.clientSecretHint'))}</span>
          </div>
          <div class="admin-field-group">
            <label>${escapeHtml(t('admin.oidc.redirectUri'))}</label>
            <input type="url" name="redirectUri" value="${escapeHtml(oidc?.redirectUri || '')}" placeholder="${escapeHtml((publicBaseUrl || 'https://books.example.com').replace(/\/+$/, '') + '/auth/oidc/callback')}" autocomplete="off">
            <span class="admin-field-hint">${escapeHtml(t('admin.oidc.redirectUriHint'))}</span>
          </div>
          <div class="admin-field-group">
            <label>${escapeHtml(t('admin.oidc.scopes'))}</label>
            <input type="text" name="scopes" value="${escapeHtml(oidc?.scopes || 'openid profile email')}" autocomplete="off">
          </div>
          <div class="admin-field-group">
            <label>${escapeHtml(t('admin.oidc.usernameClaim'))}</label>
            <input type="text" name="usernameClaim" value="${escapeHtml(oidc?.usernameClaim || '')}" placeholder="preferred_username" autocomplete="off">
            <span class="admin-field-hint">${escapeHtml(t('admin.oidc.usernameClaimHint'))}</span>
          </div>
          <div class="admin-field-group">
            <label>${escapeHtml(t('admin.oidc.adminClaim'))}</label>
            <input type="text" name="adminClaim" value="${escapeHtml(oidc?.adminClaim || '')}" placeholder="groups" autocomplete="off">
            <span class="admin-field-hint">${escapeHtml(t('admin.oidc.adminClaimHint'))}</span>
          </div>
          <div class="admin-field-group">
            <label>${escapeHtml(t('admin.oidc.adminValue'))}</label>
            <input type="text" name="adminValue" value="${escapeHtml(oidc?.adminValue || '')}" placeholder="inpx-admins" autocomplete="off">
          </div>
        </div>
        <div class="admin-field-group" style="flex-direction:row;align-items:center;gap:10px;margin-top:8px;">
          <label class="admin-checkbox-label" style="text-transform:none;letter-spacing:0;">
            <input type="hidden" name="blockLocalRegister" value="0">
            <input type="checkbox" name="blockLocalRegister" value="1" ${oidc?.blockLocalRegister ? 'checked' : ''} style="accent-color:var(--accent);width:16px;height:16px;">
            ${escapeHtml(t('admin.oidc.blockLocalRegister'))}
          </label>
        </div>
        <div class="admin-field-group" style="flex-direction:row;align-items:center;gap:10px;">
          <label class="admin-checkbox-label" style="text-transform:none;letter-spacing:0;">
            <input type="hidden" name="requireEmailVerified" value="0">
            <input type="checkbox" name="requireEmailVerified" value="1" ${oidc?.requireEmailVerified !== false ? 'checked' : ''} style="accent-color:var(--accent);width:16px;height:16px;">
            ${escapeHtml(t('admin.oidc.requireEmailVerified'))}
          </label>
        </div>
        <div class="admin-actions-row">
          <button type="submit">${escapeHtml(t('admin.save'))}</button>
        </div>
      </form>`
    })}

    <div class="admin-card">
      <form method="post" action="/admin/settings/anonymous-access" class="admin-action-item" data-track-dirty>
        ${csrfHiddenField(csrfToken)}
        <div class="admin-action-item-info">
          <strong>${escapeHtml(t('admin.users.anonymous'))}</strong>
          <span class="muted">${escapeHtml(t('admin.users.anonymousHint'))}</span>
          <div class="admin-inline-row" style="gap:12px;margin-top:8px;">
            <label class="admin-checkbox-label">
              <input type="hidden" name="allow_anonymous_browse" value="0">
              <input type="checkbox" name="allow_anonymous_browse" value="1" ${allowAnonymousBrowse ? 'checked' : ''}>
              ${escapeHtml(t('admin.users.catalog'))}
            </label>
            <label class="admin-checkbox-label">
              <input type="hidden" name="allow_anonymous_download" value="0">
              <input type="checkbox" name="allow_anonymous_download" value="1" ${allowAnonymousDownload ? 'checked' : ''}>
              ${escapeHtml(t('admin.users.download'))}
            </label>
            <label class="admin-checkbox-label">
              <input type="hidden" name="allow_anonymous_opds" value="0">
              <input type="checkbox" name="allow_anonymous_opds" value="1" ${allowAnonymousOpds ? 'checked' : ''}>
              ${escapeHtml(t('admin.users.opds'))}
            </label>
          </div>
        </div>
        <div class="admin-actions-row">
          <button type="submit">${escapeHtml(t('admin.save'))}</button>
        </div>
      </form>
      <div class="admin-action-item">
        <div class="admin-action-item-info">
          <strong>${escapeHtml(t('admin.users.registration'))}</strong>
          <span class="muted">${escapeHtml(t('admin.users.registrationHint'))}</span>
        </div>
        <div class="admin-actions-row">
          <form method="post" action="/admin/settings/registration" class="admin-inline-form">
            ${csrfHiddenField(csrfToken)}
            <input type="hidden" name="enabled" value="${registrationEnabled ? '0' : '1'}">
            <button type="submit" class="${registrationEnabled ? 'button-danger' : ''}">${registrationEnabled ? escapeHtml(t('admin.users.disable')) : escapeHtml(t('admin.users.enable'))}</button>
          </form>
        </div>
      </div>
      <form id="registration-invite-form" method="post" action="/admin/settings/registration-invite" class="admin-action-item" style="flex-wrap:wrap;align-items:flex-end;" data-ajax>
        ${csrfHiddenField(csrfToken)}
        <div class="admin-action-item-info" style="flex:1 1 100%;">
          <strong>${escapeHtml(t('admin.users.inviteToken'))}</strong>
          <span class="muted">${escapeHtml(t('admin.users.inviteTokenHint'))}</span>
        </div>
        <div class="admin-field-group" style="flex:1;min-width:220px;margin:0;">
          <input id="registration-invite-token" name="token" value="${escapeHtml(registrationInviteToken)}" autocomplete="off" spellcheck="false" maxlength="128">
        </div>
        <div class="admin-actions-row">
          <button type="submit" name="inviteAction" value="generate">${escapeHtml(t('admin.users.inviteGenerate'))}</button>
          <button type="submit" name="inviteAction" value="save">${escapeHtml(t('admin.save'))}</button>
        </div>
        <div id="registration-invite-link-wrap" class="admin-field-group" style="flex:1 1 100%;margin:8px 0 0;${registrationInviteUrl ? '' : 'display:none;'}">
          <label for="registration-invite-url">${escapeHtml(t('admin.users.inviteLink'))}</label>
          <div class="admin-inline-row" style="gap:8px;width:100%;">
            <input id="registration-invite-url" type="url" readonly value="${escapeHtml(registrationInviteUrl)}" autocomplete="off" style="flex:1;min-width:0;">
            <button type="button" data-copy-invite data-copy-text="${escapeHtml(registrationInviteUrl)}" data-copy-done="${escapeHtml(t('admin.users.inviteCopied'))}">${escapeHtml(t('admin.users.inviteCopy'))}</button>
          </div>
        </div>
      </form>
      <div class="admin-action-item">
        <div class="admin-action-item-info">
          <strong>${escapeHtml(t('admin.users.recaptcha'))}</strong>
          <span class="muted">${escapeHtml(t('admin.users.recaptchaHint'))} <a href="https://www.google.com/recaptcha/admin" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">google.com/recaptcha/admin</a></span>
        </div>
      </div>
      <details class="admin-recaptcha-disclosure">
        <summary class="admin-recaptcha-disclosure-summary">${escapeHtml(t('admin.users.keys'))}</summary>
        <div class="admin-recaptcha-disclosure-body">
          <form method="post" action="/admin/settings/recaptcha" data-track-dirty>
            ${csrfHiddenField(csrfToken)}
            <div class="admin-form-grid admin-form-grid--align-start">
              <div class="admin-field-group">
                <label>Site Key</label>
                <input name="siteKey" value="${escapeHtml(recaptchaSiteKey)}" placeholder="6Le..." autocomplete="off">
              </div>
              <div class="admin-field-group">
                <label>Secret Key</label>
                <input name="secretKey" value="" placeholder="${recaptchaSecretKey ? '••••••••' + escapeHtml(recaptchaSecretKey.slice(-4)) : '6Le...'}" autocomplete="off">
              </div>
            </div>
            <div class="admin-actions-row">
              <button type="submit">${escapeHtml(t('admin.save'))}</button>
            </div>
          </form>
        </div>
      </details>
      <hr class="admin-divider">
      <div class="admin-card-title">${escapeHtml(t('admin.users.newUser'))}</div>
      <form action="/admin/users/create" method="post">
        ${csrfHiddenField(csrfToken)}
        <div class="admin-form-grid admin-form-grid--3">
          <div class="admin-field-group">
            <label for="new-username">${escapeHtml(t('login.username'))}</label>
            <input id="new-username" name="username" autocomplete="off">
          </div>
          <div class="admin-field-group">
            <label for="new-password">${escapeHtml(t('login.password'))}</label>
            <input id="new-password" type="password" name="password" autocomplete="new-password">
          </div>
          <div class="admin-field-group">
            <label for="new-role">${escapeHtml(t('admin.users.role'))}</label>
            <select id="new-role" name="role">
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
        </div>
        <div class="admin-actions-row">
          <button type="submit">${escapeHtml(t('admin.users.create'))}</button>
        </div>
      </form>
      <hr class="admin-divider">
      <div class="admin-inline-row" style="align-items:baseline;margin-bottom:10px;">
        <span class="admin-section-label" style="font-size:14px;margin-bottom:0;text-transform:none;letter-spacing:0;">${escapeHtml(t('admin.users.usersTitle'))}</span>
        <span class="muted" style="font-size:12px;">${escapeHtml(tp('admin.users.total', { users: countLabel('user', users.length), admins: countLabel('admin', adminCount) }))}</span>
      </div>
      ${admins.length ? `
        <div class="admin-section-label">${escapeHtml(tp('admin.users.adminsGroup', { n: admins.length }))}</div>
        <div class="table-list admin-users-list" style="margin-bottom:16px;">
          ${renderUserRows(admins)}
        </div>
      ` : ''}
      ${regularUsers.length ? `
        <div class="admin-section-label">${escapeHtml(tp('admin.users.usersGroup', { n: regularUsers.length }))}</div>
        <div class="table-list admin-users-list">
          ${renderUserRows(regularUsers)}
        </div>
      ` : renderEmptyState({ title: t('admin.users.emptyTitle'), text: t('admin.users.emptyText') })}
    </div>
  `;
  return pageShell({ title: t('admin.nav.users'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.nav.users') }], mode: 'admin', currentPath: '/admin/users', csrfToken });
}


export function renderAdminEvents({ user, stats, indexStatus, events = [], total = 0, categories = [], filters = {}, retainCount = 200, maxCount = 1000, flash = '', csrfToken = '' }) {
  const currentLevel = String(filters.level || '');
  const currentCategory = String(filters.category || '');
  const currentPreset = String(filters.preset || '');
  const presetItems = [
    { value: 'errors', label: t('admin.events.presetErrors') },
    { value: 'operations', label: t('admin.events.presetOps') },
    { value: 'auth', label: t('admin.events.presetAuth') }
  ];
  const levelBadge = (level) => {
    const cls = level === 'error' ? 'event-level-error' : level === 'warn' ? 'event-level-warn' : 'event-level-info';
    return `<span class="event-level-badge ${cls}">${escapeHtml(String(level || '').toUpperCase())}</span>`;
  };
  const eventsRows = events.length
    ? events.map((event) => `
          <div class="admin-events-row table-row ${event.level === 'error' ? 'event-error' : ''} ${event.id === events[0]?.id ? 'event-fresh' : ''}">
            <div>
              ${levelBadge(event.level)}
              <span class="admin-event-category">${escapeHtml(event.category)}</span>
              <span class="admin-events-message">${escapeHtml(event.message)}</span>
              <div class="admin-event-meta">
                <span class="muted">${escapeHtml(formatLocaleDateTimeShort(event.createdAt))}</span>
                ${event.details ? `<span class="muted">${renderEventDetailsHtml(event.details)}</span>` : ''}
              </div>
            </div>
          </div>`).join('')
    : `<div class="muted admin-events-empty">${escapeHtml(t('admin.events.empty'))}</div>`;
  const content = `
    ${flash ? renderAlert('success', flash) : ''}

    <div class="admin-card" data-admin-events-page>
      <div class="admin-events-bar">
        <div class="admin-events-presets">
          ${presetItems.map((preset) => `<a class="button ${currentPreset === preset.value ? 'is-active' : ''}" href="/admin/events?preset=${encodeURIComponent(preset.value)}">${preset.label}</a>`).join('')}
          ${currentPreset ? `<a class="button" href="/admin/events">${escapeHtml(t('admin.events.all'))}</a>` : ''}
        </div>
        <form action="/admin/events" method="get" style="display:contents;">
          ${currentPreset ? `<input type="hidden" name="preset" value="${escapeHtml(currentPreset)}">` : ''}
          <select name="level" onchange="this.form.submit()">
            <option value="">${escapeHtml(t('admin.events.levelAll'))}</option>
            <option value="info" ${currentLevel === 'info' ? 'selected' : ''}>INFO</option>
            <option value="warn" ${currentLevel === 'warn' ? 'selected' : ''}>WARN</option>
            <option value="error" ${currentLevel === 'error' ? 'selected' : ''}>ERROR</option>
          </select>
          <select name="category" onchange="this.form.submit()">
            <option value="">${escapeHtml(t('admin.events.categoryAll'))}</option>
            ${categories.map((category) => `<option value="${escapeHtml(category)}" ${currentCategory === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}
          </select>
          ${(currentLevel || currentCategory || currentPreset) ? `<a class="button" href="/admin/events">${escapeHtml(t('admin.events.reset'))}</a>` : ''}
        </form>
        <span class="admin-events-bar-spacer"></span>
        <div class="admin-events-actions">
          <span class="muted admin-compact-btn" style="align-self:center;" data-admin-events-total>${countLabel('record', total)}</span>
          <a class="button" href="/admin/live-logs" target="_blank" rel="noopener noreferrer">${escapeHtml(t('admin.nav.liveLogs'))}</a>
          <button type="button" data-operation-action="events-retain" data-operation-label="${escapeHtml(tp('admin.events.retain', { n: retainCount }))}">${escapeHtml(tp('admin.events.retain', { n: retainCount }))}</button>
          <form action="/admin/events/clear" method="post" class="admin-events-clear-form" data-confirm="${escapeHtml(t('admin.events.clearConfirm'))}" data-confirm-danger>
            ${csrfHiddenField(csrfToken)}
            <button type="submit" class="button-danger">${escapeHtml(t('admin.events.clear'))}</button>
          </form>
        </div>
      </div>

      <div class="admin-events-scroll" data-events-list>${eventsRows}</div>
    </div>
  `;
  return pageShell({ title: t('admin.events.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.events.title') }], mode: 'admin', currentPath: '/admin/events', csrfToken });
}


export function renderAdminContent({
  user,
  stats,
  indexStatus,
  languages = [],
  excludedLangSet = new Set(),
  genres = [],
  excludedGenreSet = new Set(),
  disabledDownloadFormatSet = new Set(),
  downloadFilenameStyle = 'translit-full',
  fb2WebpMode = 'keep',
  showDeletedBooks = false,
  flash = '',
  csrfToken = ''
}) {
  const langExcludedCount = languages.filter(l => excludedLangSet.has(l.code)).length;
  const genreExcludedCount = genres.filter(g => excludedGenreSet.has(g.code)).length;
  const downloadFormatRows = getConfiguredDownloadFormats().map((code) => {
    const checked = !disabledDownloadFormatSet.has(code);
    return `
      <tr class="${checked ? '' : 'lang-row-disabled'}">
        <td data-label="" style="text-align:center">
          <input type="checkbox" name="enabled_download_format" value="${escapeHtml(code)}" aria-label="${escapeHtml(FORMAT_LABELS[code] || code.toUpperCase())}" ${checked ? 'checked' : ''}>
        </td>
        <td data-label="${escapeHtml(t('admin.content.thName'))}">${escapeHtml(FORMAT_LABELS[code] || code.toUpperCase())}</td>
        <td data-label="${escapeHtml(t('admin.content.thCode'))}" class="muted">${escapeHtml(code)}</td>
      </tr>`;
  }).join('');

  const langRows = languages.map(lang => {
    const checked = !excludedLangSet.has(lang.code);
    const label = formatLanguageLabel(lang.code);
    return `
      <tr class="${checked ? '' : 'lang-row-disabled'}">
        <td data-label="" style="text-align:center">
          <input type="checkbox" name="enabled_lang" value="${escapeHtml(lang.code)}" aria-label="${escapeHtml(label)}" ${checked ? 'checked' : ''}>
        </td>
        <td data-label="${escapeHtml(t('admin.content.thName'))}">${escapeHtml(label)}</td>
        <td data-label="${escapeHtml(t('admin.content.thCode'))}" class="muted">${escapeHtml(lang.code)}</td>
        <td data-label="${escapeHtml(t('admin.content.thBooks'))}" style="text-align:right">${formatLocaleInt(lang.bookCount)}</td>
      </tr>`;
  }).join('');

  // Группировка жанров с сортировкой по алфавиту внутри каждой группы
  const genreMap = new Map(genres.map(g => [g.code, g]));
  const groupsDef = getGenreGroups();
  const genreGroupsHtml = [];
  const allGroupedCodes = new Set(Object.values(groupsDef).flat());
  let groupIdx = 0;
  const sortByLabel = (a, b) => {
    const la = formatGenreLabel(a.code);
    const lb = formatGenreLabel(b.code);
    return la.localeCompare(lb, getLocale() === 'en' ? 'en' : 'ru');
  };
  for (const [groupName, codes] of Object.entries(groupsDef)) {
    const items = codes.map(c => genreMap.get(c)).filter(Boolean).sort(sortByLabel);
    if (!items.length) continue;
    const gid = `gg-${groupIdx++}`;
    const allChecked = items.every(g => !excludedGenreSet.has(g.code));
    const noneChecked = items.every(g => excludedGenreSet.has(g.code));
    const excludedInGroup = items.filter(g => excludedGenreSet.has(g.code)).length;
    const rows = items.map(genre => {
      const checked = !excludedGenreSet.has(genre.code);
      const label = formatGenreLabel(genre.code);
      return `
        <tr class="${checked ? '' : 'lang-row-disabled'}">
          <td data-label="" style="text-align:center">
            <input type="checkbox" name="enabled_genre" value="${escapeHtml(genre.code)}" aria-label="${escapeHtml(label)}" ${checked ? 'checked' : ''}>
          </td>
          <td data-label="${escapeHtml(t('admin.content.thName'))}">${escapeHtml(label)}</td>
          <td data-label="${escapeHtml(t('admin.content.thCode'))}" class="muted">${escapeHtml(genre.code)}</td>
          <td data-label="${escapeHtml(t('admin.content.thBooks'))}" style="text-align:right">${formatLocaleInt(genre.bookCount)}</td>
        </tr>`;
    }).join('');
    genreGroupsHtml.push(`
      <div class="acg" style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;background:var(--surface)" onclick="var p=this.parentElement;p.dataset.open=p.dataset.open==='1'?'':'1'">
          <input type="checkbox" style="flex:none;width:auto" class="genre-group-toggle" data-group="${gid}" aria-label="${escapeHtml(t('admin.content.toggleAll'))}" ${allChecked ? 'checked' : ''} ${!allChecked && !noneChecked ? 'data-indeterminate="1"' : ''} onclick="event.stopPropagation()">
          <span style="flex:1 1 auto;font-weight:600;font-size:15px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escapeHtml(groupName)}</span>
          <span style="flex:none;font-size:13px;color:var(--muted)">${items.length}${excludedInGroup > 0 ? ' / -' + excludedInGroup : ''}</span>
          <span class="acg-arrow" style="flex:none;font-size:11px;color:var(--muted);transition:transform .15s">&#9654;</span>
        </div>
        <div class="acg-body" style="border-top:1px solid var(--border)">
          <table class="admin-table acg-table">
            <colgroup><col style="width:40px"><col><col style="width:30%"><col style="width:80px"></colgroup>
            <thead>
              <tr>
                <th style="width:50px;text-align:center"></th>
                <th>${escapeHtml(t('admin.content.thName'))}</th>
                <th>${escapeHtml(t('admin.content.thCode'))}</th>
                <th style="text-align:right">${escapeHtml(t('admin.content.thBooks'))}</th>
              </tr>
            </thead>
            <tbody data-group="${gid}">${rows}</tbody>
          </table>
        </div>
      </div>`);
  }
  // Uncategorized genres — тоже сортируем по алфавиту
  const uncategorized = genres.filter(g => !allGroupedCodes.has(g.code)).sort(sortByLabel);
  if (uncategorized.length) {
    const gid = `gg-${groupIdx++}`;
    const allChecked = uncategorized.every(g => !excludedGenreSet.has(g.code));
    const noneChecked = uncategorized.every(g => excludedGenreSet.has(g.code));
    const excludedInGroup = uncategorized.filter(g => excludedGenreSet.has(g.code)).length;
    const rows = uncategorized.map(genre => {
      const checked = !excludedGenreSet.has(genre.code);
      const label = formatGenreLabel(genre.code);
      return `
        <tr class="${checked ? '' : 'lang-row-disabled'}">
          <td data-label="" style="text-align:center">
            <input type="checkbox" name="enabled_genre" value="${escapeHtml(genre.code)}" aria-label="${escapeHtml(label)}" ${checked ? 'checked' : ''}>
          </td>
          <td data-label="${escapeHtml(t('admin.content.thName'))}">${escapeHtml(label)}</td>
          <td data-label="${escapeHtml(t('admin.content.thCode'))}" class="muted">${escapeHtml(genre.code)}</td>
          <td data-label="${escapeHtml(t('admin.content.thBooks'))}" style="text-align:right">${formatLocaleInt(genre.bookCount)}</td>
        </tr>`;
    }).join('');
    genreGroupsHtml.push(`
      <div class="acg" style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;background:var(--surface)" onclick="var p=this.parentElement;p.dataset.open=p.dataset.open==='1'?'':'1'">
          <input type="checkbox" style="flex:none;width:auto" class="genre-group-toggle" data-group="${gid}" aria-label="${escapeHtml(t('admin.content.toggleAll'))}" ${allChecked ? 'checked' : ''} ${!allChecked && !noneChecked ? 'data-indeterminate="1"' : ''} onclick="event.stopPropagation()">
          <span style="flex:1 1 auto;font-weight:600;font-size:15px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escapeHtml(t('genre.other'))}</span>
          <span style="flex:none;font-size:13px;color:var(--muted)">${uncategorized.length}${excludedInGroup > 0 ? ' / -' + excludedInGroup : ''}</span>
          <span class="acg-arrow" style="flex:none;font-size:11px;color:var(--muted);transition:transform .15s">&#9654;</span>
        </div>
        <div class="acg-body" style="border-top:1px solid var(--border)">
          <table class="admin-table acg-table">
            <colgroup><col style="width:40px"><col><col style="width:30%"><col style="width:80px"></colgroup>
            <thead>
              <tr>
                <th style="width:50px;text-align:center"></th>
                <th>${escapeHtml(t('admin.content.thName'))}</th>
                <th>${escapeHtml(t('admin.content.thCode'))}</th>
                <th style="text-align:right">${escapeHtml(t('admin.content.thBooks'))}</th>
              </tr>
            </thead>
            <tbody data-group="${gid}">${rows}</tbody>
          </table>
        </div>
      </div>`);
  }

  const content = `
    ${flash ? renderAlert('success', flash) : ''}
    <div class="admin-card" style="margin-bottom:16px;border-left:4px solid var(--accent-color)">
      <div class="admin-card-title">${escapeHtml(t('admin.content.statsTitle'))}</div>
      <p class="muted" style="margin:8px 0">${escapeHtml(tp('admin.content.statsDesc', { langTotal: languages.length, langExcluded: langExcludedCount, genreTotal: genres.length, genreExcluded: genreExcludedCount }))}</p>
    </div>
    <form method="POST" action="/admin/content">
      ${csrfHiddenField(csrfToken)}
      <div class="admin-card" style="margin-bottom:16px">
        <div class="admin-card-title">${escapeHtml(t('admin.content.deletedSection'))}</div>
        <p class="muted admin-compact-btn" style="margin:4px 0 12px;">${escapeHtml(t('admin.content.deletedHint'))}</p>
        <label class="admin-check-row" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" name="show_deleted_books" value="1" ${showDeletedBooks ? 'checked' : ''} style="margin-top:3px">
          <span>
            <strong>${escapeHtml(t('admin.content.deletedToggle'))}</strong>
            <span class="muted" style="display:block;margin-top:4px;font-size:13px">${escapeHtml(t('admin.content.deletedToggleHint'))}</span>
          </span>
        </label>
      </div>
      <div class="admin-card" style="margin-bottom:16px">
        <div class="admin-card-title" style="display:flex;align-items:center;gap:12px">
          ${escapeHtml(t('admin.content.downloadSection'))}
          <label style="font-size:13px;font-weight:400;display:flex;align-items:center;gap:4px">
            <input type="checkbox" id="download-format-toggle-all" title="${escapeHtml(t('admin.content.toggleAll'))}">
            <span class="muted">${escapeHtml(t('admin.content.toggleAll'))}</span>
          </label>
        </div>
        <p class="muted admin-compact-btn" style="margin:4px 0 12px;">${escapeHtml(t('admin.content.downloadHint'))}</p>
        ${config.fb2cngPath ? '' : `<p class="muted admin-compact-btn" style="margin:0 0 12px;">${escapeHtml(t('admin.content.downloadFb2cngHint'))}</p>`}
        <table class="admin-table">
          <thead>
            <tr>
              <th style="width:50px;text-align:center"></th>
              <th>${escapeHtml(t('admin.content.thName'))}</th>
              <th>${escapeHtml(t('admin.content.thCode'))}</th>
            </tr>
          </thead>
          <tbody>${downloadFormatRows}</tbody>
        </table>
      </div>
      <div class="admin-card" style="margin-bottom:16px">
        <div class="admin-card-title">${escapeHtml(t('admin.content.filenameSection'))}</div>
        <p class="muted admin-compact-btn" style="margin:4px 0 12px;">${escapeHtml(t('admin.content.filenameHint'))}</p>
        <div class="admin-field-group">
          <label for="download-filename-style">${escapeHtml(t('admin.content.filenameLabel'))}</label>
          <select id="download-filename-style" name="download_filename_style" style="max-width:420px">
            ${DOWNLOAD_FILENAME_STYLES.map((style) => `
              <option value="${escapeHtml(style)}" ${downloadFilenameStyle === style ? 'selected' : ''}>${escapeHtml(t(`admin.content.filename.${style}`))}</option>
            `).join('')}
          </select>
        </div>
      </div>
      <div class="admin-card" style="margin-bottom:16px">
        <div class="admin-card-title">${escapeHtml(t('admin.content.webpSection'))}</div>
        <p class="muted admin-compact-btn" style="margin:4px 0 12px;">${escapeHtml(t('admin.content.webpHint'))}</p>
        <div class="admin-field-group">
          <label for="fb2-webp-images">${escapeHtml(t('admin.content.webpLabel'))}</label>
          <select id="fb2-webp-images" name="fb2_webp_images" style="max-width:420px">
            ${FB2_WEBP_MODES.map((mode) => `
              <option value="${escapeHtml(mode)}" ${fb2WebpMode === mode ? 'selected' : ''}>${escapeHtml(t(`admin.content.webp.${mode}`))}</option>
            `).join('')}
          </select>
        </div>
      </div>
      <div class="admin-card" style="margin-bottom:16px">
        <div class="admin-card-title" style="display:flex;align-items:center;gap:12px">
          ${escapeHtml(t('admin.content.langSection'))}
          <label style="font-size:13px;font-weight:400;display:flex;align-items:center;gap:4px">
            <input type="checkbox" id="lang-toggle-all" title="${escapeHtml(t('admin.content.toggleAll'))}">
            <span class="muted">${escapeHtml(t('admin.content.toggleAll'))}</span>
          </label>
        </div>
        <p class="muted admin-compact-btn" style="margin:4px 0 12px;">${escapeHtml(t('admin.content.langHint'))}</p>
        <div class="acg" style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
          <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;background:var(--surface)" onclick="var p=this.parentElement;p.dataset.open=p.dataset.open==='1'?'':'1'">
            <span style="flex:1 1 auto;font-weight:600;font-size:15px">${escapeHtml(tp('admin.content.langListTitle', { total: languages.length }))}</span>
            <span style="flex:none;font-size:13px;color:var(--muted)">${langExcludedCount > 0 ? '−' + langExcludedCount + ' ' + escapeHtml(t('admin.content.hidden')) : ''}</span>
            <span class="acg-arrow" style="flex:none;font-size:11px;color:var(--muted);transition:transform .15s">&#9654;</span>
          </div>
          <div class="acg-body" style="border-top:1px solid var(--border)">
            <table class="admin-table acg-table">
              <thead>
                <tr>
                  <th style="width:50px;text-align:center"></th>
                  <th>${escapeHtml(t('admin.content.thName'))}</th>
                  <th>${escapeHtml(t('admin.content.thCode'))}</th>
                  <th style="text-align:right">${escapeHtml(t('admin.content.thBooks'))}</th>
                </tr>
              </thead>
              <tbody>${langRows}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="admin-card" style="margin-bottom:16px">
        <div class="admin-card-title" style="display:flex;align-items:center;gap:12px">
          ${escapeHtml(t('admin.content.genreSection'))}
          <label style="font-size:13px;font-weight:400;display:flex;align-items:center;gap:4px">
            <input type="checkbox" id="genre-toggle-all" title="${escapeHtml(t('admin.content.toggleAll'))}">
            <span class="muted">${escapeHtml(t('admin.content.toggleAll'))}</span>
          </label>
        </div>
        <p class="muted admin-compact-btn" style="margin:4px 0 12px;">${escapeHtml(t('admin.content.genreHint'))}</p>
        <div class="acg-list">
          ${genreGroupsHtml.join('')}
        </div>
      </div>
      <div class="admin-inline-row" style="margin-top:16px;gap:12px;">
        <button type="submit" class="button button-primary">${escapeHtml(t('admin.content.save'))}</button>
        <span class="muted admin-compact-btn">${escapeHtml(t('admin.content.saveHint'))}</span>
      </div>
    </form>
    <script>
      document.getElementById('download-format-toggle-all')?.addEventListener('change', function() {
        document.querySelectorAll('input[name="enabled_download_format"]').forEach(cb => { cb.checked = this.checked; });
      });
      document.querySelectorAll('input[name="enabled_download_format"]').forEach(cb => {
        cb.addEventListener('change', updateGlobalDownloadFormatToggle);
      });
      function updateGlobalDownloadFormatToggle() {
        const all = document.querySelectorAll('input[name="enabled_download_format"]');
        const checked = [...all].filter(c => c.checked).length;
        const globalToggle = document.getElementById('download-format-toggle-all');
        if (globalToggle) {
          globalToggle.checked = checked === all.length;
          globalToggle.indeterminate = checked > 0 && checked < all.length;
        }
      }
      updateGlobalDownloadFormatToggle();
      document.getElementById('lang-toggle-all')?.addEventListener('change', function() {
        document.querySelectorAll('input[name="enabled_lang"]').forEach(cb => { cb.checked = this.checked; });
      });
      document.querySelectorAll('input[name="enabled_lang"]').forEach(cb => {
        cb.addEventListener('change', updateGlobalLangToggle);
      });
      function updateGlobalLangToggle() {
        const all = document.querySelectorAll('input[name="enabled_lang"]');
        const checked = [...all].filter(c => c.checked).length;
        const globalToggle = document.getElementById('lang-toggle-all');
        if (globalToggle) {
          globalToggle.checked = checked === all.length;
          globalToggle.indeterminate = checked > 0 && checked < all.length;
        }
      }
      updateGlobalLangToggle();
      // Global genre toggle
      document.getElementById('genre-toggle-all')?.addEventListener('change', function() {
        const checked = this.checked;
        document.querySelectorAll('input[name="enabled_genre"]').forEach(cb => { cb.checked = checked; });
        document.querySelectorAll('.genre-group-toggle').forEach(cb => { cb.checked = checked; cb.indeterminate = false; });
      });
      // Per-group toggles
      document.querySelectorAll('.genre-group-toggle').forEach(toggle => {
        toggle.addEventListener('click', function(e) { e.stopPropagation(); });
        toggle.addEventListener('change', function() {
          const gid = this.dataset.group;
          const tbody = document.querySelector('tbody[data-group="' + gid + '"]');
          if (!tbody) return;
          tbody.querySelectorAll('input[name="enabled_genre"]').forEach(cb => { cb.checked = this.checked; });
          updateGlobalGenreToggle();
        });
      });
      // Update group toggle state when individual checkboxes change
      document.querySelectorAll('input[name="enabled_genre"]').forEach(cb => {
        cb.addEventListener('change', function() {
          const tbody = this.closest('tbody[data-group]');
          if (!tbody) return;
          const gid = tbody.dataset.group;
          const groupToggle = document.querySelector('.genre-group-toggle[data-group="' + gid + '"]');
          if (!groupToggle) return;
          const boxes = tbody.querySelectorAll('input[name="enabled_genre"]');
          const checked = [...boxes].filter(c => c.checked).length;
          groupToggle.checked = checked === boxes.length;
          groupToggle.indeterminate = checked > 0 && checked < boxes.length;
          updateGlobalGenreToggle();
        });
      });
      // Set initial indeterminate state
      document.querySelectorAll('.genre-group-toggle[data-indeterminate]').forEach(cb => { cb.indeterminate = true; });
      function updateGlobalGenreToggle() {
        const all = document.querySelectorAll('input[name="enabled_genre"]');
        const checked = [...all].filter(c => c.checked).length;
        const globalToggle = document.getElementById('genre-toggle-all');
        if (globalToggle) {
          globalToggle.checked = checked === all.length;
          globalToggle.indeterminate = checked > 0 && checked < all.length;
        }
      }
      updateGlobalGenreToggle();
    </script>`;

  return pageShell({
    title: t('admin.content.pageTitle'),
    content,
    user,
    stats,
    indexStatus,
    breadcrumbs: [{ label: t('admin.badge'), href: '/admin' }, { label: t('admin.content.pageTitle') }],
    mode: 'admin',
    currentPath: '/admin/content',
    csrfToken
  });
}

export function renderAdminDuplicates({ user, stats, indexStatus, flash = '', csrfToken = '' }) {
  /* Поиск дубликатов запускается автоматически при заходе на страницу —
     отдельной кнопки нет. Прогресс-полоска и список рисуются клиентским JS
     (см. initDuplicatesPage в public/app.js). */
  const content = `
    ${flash ? renderAlert('success', flash) : ''}
    <div data-duplicates-page data-page="1">
      <div id="dup-filter-wrap"></div>
      <div id="dup-results"></div>
      <div id="supp-wrap"></div>
    </div>
  `;
  return pageShell({ title: t('admin.nav.duplicates'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.nav.duplicates') }], mode: 'admin', currentPath: '/admin/duplicates', csrfToken });
}

/* ── Форма расписания сканирования (Off / Каждые N часов / Ежедневно / По дням недели) ── */
function renderScanScheduleForm({ csrfToken, scanSchedule, scanScheduleNextRunAt, scanScheduleLog = [], scanIntervalHours = 0 }) {
  const cfg = scanSchedule || { mode: scanIntervalHours > 0 ? 'interval' : 'off', hours: scanIntervalHours, time: '03:00', dow: [], full: false };
  const mode = cfg.mode || 'off';
  const hours = Number(cfg.hours) || (scanIntervalHours || 24);
  const time = cfg.time || '03:00';
  const dowSet = new Set((cfg.dow || []).map(Number));
  const full = Boolean(cfg.full);

  const dowLabels = [
    t('admin.schedule.dow.sun'), t('admin.schedule.dow.mon'), t('admin.schedule.dow.tue'),
    t('admin.schedule.dow.wed'), t('admin.schedule.dow.thu'), t('admin.schedule.dow.fri'),
    t('admin.schedule.dow.sat')
  ];

  const dowCheckboxes = [1, 2, 3, 4, 5, 6, 0].map((d) => `
    <label class="admin-dow-chip">
      <input type="checkbox" name="dow" value="${d}" ${dowSet.has(d) ? 'checked' : ''}>
      <span>${escapeHtml(dowLabels[d])}</span>
    </label>
  `).join('');

  const renderLogRows = (log) => {
    if (!log || !log.length) {
      return `<tr><td colspan="3" class="muted" style="text-align:center;padding:8px">${escapeHtml(t('admin.schedule.logEmpty'))}</td></tr>`;
    }
    return log.map((row) => {
      const when = formatLocaleDateTimeShort(row.ranAt);
      const kind = row.full ? t('admin.schedule.kindFull') : t('admin.schedule.kindIncremental');
      const statusText = row.status === 'error'
        ? `${t('admin.schedule.statusError')}: ${escapeHtml(row.message || '')}`
        : (row.status === 'ok' ? t('admin.schedule.statusOk') : t('admin.schedule.statusStarted'));
      return `<tr>
        <td>${escapeHtml(when)}</td>
        <td><span class="admin-chip" style="font-size:.85em">${escapeHtml(kind)}</span></td>
        <td>${statusText}</td>
      </tr>`;
    }).join('');
  };

  return `
    <form action="/admin/settings/scan-schedule" method="post" data-track-dirty data-scan-schedule-form>
      ${csrfHiddenField(csrfToken)}
      <div class="admin-action-item">
        <div class="admin-action-item-info">
          <strong>${escapeHtml(t('admin.schedule.title'))}</strong>
          <span class="muted">${escapeHtml(t('admin.schedule.hint'))}</span>

          <div class="scan-schedule-fields">
            <div class="admin-field-group">
              <label for="scan-schedule-mode">${escapeHtml(t('admin.schedule.modeLabel'))}</label>
              <select id="scan-schedule-mode" name="mode" data-scan-schedule-mode>
                <option value="off"      ${mode === 'off'      ? 'selected' : ''}>${escapeHtml(t('admin.schedule.modeOff'))}</option>
                <option value="interval" ${mode === 'interval' ? 'selected' : ''}>${escapeHtml(t('admin.schedule.modeInterval'))}</option>
                <option value="daily"    ${mode === 'daily'    ? 'selected' : ''}>${escapeHtml(t('admin.schedule.modeDaily'))}</option>
                <option value="weekly"   ${mode === 'weekly'   ? 'selected' : ''}>${escapeHtml(t('admin.schedule.modeWeekly'))}</option>
              </select>
            </div>

            <div class="admin-field-group" data-scan-schedule-when="interval" ${mode === 'interval' ? '' : 'hidden'}>
              <label for="scan-schedule-hours">${escapeHtml(t('admin.schedule.hoursLabel'))}</label>
              <div class="admin-inline-row">
                <input id="scan-schedule-hours" type="number" name="hours" value="${hours}" min="1" max="8760" class="admin-input-sm">
                <span class="muted">${escapeHtml(t('admin.settings.scanHours'))}</span>
              </div>
            </div>

            <div class="admin-field-group" data-scan-schedule-when="daily" ${mode === 'daily' ? '' : 'hidden'}>
              <label for="scan-schedule-time-daily">${escapeHtml(t('admin.schedule.timeLabel'))}</label>
              <input id="scan-schedule-time-daily" type="time" name="time_daily" value="${escapeHtml(time)}" class="admin-input-sm" data-scan-schedule-time>
            </div>

            <div class="admin-field-group" data-scan-schedule-when="weekly" ${mode === 'weekly' ? '' : 'hidden'}>
              <label for="scan-schedule-time-weekly">${escapeHtml(t('admin.schedule.timeLabel'))}</label>
              <input id="scan-schedule-time-weekly" type="time" name="time_weekly" value="${escapeHtml(time)}" class="admin-input-sm" data-scan-schedule-time>
              <div class="admin-dow-row" style="margin-top:6px">${dowCheckboxes}</div>
              <span class="admin-field-hint">${escapeHtml(t('admin.schedule.weeklyHint'))}</span>
            </div>

            <div class="admin-field-group">
              <label for="scan-schedule-full">${escapeHtml(t('admin.schedule.kindLabel'))}</label>
              <select id="scan-schedule-full" name="full">
                <option value="0" ${full ? '' : 'selected'}>${escapeHtml(t('admin.schedule.kindIncremental'))}</option>
                <option value="1" ${full ? 'selected' : ''}>${escapeHtml(t('admin.schedule.kindFull'))}</option>
              </select>
              <span class="admin-field-hint">${escapeHtml(t('admin.schedule.kindHint'))}</span>
            </div>
          </div>

          <div class="scan-schedule-next" data-scan-schedule-next data-next-run-at="${escapeHtml(scanScheduleNextRunAt || '')}">
            ${escapeHtml(formatNextRunLine(mode, scanScheduleNextRunAt))}
          </div>

          <details class="scan-schedule-log-wrap">
            <summary class="muted">${escapeHtml(t('admin.schedule.logTitle'))}</summary>
            <table class="admin-table">
              <thead><tr>
                <th>${escapeHtml(t('admin.schedule.logWhen'))}</th>
                <th>${escapeHtml(t('admin.schedule.logKind'))}</th>
                <th>${escapeHtml(t('admin.schedule.logStatus'))}</th>
              </tr></thead>
              <tbody data-scan-schedule-log>${renderLogRows(scanScheduleLog)}</tbody>
            </table>
          </details>
        </div>
        <div class="admin-actions-row">
          <button type="submit">${escapeHtml(t('admin.save'))}</button>
        </div>
      </div>
    </form>
  `;
}

function formatNextRunLine(mode, nextRunAtIso) {
  if (mode === 'off' || !nextRunAtIso) return t('admin.schedule.nextRunNone');
  return tp('admin.schedule.nextRun', { when: formatLocaleDateTimeShort(nextRunAtIso) });
}

export function renderAdminSources({ user, stats, indexStatus, sources = [], flash = '', csrfToken = '', scanIntervalHours = 0, scanSchedule = null, scanScheduleNextRunAt = null, scanScheduleLog = [], coverWidth = 220, coverHeight = 320, coverQuality = 86 }) {
  const typeBadge = (stype) => stype === 'inpx'
    ? '<span class="admin-chip admin-compact-btn">INPX</span>'
    : `<span class="admin-chip admin-compact-btn">${escapeHtml(t('admin.sources.typeFolder'))}</span>`;
  const fmtDate = (d) => formatLocaleDateTimeShort(d);

  const sourceRows = sources.map((s) => `
    <tr data-source-id="${s.id}" data-source-path="${escapeHtml(s.path)}">
      <td data-label="${escapeHtml(t('admin.sources.thType'))}">${typeBadge(s.type)}</td>
      <td data-label="${escapeHtml(t('admin.sources.thName'))}">
        <strong data-source-name="${s.id}">${escapeHtml(s.name)}</strong>
        <div style="margin-top:4px">
          <span class="muted admin-compact-btn source-path-text" style="word-break:break-all" data-path-status="${s.id}">${escapeHtml(s.path)}</span>
        </div>
      </td>
      <td data-label="${escapeHtml(t('admin.sources.thBooks'))}" style="text-align:center" data-source-books>${formatLocaleInt(Number(s.bookCount || 0))}</td>
      <td data-label="${escapeHtml(t('admin.sources.thEnabled'))}" style="text-align:center">${s.enabled ? escapeHtml(t('common.yes')) : escapeHtml(t('common.no'))}</td>
      <td data-label="${escapeHtml(t('admin.sources.thIndexed'))}" class="admin-compact-btn" data-source-indexed>${escapeHtml(fmtDate(s.lastIndexedAt))}</td>
      <td data-label="${escapeHtml(t('admin.sources.thActions'))}">
        <div class="admin-inline-row" style="gap:6px" data-source-actions="${s.id}">
          <button type="button" class="admin-compact-btn" data-reindex-btn data-source-id="${s.id}" data-mode="incremental">${escapeHtml(t('admin.sources.reindexInc'))}</button>
          <button type="button" class="admin-compact-btn button-danger" data-reindex-btn data-source-id="${s.id}" data-mode="full">${escapeHtml(t('admin.sources.reindexFull'))}</button>
          <form action="/admin/sources/${s.id}/update" method="post" class="admin-inline-form">
            ${csrfHiddenField(csrfToken)}
            <input type="hidden" name="enabled" value="${s.enabled ? '0' : '1'}">
            <button type="submit" class="admin-compact-btn">${escapeHtml(s.enabled ? t('admin.sources.off') : t('admin.sources.on'))}</button>
          </form>
          <button type="button" class="admin-compact-btn" data-edit-source="${s.id}">${escapeHtml(t('admin.sources.edit'))}</button>
        </div>
      </td>
      <td data-label="">
        <button type="button" class="admin-compact-btn button-danger" data-delete-source="${s.id}" data-source-name="${escapeHtml(s.name)}">${escapeHtml(t('admin.sources.delete'))}</button>
      </td>
    </tr>
    <tr class="source-edit-row" id="source-edit-${s.id}" style="display:none">
      <td colspan="7" style="padding:8px 16px;background:var(--admin-bg-alt);border-top:none">
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div>
            <label style="display:block;font-size:0.85em;margin-bottom:4px">${escapeHtml(t('admin.sources.name'))}</label>
            <input type="text" class="admin-input-sm" data-edit-name="${s.id}" value="${escapeHtml(s.name)}">
          </div>
          <div>
            <label style="display:block;font-size:0.85em;margin-bottom:4px">${escapeHtml(t('admin.sources.path'))}</label>
            <input type="text" class="admin-input-sm" data-edit-path="${s.id}" value="${escapeHtml(s.path)}" style="width:320px">
          </div>
          <button type="button" class="admin-compact-btn" data-check-edit="${s.id}">${escapeHtml(t('admin.sources.checkPath'))}</button>
          <button type="button" class="admin-compact-btn" data-save-edit="${s.id}">${escapeHtml(t('admin.save'))}</button>
          <button type="button" class="admin-compact-btn" data-cancel-edit="${s.id}">${escapeHtml(t('common.cancel'))}</button>
        </div>
        <span data-edit-hint="${s.id}" style="font-size:0.85em;margin-top:6px;display:block"></span>
      </td>
    </tr>
  `).join('');

  const content = `
    ${flash ? renderAlert('success', flash) : ''}

    <div class="admin-card" data-sources-card>
      <div class="admin-card-title">${escapeHtml(t('admin.sources.cardTitle'))}</div>
      <div class="admin-card-subtitle">${escapeHtml(t('admin.sources.cardSubtitle'))}</div>

      ${sources.length ? `
        <div style="overflow-x:auto;margin:16px 0">
          <table class="admin-table sources-table" style="width:100%">
            <thead>
              <tr>
                <th>${escapeHtml(t('admin.sources.thType'))}</th>
                <th>${escapeHtml(t('admin.sources.thName'))}</th>
                <th style="text-align:center">${escapeHtml(t('admin.sources.thBooks'))}</th>
                <th style="text-align:center">${escapeHtml(t('admin.sources.thEnabled'))}</th>
                <th>${escapeHtml(t('admin.sources.thIndexed'))}</th>
                <th>${escapeHtml(t('admin.sources.thActions'))}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${sourceRows}</tbody>
          </table>
        </div>
      ` : `<p class="muted" style="margin:16px 0">${escapeHtml(t('admin.sources.empty'))}</p>`}

      <hr class="admin-divider">
      <div class="admin-card-title" style="font-size:1em">${escapeHtml(t('admin.sources.addTitle'))}</div>
      <form id="add-source-form">
        <div class="admin-field-group">
          <label for="source-name">${escapeHtml(t('admin.sources.name'))}</label>
          <input id="source-name" name="name" placeholder="${escapeHtml(t('admin.sources.placeholderName'))}" autocomplete="off" required>
        </div>
        <div class="admin-field-group">
          <label for="source-path">${escapeHtml(t('admin.sources.path'))}</label>
          <input id="source-path" name="path" placeholder="${escapeHtml(t('admin.sources.placeholderPath'))}" autocomplete="off" required>
          <span class="admin-field-hint">${escapeHtml(t('admin.sources.pathHint'))}</span>
        </div>
        <div class="admin-actions-row">
          <button type="submit" id="add-source-btn">${escapeHtml(t('admin.sources.addBtn'))}</button>
        </div>
      </form>
      <hr class="admin-divider">
      ${renderScanScheduleForm({ csrfToken, scanSchedule, scanScheduleNextRunAt, scanScheduleLog, scanIntervalHours })}
    </div>
  `;
  /* Блок «Обложки» (ширина/высота/качество WebP-миниатюр) убран из UI:
     на практике значения по умолчанию (220×320, q=86) подходят 99% случаев,
     а сама панель источников выглядит чище. Маршрут /admin/settings/covers
     и переменные окружения COVER_MAX_WIDTH/HEIGHT/COVER_QUALITY оставлены
     рабочими — если кому-то понадобится тонкая настройка, она доступна
     через env или прямой POST. */
  return pageShell({ title: t('admin.sources.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.sources.title') }], mode: 'admin', currentPath: '/admin/sources', csrfToken });
}

export function renderAdminSmtp({ user, stats, indexStatus, smtp = {}, flash = '', csrfToken = '' }) {
  const content = `
    ${flash ? renderAlert('success', flash) : ''}
    <div class="admin-card">
      <div class="admin-card-title">${escapeHtml(t('admin.smtp.cardTitle'))}</div>
      <div class="admin-card-subtitle">${escapeHtml(t('admin.smtp.cardSubtitle'))}</div>
      <form method="POST" action="/admin/smtp" data-track-dirty>
        ${csrfHiddenField(csrfToken)}
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.smtp.host'))}</label>
          <input type="text" name="host" value="${escapeHtml(smtp.host || '')}" placeholder="smtp.gmail.com">
        </div>
        <div class="admin-form-grid admin-form-grid--gap-12">
          <div class="admin-field-group">
            <label>${escapeHtml(t('admin.smtp.port'))}</label>
            <input type="number" name="port" value="${smtp.port || 587}" placeholder="587">
          </div>
          <div class="admin-field-group" style="justify-content:flex-end;">
            <label class="admin-checkbox-label" style="text-transform:none;letter-spacing:0;">
              <input type="checkbox" name="secure" value="1" ${smtp.secure ? 'checked' : ''} style="accent-color:var(--accent);width:16px;height:16px;">
              ${escapeHtml(t('admin.smtp.ssl'))}
            </label>
          </div>
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.smtp.user'))}</label>
          <input type="text" name="user" value="${escapeHtml(smtp.user || '')}" placeholder="your@gmail.com" autocomplete="off">
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.smtp.pass'))}</label>
          <input type="password" name="pass" value="${escapeHtml(smtp.pass || '')}" placeholder="App Password" autocomplete="off">
          <span class="admin-field-hint">${escapeHtml(t('admin.smtp.passHint'))} <a href="https://myaccount.google.com/apppasswords" target="_blank" style="color:var(--accent);">App Password</a></span>
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.smtp.from'))}</label>
          <input type="email" name="from" value="${escapeHtml(smtp.from || '')}" placeholder="your@gmail.com">
        </div>
        <div class="admin-actions-row" style="margin-top:6px;">
          <button type="submit">${escapeHtml(t('admin.save'))}</button>
          <button type="submit" name="test" value="1">${escapeHtml(t('admin.smtp.test'))}</button>
        </div>
      </form>
    </div>`;
  return pageShell({ title: t('admin.smtp.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.smtp.title') }], mode: 'admin', currentPath: '/admin/smtp', csrfToken });
}

export function renderAdminTelegram({ user, stats, indexStatus, tg = {}, botRunning = false, flash = '', csrfToken = '' }) {
  const statusColor = botRunning ? 'var(--green,#3fb95e)' : 'var(--muted,#888)';
  const statusLabel = botRunning ? escapeHtml(t('admin.telegram.statusRunning')) : escapeHtml(t('admin.telegram.statusStopped'));
  const tokenSaved = Boolean(tg.token);
  const profileDescription = tg.profileDescription || TELEGRAM_DEFAULT_PROFILE_DESCRIPTION;
  const profileShortDescription = tg.profileShortDescription || TELEGRAM_DEFAULT_PROFILE_SHORT;
  const welcomeMessage = tg.welcomeMessage || TELEGRAM_DEFAULT_WELCOME;
  const newBooksAnnounceTemplate = tg.newBooksAnnounceTemplate || TELEGRAM_DEFAULT_NEW_BOOKS_ANNOUNCE;
  const announceChatCount = Number(tg.announceChatCount) || 0;
  const content = `
    ${flash ? renderAlert('success', flash) : ''}
    <div class="admin-card">
      <div class="admin-card-title">${escapeHtml(t('admin.telegram.cardTitle'))}</div>
      <div class="admin-card-subtitle">${escapeHtml(t('admin.telegram.cardSubtitle'))}</div>
      <p class="admin-field-hint" style="margin:0 0 14px;">${escapeHtml(t('admin.telegram.botAvatarHint'))}</p>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;">
        <span style="width:10px;height:10px;border-radius:50%;background:${statusColor};display:inline-block;flex-shrink:0;"></span>
        <span class="muted" style="font-size:13px;">${statusLabel}</span>
      </div>
      <form method="POST" action="/admin/telegram" data-track-dirty>
        ${csrfHiddenField(csrfToken)}
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.telegram.token'))}</label>
          <input type="password" name="token" value="" placeholder="${tokenSaved ? escapeHtml(t('admin.telegram.tokenSavedPlaceholder')) : '123456789:AAxxxxxx...'}" autocomplete="new-password">
          <span class="admin-field-hint">${escapeHtml(t('admin.telegram.tokenHint'))} <a href="https://t.me/BotFather" target="_blank" rel="noopener" style="color:var(--accent);">@BotFather</a>${tokenSaved ? ` · ${escapeHtml(t('admin.telegram.tokenSavedHint'))}` : ''}</span>
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.telegram.allowedUsers'))}</label>
          <input type="text" name="allowedUsers" value="${escapeHtml(tg.allowedUsers || '')}" placeholder="123456789, 987654321">
          <span class="admin-field-hint">${escapeHtml(t('admin.telegram.allowedUsersHint'))}</span>
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.telegram.accessMode'))}</label>
          <select name="accessMode">
            <option value="whitelist_or_linked" ${(tg.accessMode || 'whitelist_or_linked') === 'whitelist_or_linked' ? 'selected' : ''}>${escapeHtml(t('admin.telegram.accessModeWhitelistOrLinked'))}</option>
            <option value="linked_only" ${tg.accessMode === 'linked_only' ? 'selected' : ''}>${escapeHtml(t('admin.telegram.accessModeLinkedOnly'))}</option>
            <option value="open" ${tg.accessMode === 'open' ? 'selected' : ''}>${escapeHtml(t('admin.telegram.accessModeOpen'))}</option>
          </select>
          <span class="admin-field-hint">${escapeHtml(t('admin.telegram.accessModeHint'))}</span>
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.telegram.profileDescription'))}</label>
          <textarea name="profileDescription" rows="6">${escapeHtml(profileDescription)}</textarea>
          <span class="admin-field-hint">${escapeHtml(t('admin.telegram.profileDescriptionHint'))}</span>
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.telegram.profileShortDescription'))}</label>
          <input type="text" name="profileShortDescription" value="${escapeHtml(profileShortDescription)}" maxlength="120">
          <span class="admin-field-hint">${escapeHtml(t('admin.telegram.profileShortDescriptionHint'))}</span>
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.telegram.welcomeMessage'))}</label>
          <textarea name="welcomeMessage" rows="8">${escapeHtml(welcomeMessage)}</textarea>
          <span class="admin-field-hint">${escapeHtml(t('admin.telegram.welcomeMessageHint'))}</span>
        </div>
        <div class="admin-field-group">
          <label>${escapeHtml(t('admin.telegram.newBooksAnnounce'))}</label>
          <span class="admin-field-hint" style="margin-bottom:8px;">${escapeHtml(tp('admin.telegram.newBooksAnnounceHint', { count: announceChatCount }))}</span>
          <label class="admin-checkbox-label" style="text-transform:none;letter-spacing:0;margin-bottom:10px;">
            <input type="checkbox" name="newBooksAnnounceEnabled" value="1" ${tg.newBooksAnnounceEnabled ? 'checked' : ''} style="accent-color:var(--accent);width:16px;height:16px;">
            ${escapeHtml(t('admin.telegram.newBooksAnnounceEnabled'))}
          </label>
          <textarea name="newBooksAnnounceTemplate" rows="6">${escapeHtml(newBooksAnnounceTemplate)}</textarea>
          <span class="admin-field-hint">${escapeHtml(t('admin.telegram.newBooksAnnounceTemplateHint'))}</span>
          <div style="display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;">
            <label style="font-size:13px;color:var(--muted);">${escapeHtml(t('admin.telegram.newBooksAnnounceTestCount'))}</label>
            <input type="number" name="newBooksAnnounceTestCount" value="3" min="1" max="99999" style="width:90px;">
            <button type="submit" formaction="/admin/telegram/test-announce" formmethod="post">${escapeHtml(t('admin.telegram.testAnnounce'))}</button>
          </div>
          <span class="admin-field-hint">${escapeHtml(t('admin.telegram.testAnnounceHint'))}</span>
        </div>
        <div class="admin-field-group" style="flex-direction:row;align-items:center;gap:10px;margin-top:4px;">
          <label class="admin-checkbox-label" style="text-transform:none;letter-spacing:0;">
            <input type="checkbox" name="enabled" value="1" ${tg.enabled !== false ? 'checked' : ''} style="accent-color:var(--accent);width:16px;height:16px;">
            ${escapeHtml(t('admin.telegram.enabled'))}
          </label>
        </div>
        <div class="admin-actions-row" style="margin-top:6px;">
          <button type="submit">${escapeHtml(t('admin.save'))}</button>
          <button type="submit" name="test" value="1">${escapeHtml(t('admin.telegram.test'))}</button>
        </div>
      </form>
    </div>`;
  return pageShell({ title: t('admin.telegram.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.telegram.title') }], mode: 'admin', currentPath: '/admin/telegram', csrfToken });
}

export function renderAdminAppearance({
  user, stats, indexStatus, ui = {}, siteName = '', homeSubtitle = '',
  homeNewestCount = '', homeNewestCountDefault = 12, flash = '', csrfToken = ''
}) {
  const logoPreview = ui.logoUrl
    ? `<img src="${escapeHtml(ui.logoUrl)}" alt="" class="ui-asset-preview">`
    : `<span class="muted">${escapeHtml(t('admin.ui.defaultAsset'))}</span>`;
  const faviconPreview = ui.faviconUrl
    ? `<img src="${escapeHtml(ui.faviconUrl)}" alt="" class="ui-asset-preview ui-asset-preview--favicon">`
    : `<span class="muted">${escapeHtml(t('admin.ui.defaultAsset'))}</span>`;
  const bgPreview = ui.backgroundUrl
    ? `<img src="${escapeHtml(ui.backgroundUrl)}" alt="" class="ui-asset-preview ui-asset-preview--bg">`
    : `<span class="muted">${escapeHtml(t('admin.ui.noBackground'))}</span>`;
  const fontPreview = ui.hasCustomFont
    ? `<div class="ui-font-preview">${escapeHtml(t('admin.ui.fontPreviewSample'))}</div>`
    : `<span class="muted">${escapeHtml(t('admin.ui.fontCustomEmpty'))}</span>`;

  const glassThemeCard = (theme, palette, themeTitle, surfaceOpacity, ui) => {
    const glassName = theme === 'dark' ? 'glassColorDark' : 'glassColorLight';
    const glassId = `ui-glass-${theme}`;
    const opacity = Number(surfaceOpacity);
    const panelOpacity = Number.isFinite(opacity) ? opacity : 88;
    const isLight = theme === 'light';
    const previewPalette = isLight
      ? adjustLightTextForGlassOpacity(palette, panelOpacity)
      : palette;
    const panelBg = buildGlassPanelBackground(palette.surface, panelOpacity, isLight ? DEFAULT_GLASS_LIGHT : DEFAULT_GLASS_DARK);
    const pickHint = escapeHtml(t('admin.ui.glassPreviewPickHint'));
    const glassPreviewPick = (role, fieldName, color, labelKey, auto) => {
      const roleClass = role === 'text' ? ' ui-glass-preview-main' : '';
      return `<label class="ui-glass-preview-pick${roleClass}" title="${pickHint}">
        <input type="color" name="${fieldName}" form="ui-main-form" value="${escapeHtml(color)}" class="ui-glass-preview-color-input" data-ui-glass-pick-input="${role}" data-ui-glass-pick-theme="${theme}" data-ui-glass-auto="${auto ? '1' : '0'}">
        <span>${escapeHtml(t(labelKey))}</span>
      </label>`;
    };
    const textField = isLight ? 'glassTextLight' : 'glassTextDark';
    const mutedField = isLight ? 'glassMutedLight' : 'glassMutedDark';
    const linkField = isLight ? 'glassLinkLight' : 'glassLinkDark';
    const textAuto = isLight ? ui.glassTextAutoLight : ui.glassTextAutoDark;
    const mutedAuto = isLight ? ui.glassMutedAutoLight : ui.glassMutedAutoDark;
    const linkAuto = isLight ? ui.glassLinkAutoLight : ui.glassLinkAutoDark;
    const accentField = isLight ? 'accentLight' : 'accentDark';
    const accentAutoField = isLight ? 'accentAutoLight' : 'accentAutoDark';
    const accentColor = isLight ? ui.glassAccentLight : ui.glassAccentDark;
    const accentAuto = isLight ? ui.glassAccentAutoLight : ui.glassAccentAutoDark;
    return `
    <div class="ui-glass-theme-card" data-ui-glass-card="${theme}">
      <div class="ui-glass-theme-card-title">${escapeHtml(themeTitle)}</div>
      <div class="ui-glass-preview" data-ui-glass-preview-panel="${theme}" data-ui-glass-preview-light="${isLight ? '1' : '0'}" style="background:${escapeHtml(panelBg)};color:${escapeHtml(previewPalette.text)};">
        ${glassPreviewPick('text', textField, previewPalette.text, 'admin.ui.glassPreviewSample', textAuto)}
        <div class="ui-glass-preview-meta">
          ${glassPreviewPick('muted', mutedField, previewPalette.muted, 'admin.ui.glassPreviewMuted', mutedAuto)}
          ${glassPreviewPick('link', linkField, palette.link, 'admin.ui.glassPreviewLink', linkAuto)}
        </div>
      </div>
      <div class="ui-color-field">
        <label for="${glassId}">${escapeHtml(t('admin.ui.glassBaseColor'))}</label>
        <div class="ui-color-field-row">
          <input type="color" id="${glassId}" name="${glassName}" form="ui-main-form" value="${escapeHtml(palette.surface)}" data-ui-glass-color="${theme}"${ui.dynamicThemeFromBg ? ' disabled title="' + escapeHtml(t('admin.ui.glassBaseColorLocked')) + '"' : ''}>
          <code data-ui-glass-hex="${glassName}">${escapeHtml(palette.surface)}</code>
        </div>
        <span class="admin-field-hint">${escapeHtml(ui.dynamicThemeFromBg ? t('admin.ui.glassBaseColorLockedHint') : t('admin.ui.glassBaseColorHint'))}</span>
      </div>
      <div class="ui-color-field">
        <div class="ui-color-field-head">
          <label for="ui-accent-${theme}">${escapeHtml(t('admin.ui.accentColor'))}</label>
          <label class="admin-checkbox-label ui-accent-auto-label">
            <input type="checkbox" data-ui-accent-auto="${theme}" ${accentAuto ? 'checked' : ''}>
            ${escapeHtml(t('admin.ui.accentAuto'))}
          </label>
        </div>
        <div class="ui-color-field-row">
          <input type="color" id="ui-accent-${theme}" name="${accentField}" form="ui-main-form" value="${escapeHtml(accentColor)}" data-ui-accent="${theme}"${accentAuto ? ' disabled' : ''}>
          <code data-ui-accent-hex="${theme}">${escapeHtml(accentColor)}</code>
        </div>
        <input type="hidden" name="${accentAutoField}" id="ui-accent-auto-${theme}" value="${accentAuto ? '1' : '0'}" form="ui-main-form">
        <span class="admin-field-hint">${escapeHtml(t('admin.ui.accentColorHint'))}</span>
      </div>
    </div>`;
  };

  const assetBlock = (asset, title, hint, previewHtml, hasCustom, extraControls = '', accept = 'image/png,image/jpeg,image/webp,image/gif') => `
    <div class="ui-asset-block">
      <div class="ui-asset-block-meta">
        <strong>${escapeHtml(title)}</strong>
        <span class="muted">${escapeHtml(hint)}</span>
      </div>
      <div class="ui-asset-block-row">
        <div class="ui-asset-block-preview">${previewHtml}</div>
        <div class="ui-asset-block-controls">
          <div class="ui-asset-block-buttons">
            <label for="ui-${asset}-input" class="button ui-asset-pick-btn">${escapeHtml(t('admin.ui.pickFile'))}</label>
            <input type="file" id="ui-${asset}-input" data-ui-asset="${asset}" accept="${accept}" hidden>
            <form method="post" action="/admin/settings/ui/remove" class="ui-asset-remove-form"${hasCustom ? '' : ' hidden'}>
              ${csrfHiddenField(csrfToken)}
              <input type="hidden" name="asset" value="${asset}">
              <button type="submit" class="button-danger">${escapeHtml(t('admin.ui.remove'))}</button>
            </form>
          </div>
          <p class="ui-asset-block-status muted" data-ui-upload-status="${asset}">${escapeHtml(t('admin.ui.uploadAutoHint'))}</p>
          ${extraControls ? `<div class="ui-asset-block-extra">${extraControls}</div>` : ''}
        </div>
      </div>
    </div>`;

  const selectPreset = (name, value, options, labels) => {
    let html = `<select id="ui-${name}" name="${name}" form="ui-main-form" class="admin-preset-select">`;
    for (const [optVal, optLabel] of Object.entries(labels)) {
      html += `<option value="${optVal}"${value === optVal ? ' selected' : ''}>${escapeHtml(optLabel)}</option>`;
    }
    html += '</select>';
    return html;
  };

  const selectFontSize = (value) => {
    const current = Number(value);
    let html = `<select id="ui-font-size" name="fontSize" form="ui-main-form" class="admin-preset-select">`;
    for (let px = MIN_FONT_SIZE_PX; px <= MAX_FONT_SIZE_PX; px += 1) {
      html += `<option value="${px}"${current === px ? ' selected' : ''}>${px} px</option>`;
    }
    html += '</select>';
    return html;
  };

  const fontUploadField = `
    <div class="admin-field-group">
      <label for="ui-font-input">${escapeHtml(t('admin.ui.fontCustomTitle'))}</label>
      <div class="ui-font-upload-toolbar">
        <label for="ui-font-input" class="button ui-font-upload-btn ui-asset-pick-btn">${escapeHtml(t('admin.ui.fontUploadBtn'))}</label>
        <input type="file" id="ui-font-input" data-ui-asset="font" accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,application/font-woff,application/x-font-ttf,application/x-font-opentype" hidden>
        <form method="post" action="/admin/settings/ui/remove" class="ui-asset-remove-form"${ui.hasCustomFont ? '' : ' hidden'}>
          ${csrfHiddenField(csrfToken)}
          <input type="hidden" name="asset" value="font">
          <button type="submit" class="button-danger">${escapeHtml(t('admin.ui.remove'))}</button>
        </form>
      </div>
      <div class="ui-font-upload-preview">${fontPreview}</div>
      <p class="ui-asset-block-status muted" data-ui-upload-status="font">${escapeHtml(t('admin.ui.uploadAutoHint'))}</p>
      <span class="admin-field-hint">${escapeHtml(t('admin.ui.fontCustomHint'))}</span>
    </div>`;

  const presetButtons = `
    <div class="ui-preset-row" data-ui-presets>
      ${THEME_PRESETS.map((p) => `
        <button type="button" class="ui-preset-btn" data-ui-preset="${p.id}"
          data-preset-dark="${escapeHtml(p.dark.surface)}" data-preset-light="${escapeHtml(p.light.surface)}"
          data-preset-accent-dark="${escapeHtml(p.dark.accent || '')}" data-preset-accent-light="${escapeHtml(p.light.accent || '')}"
          title="${escapeHtml(t('admin.ui.preset.' + p.id))}">
          <span class="ui-preset-swatch" style="--preset-dark:${escapeHtml(p.dark.surface)};--preset-light:${escapeHtml(p.light.surface)};--preset-accent:${escapeHtml(p.dark.accent || p.light.accent || p.dark.surface)}"></span>
          <span class="ui-preset-name">${escapeHtml(t('admin.ui.preset.' + p.id))}</span>
        </button>`).join('')}
    </div>`;

  const content = `
    ${flash ? renderAlert('success', flash) : ''}
    <div class="admin-appearance-layout" data-ui-appearance-page>
      <div class="admin-appearance-preview-bar" data-ui-preview-bar hidden>
        <span class="admin-appearance-preview-dot"></span>
        <span>${escapeHtml(t('admin.ui.livePreviewActive'))}</span>
      </div>

      <!-- 1. Брендинг -->
      <div class="admin-card">
        <div class="admin-card-title">${escapeHtml(t('admin.ui.sectionBranding'))}</div>
        <div class="admin-card-subtitle">${escapeHtml(t('admin.ui.sectionBrandingHint'))}</div>
        <div class="admin-field-group">
          <label for="admin-site-name">${escapeHtml(t('admin.siteName'))}</label>
          <input id="admin-site-name" form="ui-main-form" name="siteName" value="${escapeHtml(siteName)}" placeholder="${escapeHtml(t('nav.library'))}" autocomplete="off">
          <span class="admin-field-hint">${escapeHtml(t('admin.siteNameHint'))}</span>
        </div>
        <div class="admin-field-group" style="margin-top:12px">
          <label for="admin-home-subtitle">${escapeHtml(t('admin.homeSubtitle'))}</label>
          <input id="admin-home-subtitle" form="ui-main-form" name="homeSubtitle" value="${escapeHtml(homeSubtitle)}" placeholder="${escapeHtml(t('home.subtitle'))}" autocomplete="off">
          <span class="admin-field-hint">${escapeHtml(t('admin.homeSubtitleHint'))}</span>
        </div>
        <div class="admin-field-group" style="margin-top:12px">
          <label for="admin-home-newest-count">${escapeHtml(t('admin.homeNewestCount'))}</label>
          <input id="admin-home-newest-count" form="ui-main-form" name="homeNewestCount" type="number" min="1" max="200" step="1" value="${escapeHtml(homeNewestCount)}" placeholder="${escapeHtml(String(homeNewestCountDefault))}" autocomplete="off">
          <span class="admin-field-hint">${escapeHtml(tp('admin.homeNewestCountHint', { default: homeNewestCountDefault }))}</span>
        </div>
      </div>

      <!-- 2. Изображения -->
      <div class="admin-card">
        <div class="admin-card-title">${escapeHtml(t('admin.ui.sectionAssets'))}</div>
        <div class="admin-card-subtitle">${escapeHtml(t('admin.ui.sectionAssetsHint'))}</div>
        ${assetBlock('logo', t('admin.ui.logoTitle'), t('admin.ui.logoHint'), logoPreview, ui.hasLogo, `
          <label class="admin-checkbox-label ui-asset-checkbox">
            <input type="checkbox" form="ui-main-form" name="showLogoOnLogin" value="1" ${ui.showLogoOnLogin !== false ? 'checked' : ''}>
            ${escapeHtml(t('admin.ui.showLogoOnLogin'))}
          </label>`)}
        <hr class="admin-divider">
        ${assetBlock('favicon', t('admin.ui.faviconTitle'), t('admin.ui.faviconHint'), faviconPreview, Boolean(ui.faviconUrl))}
        <hr class="admin-divider">
        ${assetBlock('background', t('admin.ui.backgroundTitle'), t('admin.ui.backgroundHint'), bgPreview, ui.hasBackground)}
      </div>

      <!-- 3. Эффекты -->
      <div class="admin-card">
        <div class="admin-card-title">${escapeHtml(t('admin.ui.sectionEffects'))}</div>
        <div class="admin-card-subtitle">${escapeHtml(t('admin.ui.sectionEffectsHint'))}</div>
        ${`<div data-ui-bg-section${ui.hasBackground ? '' : ' hidden'}>`}
        <div class="admin-section-label">${escapeHtml(t('admin.ui.sectionBackgroundOverlay'))}</div>
        <div class="admin-form-grid admin-form-grid--gap-12">
          <div class="admin-field-group">
            <label for="ui-bg-blur">${escapeHtml(t('admin.ui.bgBlur'))}</label>
            <input type="range" id="ui-bg-blur" name="bgBlur" form="ui-main-form" min="0" max="24" step="1" value="${ui.blur}">
            <span class="admin-field-hint">${escapeHtml(t('admin.ui.bgBlurHint'))} <strong data-ui-range-value="bgBlur">${ui.blur}</strong></span>
          </div>
          <div class="admin-field-group">
            <label for="ui-bg-overlay">${escapeHtml(t('admin.ui.bgOverlay'))}</label>
            <input type="range" id="ui-bg-overlay" name="bgOverlay" form="ui-main-form" min="0" max="80" step="1" value="${ui.bgContrast}">
            <span class="admin-field-hint">${escapeHtml(t('admin.ui.bgOverlayHint'))} <strong data-ui-range-value="bgOverlay">${ui.bgContrast}</strong></span>
          </div>
        </div>
        <div class="admin-form-grid admin-form-grid--gap-12" style="margin-top:12px">
          <div class="admin-field-group">
            <label for="ui-bg-size">${escapeHtml(t('admin.ui.bgSize'))}</label>
            ${selectPreset('bgSize', ui.bgSize, ['cover', 'contain', 'tile'], {
              cover: t('admin.ui.bgSizeCover'),
              contain: t('admin.ui.bgSizeContain'),
              tile: t('admin.ui.bgSizeTile'),
            })}
            <span class="admin-field-hint">${escapeHtml(t('admin.ui.bgSizeHint'))}</span>
          </div>
          <div class="admin-field-group">
            <label for="ui-bg-position">${escapeHtml(t('admin.ui.bgPosition'))}</label>
            ${selectPreset('bgPosition', ui.bgPosition, ['center', 'top', 'bottom', 'left', 'right'], {
              center: t('admin.ui.bgPositionCenter'),
              top: t('admin.ui.bgPositionTop'),
              bottom: t('admin.ui.bgPositionBottom'),
              left: t('admin.ui.bgPositionLeft'),
              right: t('admin.ui.bgPositionRight'),
            })}
            <span class="admin-field-hint">${escapeHtml(t('admin.ui.bgPositionHint'))}</span>
          </div>
        </div>
        <div class="admin-form-grid admin-form-grid--gap-12" style="margin-top:12px">
          <div class="ui-color-field">
            <div class="ui-color-field-head">
              <label for="ui-overlay-dark">${escapeHtml(t('admin.ui.overlayColorDark'))}</label>
              <label class="admin-checkbox-label ui-accent-auto-label">
                <input type="checkbox" data-ui-overlay-auto="dark" ${ui.overlayColorAutoDark ? 'checked' : ''}>
                ${escapeHtml(t('admin.ui.accentAuto'))}
              </label>
            </div>
            <div class="ui-color-field-row">
              <input type="color" id="ui-overlay-dark" name="overlayColorDark" form="ui-main-form" value="${escapeHtml(ui.overlayColorDark)}" data-ui-overlay="dark"${ui.overlayColorAutoDark ? ' disabled' : ''}>
              <code data-ui-overlay-hex="dark">${escapeHtml(ui.overlayColorDark)}</code>
            </div>
            <input type="hidden" name="overlayColorAutoDark" id="ui-overlay-auto-dark" value="${ui.overlayColorAutoDark ? '1' : '0'}" form="ui-main-form">
          </div>
          <div class="ui-color-field">
            <div class="ui-color-field-head">
              <label for="ui-overlay-light">${escapeHtml(t('admin.ui.overlayColorLight'))}</label>
              <label class="admin-checkbox-label ui-accent-auto-label">
                <input type="checkbox" data-ui-overlay-auto="light" ${ui.overlayColorAutoLight ? 'checked' : ''}>
                ${escapeHtml(t('admin.ui.accentAuto'))}
              </label>
            </div>
            <div class="ui-color-field-row">
              <input type="color" id="ui-overlay-light" name="overlayColorLight" form="ui-main-form" value="${escapeHtml(ui.overlayColorLight)}" data-ui-overlay="light"${ui.overlayColorAutoLight ? ' disabled' : ''}>
              <code data-ui-overlay-hex="light">${escapeHtml(ui.overlayColorLight)}</code>
            </div>
            <input type="hidden" name="overlayColorAutoLight" id="ui-overlay-auto-light" value="${ui.overlayColorAutoLight ? '1' : '0'}" form="ui-main-form">
          </div>
        </div>
        <hr class="admin-divider">
        </div>
        <div class="admin-section-label">${escapeHtml(t('admin.ui.sectionPanels'))}</div>
        <div class="admin-form-grid admin-form-grid--gap-12">
          <div class="admin-field-group">
            <label for="ui-surface-opacity">${escapeHtml(t('admin.ui.surfaceOpacity'))}</label>
            <input type="range" id="ui-surface-opacity" name="surfaceOpacity" form="ui-main-form" min="0" max="100" step="1" value="${ui.surfaceOpacity}">
            <span class="admin-field-hint">${escapeHtml(t('admin.ui.surfaceOpacityHint'))} <strong data-ui-range-value="surfaceOpacity">${ui.surfaceOpacity}</strong></span>
          </div>
          <div class="admin-field-group">
            <label for="ui-surface-blur">${escapeHtml(t('admin.ui.surfaceBlur'))}</label>
            <input type="range" id="ui-surface-blur" name="surfaceBlur" form="ui-main-form" min="0" max="24" step="1" value="${ui.surfaceBlur}">
            <span class="admin-field-hint">${escapeHtml(t('admin.ui.surfaceBlurHint'))} <strong data-ui-range-value="surfaceBlur">${ui.surfaceBlur}</strong></span>
          </div>
        </div>
        ${`<div class="admin-card-reset" data-ui-reset-wrap="sliders"${ui.hasCustomThemeSliders ? '' : ' hidden'}><button type="button" class="button-danger" data-ui-reset="sliders">${escapeHtml(t('admin.ui.resetSliders'))}</button></div>`}
      </div>

      <!-- 4. Цвета темы -->
      <div class="admin-card">
        <div class="admin-card-title">${escapeHtml(t('admin.ui.sectionColors'))}</div>
        <div class="admin-card-subtitle">${escapeHtml(t('admin.ui.glassSectionHint'))}</div>
        <div class="admin-section-label">${escapeHtml(t('admin.ui.presetsTitle'))}</div>
        ${presetButtons}
        <span class="admin-field-hint">${escapeHtml(t('admin.ui.presetsHint'))}</span>
        <hr class="admin-divider">
        <div class="admin-field-group admin-field-group--compact">
          <label class="admin-checkbox-label ui-asset-checkbox">
            <input type="checkbox" name="dynamicThemeFromBg" value="1" form="ui-main-form" ${ui.dynamicThemeFromBg ? 'checked' : ''} ${ui.hasBackground ? '' : 'disabled'}>
            ${escapeHtml(t('admin.ui.dynamicThemeFromBg'))}
          </label>
          <span class="admin-field-hint">${escapeHtml(t('admin.ui.dynamicThemeFromBgHint'))}</span>
          <div class="admin-card-reset admin-card-reset--inline" data-ui-bg-palette-wrap${ui.hasBackground ? '' : ' hidden'}>
            <button type="button" class="button button-secondary" data-ui-refresh-bg-palette>${escapeHtml(t('admin.ui.refreshBgPalette'))}</button>
          </div>
        </div>
        <hr class="admin-divider">
        <div class="ui-glass-theme-grid">
          ${glassThemeCard('dark', ui.themePair.dark, t('admin.ui.glassThemeDark'), ui.surfaceOpacity, ui)}
          ${glassThemeCard('light', ui.themePair.light, t('admin.ui.glassThemeLight'), ui.surfaceOpacity, ui)}
        </div>
        ${`<div class="admin-card-reset" data-ui-reset-wrap="colors"${ui.hasCustomThemeColors ? '' : ' hidden'}><button type="button" class="button-danger" data-ui-reset="colors">${escapeHtml(t('admin.ui.resetColors'))}</button></div>`}
        <input type="hidden" name="glassTextAutoDark" id="ui-glass-text-auto-dark" value="${ui.glassTextAutoDark ? '1' : '0'}" form="ui-main-form">
        <input type="hidden" name="glassTextAutoLight" id="ui-glass-text-auto-light" value="${ui.glassTextAutoLight ? '1' : '0'}" form="ui-main-form">
        <input type="hidden" name="glassMutedAutoDark" id="ui-glass-muted-auto-dark" value="${ui.glassMutedAutoDark ? '1' : '0'}" form="ui-main-form">
        <input type="hidden" name="glassMutedAutoLight" id="ui-glass-muted-auto-light" value="${ui.glassMutedAutoLight ? '1' : '0'}" form="ui-main-form">
        <input type="hidden" name="glassLinkAutoDark" id="ui-glass-link-auto-dark" value="${ui.glassLinkAutoDark ? '1' : '0'}" form="ui-main-form">
        <input type="hidden" name="glassLinkAutoLight" id="ui-glass-link-auto-light" value="${ui.glassLinkAutoLight ? '1' : '0'}" form="ui-main-form">
      </div>

      <!-- 5. Форма и тени -->
      <div class="admin-card">
        <div class="admin-card-title">${escapeHtml(t('admin.ui.sectionShape'))}</div>
        <div class="admin-card-subtitle">${escapeHtml(t('admin.ui.sectionShapeHint'))}</div>
        <div class="admin-form-grid admin-form-grid--gap-12">
          <div class="admin-field-group">
            <label for="ui-radius-preset">${escapeHtml(t('admin.ui.radiusPreset'))}</label>
            ${selectPreset('radiusPreset', ui.radiusPreset, ['sharp', 'rounded', 'pill', 'custom'], {
              sharp: t('admin.ui.radiusSharp'),
              rounded: t('admin.ui.radiusRounded'),
              pill: t('admin.ui.radiusPill'),
              custom: t('admin.ui.radiusCustom'),
            })}
            <span class="admin-field-hint">${escapeHtml(t('admin.ui.radiusPresetHint'))}</span>
          </div>
          <div class="admin-field-group" data-ui-radius-scale-field${ui.radiusPreset === 'custom' ? '' : ' hidden'}>
            <label for="ui-radius-scale">${escapeHtml(t('admin.ui.radiusScale'))}</label>
            <input type="range" id="ui-radius-scale" name="radiusScale" form="ui-main-form" min="${MIN_RADIUS_SCALE}" max="${MAX_RADIUS_SCALE}" step="1" value="${ui.radiusScale}">
            <span class="admin-field-hint">${escapeHtml(t('admin.ui.radiusScaleHint'))} <strong data-ui-range-value="radiusScale">${ui.radiusScale}</strong></span>
          </div>
          <div class="admin-field-group">
            <label for="ui-shadow-preset">${escapeHtml(t('admin.ui.shadowPreset'))}</label>
            ${selectPreset('shadowPreset', ui.shadowPreset, ['none', 'subtle', 'normal', 'pronounced'], {
              none: t('admin.ui.shadowNone'),
              subtle: t('admin.ui.shadowSubtle'),
              normal: t('admin.ui.shadowNormal'),
              pronounced: t('admin.ui.shadowPronounced'),
            })}
            <span class="admin-field-hint">${escapeHtml(t('admin.ui.shadowPresetHint'))}</span>
          </div>
        </div>
        <div class="ui-shape-preview" data-ui-shape-preview aria-hidden="true">
          <span class="ui-shape-preview-label">${escapeHtml(t('admin.ui.shapePreviewTitle'))}</span>
          <div class="ui-shape-preview-chip"></div>
          <div class="ui-shape-preview-chip ui-shape-preview-chip--soft"></div>
        </div>
        ${`<div class="admin-card-reset" data-ui-reset-wrap="shape"${ui.hasCustomThemeShape ? '' : ' hidden'}><button type="button" class="button-danger" data-ui-reset="shape">${escapeHtml(t('admin.ui.resetShape'))}</button></div>`}
      </div>

      <!-- 7. Типографика и плотность -->
      <div class="admin-card">
        <div class="admin-card-title">${escapeHtml(t('admin.ui.sectionTypography'))}</div>
        <div class="admin-card-subtitle">${escapeHtml(t('admin.ui.sectionTypographyHint'))}</div>
        <div class="admin-typography-fields">
          <div class="admin-form-grid admin-form-grid--gap-12 admin-form-grid--align-start">
            <div class="admin-field-group">
              <label for="ui-fontFamily">${escapeHtml(t('admin.ui.fontFamily'))}</label>
              ${selectPreset('fontFamily', ui.fontFamily, ['inter', 'system', 'serif', 'georgia', 'merriweather', 'rounded', 'mono', 'custom'], {
                inter: t('admin.ui.fontFamilyInter'),
                system: t('admin.ui.fontFamilySystem'),
                serif: t('admin.ui.fontFamilySerif'),
                georgia: t('admin.ui.fontFamilyGeorgia'),
                merriweather: t('admin.ui.fontFamilyMerriweather'),
                rounded: t('admin.ui.fontFamilyRounded'),
                mono: t('admin.ui.fontFamilyMono'),
                custom: t('admin.ui.fontFamilyCustom'),
              })}
              <span class="admin-field-hint">${escapeHtml(t('admin.ui.fontFamilyHint'))}</span>
            </div>
            ${fontUploadField}
          </div>
          <div class="admin-form-grid admin-form-grid--gap-12">
            <div class="admin-field-group">
              <label for="ui-font-size">${escapeHtml(t('admin.ui.fontScale'))}</label>
              ${selectFontSize(ui.fontSize)}
              <span class="admin-field-hint">${escapeHtml(t('admin.ui.fontScaleHint'))}</span>
            </div>
            <div class="admin-field-group">
              <label for="ui-heading-scale">${escapeHtml(t('admin.ui.headingScale'))}</label>
              <input type="range" id="ui-heading-scale" name="headingScale" form="ui-main-form" min="${MIN_HEADING_SCALE}" max="${MAX_HEADING_SCALE}" step="5" value="${ui.headingScale}">
              <span class="admin-field-hint">${escapeHtml(t('admin.ui.headingScaleHint'))} <strong data-ui-range-value="headingScale">${ui.headingScale}</strong>%</span>
            </div>
            <div class="admin-field-group">
              <label for="ui-density">${escapeHtml(t('admin.ui.density'))}</label>
              ${selectPreset('density', ui.density, ['compact', 'normal', 'comfortable'], {
                compact: t('admin.ui.densityCompact'),
                normal: t('admin.ui.densityNormal'),
                comfortable: t('admin.ui.densityComfortable'),
              })}
              <span class="admin-field-hint">${escapeHtml(t('admin.ui.densityHint'))}</span>
            </div>
          </div>
        </div>
        ${`<div class="admin-card-reset" data-ui-reset-wrap="typography"${ui.hasCustomThemeTypography ? '' : ' hidden'}><button type="button" class="button-danger" data-ui-reset="typography">${escapeHtml(t('admin.ui.resetTypography'))}</button></div>`}
      </div>

      <!-- Основная форма сохранения -->
      <form id="ui-main-form" method="post" action="/admin/settings/ui" data-track-dirty>
        ${csrfHiddenField(csrfToken)}
      </form>

      <!-- Кнопка сохранения -->
      <div class="admin-appearance-save">
        <button type="submit" form="ui-main-form" class="button button-primary admin-appearance-save-btn">${escapeHtml(t('admin.save'))}</button>
      </div>
    </div>`;
  return pageShell({
    title: t('admin.ui.title'),
    content,
    user,
    stats,
    indexStatus,
    breadcrumbs: [{ label: t('admin.ui.title') }],
    mode: 'admin',
    currentPath: '/admin/appearance',
    csrfToken
  });
}
