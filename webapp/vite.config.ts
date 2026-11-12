import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served by the Nest app under /app/ (see src/main.ts)
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    // local dev: `npm run dev` here + the bot on :3000
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
