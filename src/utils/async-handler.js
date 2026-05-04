/**
 * Express async route wrapper.
 * Eliminates repetitive try/catch blocks in every async route handler.
 * Usage: app.get('/path', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
