import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@myriaddreamin/typst-ts-web-compiler', '@myriaddreamin/typst-ts-renderer'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // mod/ holds a Claude Code plugin whose tests run under `claude plugin test`
  test: { exclude: ['mod/**', 'node_modules/**', 'dist/**', 'release/**'] },
});
