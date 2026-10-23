/**
 * Security headers middleware.
 * Sets CSP, X-Content-Type-Options, X-Frame-Options, etc.
 */
export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('X-XSS-Protection', '0');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://www.google.com https://www.gstatic.com; " +
    // blob: — foliate-js serves EPUB stylesheets and embedded fonts as blob URLs
    "style-src 'self' 'unsafe-inline' blob:; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob:; " +
    "frame-src 'self' blob: https://www.google.com; " +
    "connect-src 'self'; " +
    "font-src 'self' data: blob:; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'"
  );
  next();
}
