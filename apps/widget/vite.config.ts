import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * The storefront build is an ES module bundle: `caddie.js` plus lazily loaded
 * chunks. The Vapi SDK is one of those chunks, so a customer who never taps the
 * mic never downloads the WebRTC stack.
 *
 * Because the chunks are fetched relative to the bundle, set
 * VITE_CADDIE_ASSET_BASE to wherever the files are hosted (the Shopify CDN
 * asset URL) when building for production.
 */
const envDir = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The VITE_* values from caddie/.env, the same file the server reads.
 *
 * loadEnv also stashes any NODE_ENV it finds as VITE_USER_NODE_ENV, which Vite
 * then applies to the build. The server's NODE_ENV=development would ship
 * React's development build to the storefront - twice the size, with dev
 * warnings in a customer's browser - so that side effect is undone here.
 */
function rootEnv(mode: string): Record<string, string> {
  const before = process.env.VITE_USER_NODE_ENV;
  const env = loadEnv(mode, envDir, 'VITE_');
  if (before === undefined) delete process.env.VITE_USER_NODE_ENV;
  else process.env.VITE_USER_NODE_ENV = before;
  return env;
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The widget's own settings come from caddie/.env at the repo root.
  define: Object.fromEntries(
    Object.entries(rootEnv(mode)).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  ),
  base: process.env.VITE_CADDIE_ASSET_BASE ?? rootEnv(mode).VITE_CADDIE_ASSET_BASE ?? '/',
  server: { port: 5173 },
  build: {
    target: 'es2020',
    sourcemap: mode !== 'production',
    rollupOptions: {
      input: 'src/embed.tsx',
      output: {
        format: 'es',
        entryFileNames: 'caddie.js',
        chunkFileNames: 'caddie-[name]-[hash].js',
        assetFileNames: 'caddie.[ext]',
      },
    },
  },
}));
