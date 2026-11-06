import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// GitHub Pages (project site). With a custom domain set base to '/' and site to the domain.
const SITE = process.env.SITE_URL || 'https://habsaec.github.io';
// `astro dev` serves from / so http://localhost:4321/ opens the site; builds use the Pages sub-path.
const BASE = process.env.SITE_BASE ?? (process.argv.includes('dev') ? '/' : '/inpx-library-server');

// English is the default (root) locale, Russian lives under /ru/.
// English pages used to live under /en/ — keep those links working.
const DOC_PAGES = ['install', 'getting-started', 'calibre', 'android', 'opds', 'configuration', 'troubleshooting', 'developers'];
const withBase = (path) => `${BASE.replace(/\/+$/, '')}${path}`;
const legacyEnRedirects = Object.fromEntries([
  ['/en', withBase('/')],
  ...DOC_PAGES.map((page) => [`/en/${page}`, withBase(`/${page}/`)]),
]);

export default defineConfig({
  site: SITE,
  base: BASE,
  redirects: legacyEnRedirects,
  integrations: [
    starlight({
      title: { en: 'INPX Library Server', ru: 'INPX Library Server' },
      description: 'Self-hosted library for INPX collections, Calibre and book folders — catalog, reader, OPDS, Android app.',
      logo: { src: './src/assets/logo.webp', alt: 'INPX Library Server' },
      favicon: '/favicon.png',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ru: { label: 'Русский', lang: 'ru' },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Habsaec/inpx-library-server' },
        { icon: 'heart', label: 'Support on Boosty / Поддержать проект на Boosty', href: 'https://boosty.to/habsaec/donate' },
      ],
      editLink: { baseUrl: 'https://github.com/Habsaec/inpx-library-server/edit/master/site/' },
      customCss: ['./src/styles/theme.css'],
      // Header with theme / language / links visible on phones too.
      components: { Header: './src/components/Header.astro' },
      // Our own src/content/docs/404.md is rendered by the docs route as /404 → 404.html.
      disable404Route: true,
      sidebar: [
        {
          label: 'Start',
          translations: { ru: 'Начало' },
          items: [
            { slug: 'install' },
            { slug: 'getting-started' },
          ],
        },
        {
          label: 'Features',
          translations: { ru: 'Возможности' },
          items: [
            { slug: 'calibre' },
            { slug: 'android' },
            { slug: 'opds' },
          ],
        },
        {
          label: 'Setup',
          translations: { ru: 'Настройка' },
          items: [
            { slug: 'configuration' },
            { slug: 'troubleshooting' },
            { slug: 'developers' },
          ],
        },
      ],
    }),
  ],
});
