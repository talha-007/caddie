import { defineConfig } from 'vitest/config';

/*
 * The widget's tests run the widget's own modules against a browser-like
 * document (jsdom): the theme-cart calls against a fake Shopify Ajax cart
 * with contents of its own, the operation records in sessionStorage, and the
 * api transport's deadlines. No real store, no real server, no network.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    env: { VITE_CADDIE_API_URL: 'http://caddie.test' },
  },
});
