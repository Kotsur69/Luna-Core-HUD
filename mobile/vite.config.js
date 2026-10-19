// LunaCore phone companion (docs/CLOUD_SYNC_PLAN.md phase 4).
// It shares validators and maths with the desktop app straight from ../src.
// Those files are CommonJS outside this root, so the commonjs plugin has to
// be told to convert them - by default it only converts node_modules.
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const SHARED = /[\\/]src[\\/](cloudrows|missionledgersync|todorows|lifebudget[a-z]*)\.js$/;
const SUPABASE_RE = /^https:\/\/[a-z0-9-]{1,63}\.supabase\.co$/;

/**
 * The CSP's connect-src names this build's own Supabase project, not every
 * *.supabase.co: a leaked session token can't be sent to another project.
 */
function cspOrigin(mode) {
  const url = (loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL || '').replace(/\/$/, '');
  return {
    name: 'lunacore-csp-origin',
    transformIndexHtml: (html) => html.replace('__SUPABASE_ORIGIN__', SUPABASE_RE.test(url) ? url : 'https://invalid.supabase.co'),
  };
}

export default defineConfig(({ mode }) => ({
  build: {
    target: 'es2022',
    commonjsOptions: { include: [SHARED, /node_modules/] },
  },
  preview: { port: 4173, strictPort: true },
  plugins: [
    cspOrigin(mode),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-512.png'],
      manifest: {
        name: 'LunaCore',
        short_name: 'LunaCore',
        description: 'LunaCore on the phone: to-dos, budget, news.',
        lang: 'pl',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0a0710',
        theme_color: '#0a0710',
        icons: [
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only: cloud data is never cached by the service worker.
        globPatterns: ['**/*.{js,css,html,png,woff2}'],
        navigateFallbackDenylist: [/^\/auth/],
      },
    }),
  ],
}));
