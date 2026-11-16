// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import fs from 'node:fs';

// Written by scripts/sync-docs.mjs from the main repo's docs/README.md reading order.
const sidebar = JSON.parse(fs.readFileSync(new URL('./src/generated/sidebar.json', import.meta.url), 'utf8'));

export default defineConfig({
  site: 'https://meritorder.dev',
  trailingSlash: 'ignore',
  build: { inlineStylesheets: 'auto' },
  integrations: [
    starlight({
      title: 'Merit Order',
      description: 'A self-hosted LLM gateway that sends each request to the cheapest model and backend that is good enough for the work.',
      favicon: '/favicon.svg',
      logo: { src: './src/assets/mark.svg', alt: '' },
      lastUpdated: false,
      pagination: true,
      editLink: { baseUrl: 'https://github.com/Merit-Order/meritorder/blob/main/' },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Merit-Order/meritorder' }],
      sidebar,
      customCss: ['./src/styles/tokens.css', './src/styles/starlight.css'],
      components: {
        Header: './src/components/starlight/Header.astro',
        ThemeSelect: './src/components/ThemeToggle.astro',
        Head: './src/components/starlight/Head.astro',
        Footer: './src/components/starlight/Footer.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        useStarlightDarkModeSwitch: true,
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: '10px',
          borderColor: 'var(--line)',
          codeBackground: 'var(--doc-code-bg)',
          codeFontFamily: 'var(--font-mono)',
          codeFontSize: '13px',
          uiFontFamily: 'var(--font-sans)',
          frames: {
            editorBackground: 'var(--doc-code-bg)',
            terminalBackground: 'var(--doc-code-bg)',
            editorTabBarBackground: 'var(--bg-2)',
            terminalTitlebarBackground: 'var(--bg-2)',
            terminalTitlebarBorderBottomColor: 'var(--line)',
            editorActiveTabBackground: 'var(--doc-code-bg)',
            frameBoxShadowCssValue: 'none',
          },
        },
      },
    }),
  ],
});
