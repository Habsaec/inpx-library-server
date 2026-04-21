/**
 * Admin template functions.
 */
import {
  escapeHtml, csrfHiddenField, pageShell, renderPagination, renderEmptyState,
  renderEventDetailsHtml, renderAlert,
  t, tp, getLocale, plural, countLabel, formatLocaleInt,
  formatLocaleDateShort, formatLocaleDateTimeShort, formatLanguageLabel
} from './shared.js';

export function renderOperations({ user, stats = {}, indexStatus = {}, operations = {}, siteName = '', homeSubtitle = '', csrfToken = '' }) {
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
  const cpuPct = Number(operations.cpuPercent);
  const cpuStr = Number.isFinite(cpuPct) ? cpuPct.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : t('common.dash');
  const systemMemMb = Number(operations.systemMemoryMB);
  const rssMemMb = Number(operations.memoryMB);
  const ramPct = Number.isFinite(systemMemMb) && systemMemMb > 0 && Number.isFinite(rssMemMb)
    ? Math.max(0, Math.min(100, (rssMemMb / systemMemMb) * 100))
    : 0;
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
  const dbMbNum = Number(dbSizeMB);
  const dbPct = Number.isFinite(dbMbNum)
    ? Math.max(0, Math.min(100, (dbMbNum / 2048) * 100))
    : 0;
  const diskStr = Number.isFinite(diskFreeGb) && Number.isFinite(diskTotalGb)
    ? escapeHtml(tp('admin.monitor.diskFreeOf', {
      free: diskFreeGb.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
      total: diskTotalGb.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
      unit: t('common.unitGB')
    }))
    : t('common.dash');
  const cacheMB =
    operations.cacheApproxBytes != null
      ? (operations.cacheApproxBytes / 1024 / 1024).toLocaleString(loc, {
          maximumFractionDigits: 1,
          minimumFractionDigits: 1
        })
      : t('common.dash');
  const srcCount = (operations.sources || []).length;
  const sourcesLine = srcCount ? countLabel('source', srcCount) : t('admin.sourcesNone');
  const content = `
    <div data-operations-dashboard>

      <div class="admin-status-bar">
        <span class="admin-chip"><strong>${countLabel('book', stats.totalBooks)}</strong></span>
        <span class="admin-chip"><strong>${countLabel('author', stats.totalAuthors)}</strong></span>
        <span class="admin-chip"><strong>${countLabel('series', stats.totalSeries)}</strong></span>
        <span class="admin-chip"><strong>${countLabel('archive', indexStatus.totalArchives)}</strong></span>
        <span class="admin-sep"></span>
        <span class="admin-chip" data-index-field="active">${indexStatus.active ? escapeHtml(t('admin.indexUpdating')) : escapeHtml(t('admin.indexReady'))}</span>
        <span class="admin-chip">${escapeHtml(tp('admin.uptime', { s: uptimeStr }))}</span>
        <span class="admin-chip">${escapeHtml(tp('admin.ram', { mb: operations.memoryMB || t('common.dash') }))}</span>
        <span class="admin-chip">${escapeHtml(tp('admin.db', { mb: dbSizeMB }))}</span>
      </div>

      <div class="admin-card">
        <form action="/admin/settings/site-name" method="post">
          ${csrfHiddenField(csrfToken)}
          <div class="admin-field-group">
            <label for="admin-site-name">${escapeHtml(t('admin.siteName'))}</label>
            <input id="admin-site-name" name="siteName" value="${escapeHtml(siteName)}" placeholder="${escapeHtml(t('nav.library'))}" autocomplete="off">
            <span class="admin-field-hint">${escapeHtml(t('admin.siteNameHint'))}</span>
          </div>
          <div class="admin-field-group" style="margin-top:12px">
            <label for="admin-home-subtitle">${escapeHtml(t('admin.homeSubtitle'))}</label>
            <input id="admin-home-subtitle" name="homeSubtitle" value="${escapeHtml(homeSubtitle)}" placeholder="${escapeHtml(t('home.subtitle'))}" autocomplete="off">
            <span class="admin-field-hint">${escapeHtml(t('admin.homeSubtitleHint'))}</span>
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
              <div class="monitor-item" data-monitor-key="cpu">
                <div class="monitor-item-top">
                  <span class="monitor-label">${escapeHtml(t('admin.monitor.cpu'))}</span>
                  <span class="monitor-value" data-operations-field="monitorCpu">${cpuStr}%</span>
                </div>
                <div class="monitor-meter"><span data-operations-field="monitorCpuBar" style="width:${cpuPct}%;background:${monitorBarGradient(cpuPct)}"></span></div>
                <svg class="monitor-spark" viewBox="0 0 100 24" preserveAspectRatio="none" data-operations-field="monitorCpuSpark" aria-hidden="true"></svg>
              </div>
              <div class="monitor-item" data-monitor-key="ram">
                <div class="monitor-item-top">
                  <span class="monitor-label">${escapeHtml(t('admin.monitor.ram'))}</span>
                  <span class="monitor-value" data-operations-field="monitorRam">${escapeHtml(String(operations.memoryMB || t('common.dash')))} ${escapeHtml(t('common.unitMB'))}</span>
                </div>
                <div class="monitor-meter"><span data-operations-field="monitorRamBar" style="width:${ramPct.toFixed(1)}%;background:${monitorBarGradient(ramPct)}"></span></div>
                <svg class="monitor-spark" viewBox="0 0 100 24" preserveAspectRatio="none" data-operations-field="monitorRamSpark" aria-hidden="true"></svg>
              </div>
              <div class="monitor-item" data-monitor-key="disk">
                <div class="monitor-item-top">
                  <span class="monitor-label">${escapeHtml(t('admin.monitor.disk'))}</span>
                  <span class="monitor-value" data-operations-field="monitorDisk">${diskStr}</span>
                </div>
                <div class="monitor-meter"><span data-operations-field="monitorDiskBar" style="width:${diskPct.toFixed(1)}%;background:${monitorBarGradient(diskPct)}"></span></div>
              </div>
              <div class="monitor-item" data-monitor-key="db">
                <div class="monitor-item-top">
                  <span class="monitor-label">${escapeHtml(t('admin.monitor.db'))}</span>
                  <span class="monitor-value" data-operations-field="monitorDb">${escapeHtml(dbSizeMB)} ${escapeHtml(t('common.unitMB'))}</span>
                </div>
                <div class="monitor-meter"><span data-operations-field="monitorDbBar" style="width:${dbPct.toFixed(1)}%;background:${monitorBarGradient(dbPct)}"></span></div>
              </div>
            </div>
            <div class="monitor-foot">
              <span class="muted" data-operations-field="monitorUptime">${escapeHtml(t('admin.monitor.uptime'))}: ${escapeHtml(uptimeStr)}</span>
              <span class="muted" data-operations-field="monitorUsers">${escapeHtml(t('admin.monitor.users'))}: ${escapeHtml(tp('admin.monitor.usersFmt', { total: (Number(operations.totalUsers) || 0).toLocaleString(loc), online: (Number(operations.onlineUsers) || 0).toLocaleString(loc) }))}</span>
            </div>
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
      <div class="admin-actions-row" style="margin-top:10px;">
        <a class="button" href="/api/operations/backup">${escapeHtml(t('admin.update.downloadDb'))}</a>
        <a class="button" href="/api/operations/settings-export?download=1">${escapeHtml(t('admin.update.exportJson'))}</a>
        <a class="button" href="/api/operations/settings-export" target="_blank" rel="noopener noreferrer">${escapeHtml(t('admin.update.openJson'))}</a>
      </div>
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

export function renderAdminUsers({ user, stats, indexStatus, users = [], flash = '', adminCount = 0, registrationEnabled = false, recaptchaSiteKey = '', recaptchaSecretKey = '', allowAnonymousBrowse = false, allowAnonymousDownload = false, allowAnonymousOpds = false, csrfToken = '' }) {
  const admins = users.filter((account) => account.role === 'admin');
  const regularUsers = users.filter((account) => account.role !== 'admin');
  const fmtDate = (d) => formatLocaleDateShort(d);
  const isSelf = (account) => account.username === user?.username;
  const renderUserRows = (items = []) => items.map((account) => `
    <details class="admin-user-row ${account.blocked ? 'admin-user-row-blocked' : ''}">
      <summary class="admin-user-row-summary">
        <strong>${escapeHtml(account.username)}</strong>
        <span class="role-badge role-badge-${escapeHtml(account.role)}">${escapeHtml(account.role)}</span>
        ${account.blocked ? `<span class="badge-blocked">${escapeHtml(t('admin.users.blocked'))}</span>` : ''}
        ${isSelf(account) ? `<span class="badge-self">${escapeHtml(t('admin.users.self'))}</span>` : ''}
        <span class="muted admin-user-row-date">${escapeHtml(t('admin.users.created'))} ${escapeHtml(fmtDate(account.createdAt))}</span>
      </summary>
      <div class="admin-user-row-body">
        <form class="user-admin-form" action="/admin/users/update" method="post">
          ${csrfHiddenField(csrfToken)}
          <input type="hidden" name="username" value="${escapeHtml(account.username)}">
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
              <input type="password" name="password" placeholder="${escapeHtml(t('admin.users.noChangePassword'))}">
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
              <input type="hidden" name="username" value="${escapeHtml(account.username)}">
              <input type="hidden" name="action" value="${account.blocked ? 'unblock' : 'block'}">
              <button type="submit" class="${account.blocked ? '' : 'button-danger'}">${account.blocked ? escapeHtml(t('admin.users.unblock')) : escapeHtml(t('admin.users.block'))}</button>
            </form>
            <form action="/admin/users/delete" method="post" class="admin-inline-form" data-confirm="${escapeHtml(tp('admin.users.deleteConfirm', { name: account.username }))}" data-confirm-danger>
              ${csrfHiddenField(csrfToken)}
              <input type="hidden" name="username" value="${escapeHtml(account.username)}">
              <button type="submit" class="button-danger">${escapeHtml(t('admin.users.deleteUser'))}</button>
            </form>
          </div>
        ` : ''}
      </div>
    </details>
  `).join('');
  const content = `
    ${flash ? renderAlert('success', escapeHtml(flash)) : ''}

    <div class="admin-card">
      <form method="post" action="/admin/settings/anonymous-access" class="admin-action-item">
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
      <div class="admin-action-item">
        <div class="admin-action-item-info">
          <strong>${escapeHtml(t('admin.users.recaptcha'))}</strong>
          <span class="muted">${escapeHtml(t('admin.users.recaptchaHint'))} <a href="https://www.google.com/recaptcha/admin" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">google.com/recaptcha/admin</a></span>
        </div>
      </div>
      <details class="admin-recaptcha-disclosure">
        <summary class="admin-recaptcha-disclosure-summary">${escapeHtml(t('admin.users.keys'))}</summary>
        <div class="admin-recaptcha-disclosure-body">
          <form method="post" action="/admin/settings/recaptcha">
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
    ${flash ? renderAlert('success', escapeHtml(flash)) : ''}

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


export function renderAdminLanguages({ user, stats, indexStatus, languages = [], excludedSet = new Set(), flash = '', csrfToken = '' }) {
  const totalBooks = languages.reduce((sum, l) => sum + l.bookCount, 0);
  const excludedCount = languages.filter(l => excludedSet.has(l.code)).length;
  const excludedBooks = languages.filter(l => excludedSet.has(l.code)).reduce((sum, l) => sum + l.bookCount, 0);

  const rows = languages.map(lang => {
    const checked = !excludedSet.has(lang.code);
    const label = formatLanguageLabel(lang.code);
    return `
      <tr class="${checked ? '' : 'lang-row-disabled'}">
        <td data-label="" style="text-align:center">
          <input type="checkbox" name="enabled" value="${escapeHtml(lang.code)}" ${checked ? 'checked' : ''}>
        </td>
        <td data-label="${escapeHtml(t('admin.languages.thName'))}">${escapeHtml(label)}</td>
        <td data-label="${escapeHtml(t('admin.languages.thCode'))}" class="muted">${escapeHtml(lang.code)}</td>
        <td data-label="${escapeHtml(t('admin.languages.thBooks'))}" style="text-align:right">${lang.bookCount.toLocaleString('ru-RU')}</td>
      </tr>`;
  }).join('');

  const content = `
    ${flash ? renderAlert('success', escapeHtml(flash)) : ''}
    <div class="admin-card" style="margin-bottom:16px;border-left:4px solid var(--accent-color)">
      <div class="admin-card-title">${escapeHtml(t('admin.languages.statsTitle'))}</div>
      <p class="muted" style="margin:8px 0">${escapeHtml(tp('admin.languages.statsDesc', { total: languages.length, books: totalBooks, excluded: excludedCount, excludedBooks }))}</p>
    </div>
    <div class="admin-card">
      <div class="admin-card-title">${escapeHtml(t('admin.languages.cardTitle'))}</div>
      <p class="muted admin-compact-btn" style="margin:4px 0 12px;">${escapeHtml(t('admin.languages.cardHint'))}</p>
      <form method="POST" action="/admin/languages">
        ${csrfHiddenField(csrfToken)}
        <div style="overflow-x:auto">
          <table class="admin-table admin-lang-table" style="width:100%">
            <thead>
              <tr>
                <th style="width:50px;text-align:center">
                  <input type="checkbox" id="lang-toggle-all" title="${escapeHtml(t('admin.languages.toggleAll'))}">
                </th>
                <th>${escapeHtml(t('admin.languages.thName'))}</th>
                <th>${escapeHtml(t('admin.languages.thCode'))}</th>
                <th style="text-align:right">${escapeHtml(t('admin.languages.thBooks'))}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="admin-inline-row" style="margin-top:16px;gap:12px;">
          <button type="submit" class="button button-primary">${escapeHtml(t('admin.languages.save'))}</button>
          <span class="muted admin-compact-btn">${escapeHtml(t('admin.languages.saveHint'))}</span>
        </div>
      </form>
    </div>
    <script>
      document.getElementById('lang-toggle-all')?.addEventListener('change', function() {
        document.querySelectorAll('input[name="enabled"]').forEach(cb => { cb.checked = this.checked; });
      });
    </script>`;

  return pageShell({
    title: t('admin.languages.pageTitle'),
    content,
    user,
    stats,
    indexStatus,
    breadcrumbs: [{ label: t('admin.badge'), href: '/admin' }, { label: t('admin.languages.pageTitle') }],
    mode: 'admin',
    currentPath: '/admin/languages',
    csrfToken
  });
}

export function renderAdminDuplicates({ user, stats, indexStatus, flash = '', csrfToken = '' }) {
  const content = `
    ${flash ? renderAlert('success', escapeHtml(flash)) : ''}
    <div data-duplicates-page data-page="1">
      <div class="admin-card" style="text-align:center;padding:48px 24px;">
        <div class="spinner" style="margin:0 auto 16px;"></div>
        <div style="font-size:1.05em;font-weight:500;">${escapeHtml(t('admin.duplicates.searching'))}</div>
        <div class="muted" style="margin-top:6px;font-size:.9em;">${escapeHtml(t('admin.duplicates.searchingHint'))}</div>
      </div>
    </div>
  `;
  return pageShell({ title: t('admin.nav.duplicates'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.nav.duplicates') }], mode: 'admin', currentPath: '/admin/duplicates', csrfToken });
}

export function renderAdminSources({ user, stats, indexStatus, sources = [], flash = '', csrfToken = '', scanIntervalHours = 0, coverWidth = 220, coverHeight = 320, coverQuality = 86 }) {
  const typeBadge = (stype) => stype === 'inpx'
    ? '<span class="admin-chip admin-compact-btn">INPX</span>'
    : `<span class="admin-chip admin-compact-btn">${escapeHtml(t('admin.sources.typeFolder'))}</span>`;
  const fmtDate = (d) => formatLocaleDateTimeShort(d);

  const sourceRows = sources.map((s) => `
    <tr data-source-id="${s.id}">
      <td data-label="${escapeHtml(t('admin.sources.thType'))}">${typeBadge(s.type)}</td>
      <td data-label="${escapeHtml(t('admin.sources.thName'))}"><strong>${escapeHtml(s.name)}</strong><br><span class="muted admin-compact-btn" style="word-break:break-all">${escapeHtml(s.path)}</span></td>
      <td data-label="${escapeHtml(t('admin.sources.thBooks'))}" style="text-align:center" data-source-books>${formatLocaleInt(Number(s.bookCount || 0))}</td>
      <td data-label="${escapeHtml(t('admin.sources.thEnabled'))}" style="text-align:center">${s.enabled ? escapeHtml(t('common.yes')) : escapeHtml(t('common.no'))}</td>
      <td data-label="${escapeHtml(t('admin.sources.thIndexed'))}" class="admin-compact-btn" data-source-indexed>${escapeHtml(fmtDate(s.lastIndexedAt))}</td>
      <td data-label="${escapeHtml(t('admin.sources.thActions'))}">
        <div class="admin-inline-row" style="gap:6px">
          <button type="button" class="admin-compact-btn" data-reindex-btn data-source-id="${s.id}" data-mode="incremental">${escapeHtml(t('admin.sources.reindexInc'))}</button>
          <button type="button" class="admin-compact-btn button-danger" data-reindex-btn data-source-id="${s.id}" data-mode="full">${escapeHtml(t('admin.sources.reindexFull'))}</button>
          <form action="/admin/sources/${s.id}/update" method="post" class="admin-inline-form">
            ${csrfHiddenField(csrfToken)}
            <input type="hidden" name="enabled" value="${s.enabled ? '0' : '1'}">
            <button type="submit" class="admin-compact-btn">${escapeHtml(s.enabled ? t('admin.sources.off') : t('admin.sources.on'))}</button>
          </form>
        </div>
      </td>
      <td data-label="">
        <button type="button" class="admin-compact-btn button-danger" data-delete-source="${s.id}" data-source-name="${escapeHtml(s.name)}">${escapeHtml(t('admin.sources.delete'))}</button>
      </td>
    </tr>
  `).join('');

  const content = `
    ${flash ? renderAlert('success', escapeHtml(flash)) : ''}

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
      <form action="/admin/settings/scan-interval" method="post">
        ${csrfHiddenField(csrfToken)}
        <div class="admin-action-item">
          <div class="admin-action-item-info">
            <strong>${escapeHtml(t('admin.settings.scanTitle'))}</strong>
            <span class="muted">${escapeHtml(t('admin.settings.scanHint'))}</span>
          </div>
          <div class="admin-inline-row">
            <input type="number" name="hours" value="${scanIntervalHours}" min="0" max="8760" class="admin-input-sm">
            <span class="muted">${escapeHtml(t('admin.settings.scanHours'))}</span>
            <button type="submit">${escapeHtml(t('admin.save'))}</button>
          </div>
        </div>
      </form>
      <hr class="admin-divider">
      <form action="/admin/settings/covers" method="post">
        ${csrfHiddenField(csrfToken)}
        <div class="admin-action-item">
          <div class="admin-action-item-info">
            <strong>${escapeHtml(t('admin.settings.coversTitle'))}</strong>
            <span class="muted">${escapeHtml(t('admin.settings.coversHint'))}</span>
          </div>
          <div class="admin-inline-row">
            <input type="number" name="width" value="${coverWidth}" min="32" max="1200" class="admin-input-sm" placeholder="W">
            <span class="muted">\u00d7</span>
            <input type="number" name="height" value="${coverHeight}" min="32" max="1600" class="admin-input-sm" placeholder="H">
            <span class="muted">q</span>
            <input type="number" name="quality" value="${coverQuality}" min="1" max="100" class="admin-input-xs">
            <button type="submit">${escapeHtml(t('admin.save'))}</button>
          </div>
        </div>
      </form>
    </div>
  `;
  return pageShell({ title: t('admin.sources.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('admin.sources.title') }], mode: 'admin', currentPath: '/admin/sources', csrfToken });
}

export function renderAdminSmtp({ user, stats, indexStatus, smtp = {}, flash = '', csrfToken = '' }) {
  const content = `
    ${flash ? renderAlert('success', escapeHtml(flash)) : ''}
    <div class="admin-card">
      <div class="admin-card-title">${escapeHtml(t('admin.smtp.cardTitle'))}</div>
      <div class="admin-card-subtitle">${escapeHtml(t('admin.smtp.cardSubtitle'))}</div>
      <form method="POST" action="/admin/smtp">
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

