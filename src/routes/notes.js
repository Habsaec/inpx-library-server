import { requireApiAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { t, tp, translateKnownErrorMessage } from '../i18n.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  READER_ANNOTATION_COLORS, queryReaderAnnotations, deleteReaderAnnotationsBulk, setReaderAnnotationsColorBulk,
  getEreaderEmail, getSmtpSettings, getUserByUsername, isEreaderEmailAllowedForUser
} from '../db.js';
import { createSmtpTransport } from '../services/email.js';
import { logSystemEvent } from '../services/system-events.js';
import { parseNotesFilter, buildNotesExport, NOTES_EXPORT_FORMATS } from '../services/reader-notes.js';

const EXPORT_MAX_NOTES = 5000;

function parseIds(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) return raw.split(',');
  return null;
}

/** Выгрузка выбранных (`ids`) или отфильтрованных заметок текущего пользователя. */
function collectNotes(username, src) {
  const filter = parseNotesFilter(src);
  const ids = parseIds(src.ids);
  const { items } = queryReaderAnnotations(username, { ...filter, ids, limit: EXPORT_MAX_NOTES });
  return { items, filter };
}

/**
 * Reader notes API: export (md/html), send to the profile e-reader email, bulk delete / recolor.
 */
export function registerNotesRoutes(app, { batchEmailLocks }) {
  app.get('/api/reader-notes/export', requireApiAuth, asyncHandler(async (req, res) => {
    const format = String(req.query.format || 'md');
    if (!NOTES_EXPORT_FORMATS[format]) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('notes.export.badFormat'));
    }
    const { items, filter } = collectNotes(req.user.username, req.query);
    if (!items.length) {
      return apiFail(res, 404, ApiErrorCode.VALIDATION, t('notes.export.empty'));
    }
    const file = buildNotesExport(items, { format, group: filter.group });
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.content);
  }));

  app.post('/api/reader-notes/send', requireApiAuth, async (req, res) => {
    const username = req.user.username;
    try {
      const body = req.body || {};
      const format = String(body.format || 'html');
      if (!NOTES_EXPORT_FORMATS[format]) {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, t('notes.export.badFormat'));
      }
      if (!isEreaderEmailAllowedForUser(getUserByUsername(username))) {
        return apiFail(res, 403, ApiErrorCode.EREADER_EMAIL_DENIED, t('profile.ereaderEmail.accessDenied'));
      }
      const email = getEreaderEmail(username);
      if (!email) {
        return apiFail(res, 400, ApiErrorCode.EREADER_EMAIL_MISSING, t('notes.send.emailMissing'));
      }
      if (!getSmtpSettings().host) {
        return apiFail(res, 400, ApiErrorCode.SMTP_NOT_CONFIGURED, t('api.ereader.smtpNotConfigured'));
      }
      const { items, filter } = collectNotes(username, body);
      if (!items.length) {
        return apiFail(res, 404, ApiErrorCode.VALIDATION, t('notes.export.empty'));
      }
      if (batchEmailLocks.has(username)) {
        return apiFail(res, 429, ApiErrorCode.SEND_IN_PROGRESS, t('api.send.inProgress'));
      }
      batchEmailLocks.add(username);
      try {
        const file = buildNotesExport(items, { format, group: filter.group });
        const { transporter, senderEmail } = createSmtpTransport();
        await transporter.sendMail({
          from: senderEmail,
          to: email,
          subject: t('notes.export.title'),
          text: tp('notes.send.body', { count: items.length }),
          attachments: [{ filename: file.fileName, content: file.content, contentType: file.mimeType }]
        });
        logSystemEvent('info', 'ereader', 'notes sent by email', { user: username, count: items.length, format, to: email });
        res.json({ ok: true, count: items.length, message: tp('notes.send.sent', { count: items.length, email }) });
      } finally {
        batchEmailLocks.delete(username);
      }
    } catch (error) {
      console.error('Notes send error:', error);
      let msg = translateKnownErrorMessage(error.message) || t('api.error.unknown');
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
        msg = t('api.email.err.smtpConnect');
      } else if (msg.includes('EENVELOPE') || msg.includes('rejected')) {
        msg = t('api.email.err.smtpRejected');
      }
      res.status(500).json({ ok: false, code: ApiErrorCode.SMTP_ERROR, error: msg });
    }
  });

  app.post('/api/reader-notes/bulk', requireApiAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('notes.bulk.noIds'));
    }
    const username = req.user.username;
    if (body.action === 'delete') {
      return res.json({ ok: true, deleted: deleteReaderAnnotationsBulk(username, ids) });
    }
    if (body.action === 'color') {
      const color = String(body.color || '');
      if (!READER_ANNOTATION_COLORS.includes(color)) {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.invalidColor'));
      }
      return res.json({ ok: true, updated: setReaderAnnotationsColorBulk(username, ids, color) });
    }
    return apiFail(res, 400, ApiErrorCode.VALIDATION, t('notes.bulk.badAction'));
  }));
}
