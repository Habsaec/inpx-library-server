import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// GitHub Pages (project site). With a custom domain set base to '/' and site to the domain.
const SITE = process.env.SITE_URL || 'https://habsaec.github.io';
// `astro dev` serves from / so http://localhost:4321/ opens the site; builds use the Pages sub-path.
const BASE = process.env.SITE_BASE ?? (process.argv.includes('dev') ? '/' : '/inpx-library-server');

export default defineConfig({
  site: SITE,
  base: BASE,
  integrations: [
    starlight({
      title: { ru: 'INPX Library Server', en: 'INPX Library Server' },
      description: 'Self-hosted library for INPX collections, Calibre and book folders — catalog, reader, OPDS, Android app.',
      logo: { src: './src/assets/logo.webp', alt: 'INPX Library Server' },
      favicon: '/favicon.png',
      defaultLocale: 'root',
      locales: {
        root: { label: 'Русский', lang: 'ru' },
        en: { label: 'English', lang: 'en' },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Habsaec/inpx-library-server' },
      ],
      editLink: { baseUrl: 'https://github.com/Habsaec/inpx-library-server/edit/master/site/' },
      customCss: ['./src/styles/theme.css'],
      // Our own src/content/docs/404.md is rendered by the docs route as /404 → 404.html.
      disable404Route: true,
      sidebar: [
        {
          label: 'Начало',
          translations: { en: 'Start' },
          items: [
            { slug: 'install' },
            { slug: 'getting-started' },
          ],
        },
        {
          label: 'Возможности',
          translations: { en: 'Features' },
          items: [
            { slug: 'calibre' },
            { slug: 'android' },
            { slug: 'opds' },
          ],
        },
        {
          label: 'Настройка',
          translations: { en: 'Setup' },
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
