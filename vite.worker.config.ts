import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve('./src/worker/index.ts'),
      name: 'SipWorker',
      fileName: 'sip-worker.worker',
      formats: ['es']
    },
    outDir: 'dist/worker',
    emptyOutDir: true,
    rollupOptions: {
      external: ['sip.js'],
      output: {
        globals: {
          'sip.js': 'SIP'
        }
      }
    }
  }
}); 