import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve('./src/client/index.ts'),
      name: 'SipWorker',
      fileName: 'sip-worker',
      formats: ['es', 'umd']
    },
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