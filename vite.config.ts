import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath, URL } from 'node:url';
import { tryoneApiPlugin } from './server/vitePlugin';

// https://vite.dev/config/
// `--mode phone` enables HTTPS (self-signed) so a phone on the same Wi-Fi gets a
// secure context and the camera works. Plain `dev` stays HTTP for localhost.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    tryoneApiPlugin({ allowLocal: true }),
    ...(mode === 'phone' ? [basicSsl()] : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
}));
