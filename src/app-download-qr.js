import { createRequire } from 'node:module';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
const { render: renderQrSvg } = require('qrcode/lib/renderer/svg-tag.js');

/** Latest Android APK. The sidebar QR encodes this URL so a phone camera opens the download page. */
export const APP_DOWNLOAD_URL = 'https://github.com/Habsaec/inpx-book-reader/releases/latest';

let cachedSvg = '';

export function appDownloadQrSvg() {
  if (cachedSvg) return cachedSvg;
  const data = QRCode.create(APP_DOWNLOAD_URL, { errorCorrectionLevel: 'M' });
  cachedSvg = String(renderQrSvg(data, { margin: 1, errorCorrectionLevel: 'M' })).trim();
  return cachedSvg;
}
