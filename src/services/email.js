/**
 * Email service: SMTP transport factory.
 * Centralizes nodemailer transport creation to avoid duplication.
 */
import nodemailer from 'nodemailer';
import { getSmtpSettings } from '../db.js';

/**
 * Create a nodemailer transport from the current SMTP settings.
 * @returns {{ transporter: import('nodemailer').Transporter, senderEmail: string }}
 * @throws {Error} if SMTP is not configured
 */
export function createSmtpTransport() {
  const smtp = getSmtpSettings();
  if (!smtp.host) {
    throw new Error('SMTP не настроен. Попросите администратора задать настройки почты в разделе Админ → Почта.');
  }
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: (smtp.pass || '').replace(/\s/g, '') } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
  const senderEmail = smtp.from || smtp.user || 'library@localhost';
  return { transporter, senderEmail };
}

/**
 * Verify SMTP connection.
 * @throws {Error} on connection failure
 */
export async function verifySmtpConnection() {
  const { transporter } = createSmtpTransport();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('SMTP connection timeout (10s)')), 10000)
  );
  await Promise.race([transporter.verify(), timeout]);
}
