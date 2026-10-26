// LunaCore phone companion (docs/DONE_CLOUD_SYNC_PLAN.md phase 4).
// It shares validators and maths with the desktop app straight from ../src.
// Those files are CommonJS outside this root, so the commonjs plugin has to
// be told to convert them - by default it only converts node_modules.
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const SHARED = /[\\/]src[\\/](cloudrows|missionledger(sync|calc)|missionnewsrows|missionweather|ratecalc|lifeyaziopeers|usagesnapshot|repossnapshot|godmodesnapshot|godmodeneeds|lunasworkDecisions|lunasworkFeedback|lunasworkAskModel|lunasworkWheel|lunasworksnapshot|hostcanon|hostsnapshot|hostevents|hostscrub|todorows|efforts|lifebudget[a-z]*)\.js$/;
const SUPABASE_RE = /^https:\/\/[a-z0-9-]{1,63}\.supabase\.co$/;

/**
 * The CSP's connect-src names this build's own Supabase project, not every
 * *.supabase.co: a leaked session token can't be sent to another project.
 * The wss:// twin is the realtime socket (phase 4d).
 */
function cspOrigin(mode) {
  const env = (loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const url = SUPABASE_RE.test(env) ? env : 'https://invalid.supabase.co';
  return {
    name: 'lunacore-csp-origin',
    transformIndexHtml: (html) => html.replace('__SUPABASE_ORIGIN__', `${url} ${url.replace(/^https:/, 'wss:')}`),
  };
}

/**
 * vite preview ignores vercel.json, so it serves the same security headers
 * (the full CSP included) read straight from there: one source, no drift.
 */
function vercelHeaders() {
  const rules = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')).headers || [];
  const all = rules.find((r) => r.source === '/(.*)');
  return Object.fromEntries((all ? all.headers : []).map((h) => [h.key, h.value]));
}

export default defineConfig(({ mode }) => ({
  build: {
    target: 'es2022',
    commonjsOptions: { include: [SHARED, /node_modules/] },
  },
  preview: { port: 4173, strictPort: true, headers: vercelHeaders() },
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
        // Web Push (H4): the push / notificationclick handlers.
        importScripts: ['push-sw.js'],
        navigateFallbackDenylist: [/^\/auth/],
      },
    }),
  ],
}));
