import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The storefront build is an ES module bundle: `caddie.js` plus lazily loaded
 * chunks. The Vapi SDK is one of those chunks, so a customer who never taps the
 * mic never downloads the WebRTC stack.
 *
 * Because the chunks are fetched relative to the bundle, set
 * VITE_CADDIE_ASSET_BASE to wherever the files are hosted (the Shopify CDN
 * asset URL) when building for production.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: process.env.VITE_CADDIE_ASSET_BASE ?? '/',
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
