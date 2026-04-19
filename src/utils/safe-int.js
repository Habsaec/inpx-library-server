/**
 * Safe integer parsing utilities.
 * Prevents NaN propagation from query parameters.
 */

/**
 * Parse a value as a positive integer with a default fallback.
 * Fixes the bug where `Math.max(1, Number(undefined))` returns NaN.
 * @param {any} value
 * @param {number} defaultValue
 * @param {number} [min=1]
 * @returns {number}
 */
export function safePositiveInt(value, defaultValue = 1, min = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return defaultValue;
  return Math.max(min, Math.floor(parsed));
}

/**
 * Parse a page number from query params.
 * @param {any} value
 * @returns {number} Always >= 1
 */
export function safePage(value) {
  return safePositiveInt(value, 1, 1);
}
