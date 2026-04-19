/**
 * Barrel re-export: all template functions from sub-modules.
 * Consumers import from this file to keep existing paths unchanged.
 */

// Shared state & helpers (public API)
export { setSiteName, getSiteName, setAllowAnonymousDownload, renderMaintenance } from './templates/shared.js';

// Auth templates
export { renderLogin, renderAdminLogin, renderRegister } from './templates/auth.js';

// Library / browse templates
export {
  renderHome,
  renderCatalog,
  renderLibraryView,
  renderBook,
  renderFavorites,
  renderBrowsePage,
  renderFacetBooks,
  renderAuthorFacetPage,
  renderAuthorOutsideSeriesPage,
  renderShelves,
  renderShelfDetail,
  renderReader,
  renderProfile
} from './templates/library.js';

// Admin templates
export {
  renderOperations,
  renderAdminUpdate,
  renderAdminUsers,
  renderAdminEvents,
  renderAdminLanguages,
  renderAdminDuplicates,
  renderAdminSources,
  renderAdminSmtp
} from './templates/admin.js';

// OPDS templates
export {
  renderOpdsRoot,
  renderOpdsOpenSearch,
  renderOpdsSearchHelp,
  renderOpdsSectionFeed,
  renderOpdsBooksFeed,
  renderOpdsBookDetail
} from './templates/opds.js';

// OPDS 2.0 templates
export {
  renderOpds2Root,
  renderOpds2NavigationFeed,
  renderOpds2PublicationsFeed,
  renderOpds2BookDetail
} from './templates/opds-v2.js';
