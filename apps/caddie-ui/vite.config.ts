import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Bind to every interface so a phone on the same network, or a forwarded
    // port, can reach it during device testing.
    host: true,
  },
});
