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
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined
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
  await transporter.verify();
}
