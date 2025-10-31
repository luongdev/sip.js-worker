import { defineConfig } from 'vite';
import path from 'path';

// Configuration for worker
export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';
  return {
    build: {
      lib: {
        entry: path.resolve('./src/worker/index.ts'),
        name: 'SipWorker',
        formats: ['iife'],
        fileName: () => `sip-worker.worker.js`,
      },
      rollupOptions: {
        // external: ['sip.js'],
        output: {
          globals: {
            'sip.js': 'SIP'
          },
          inlineDynamicImports: true,
        },
      },
      outDir: 'dist',
      sourcemap: !isProd,
      minify: isProd ? 'terser' : false,
      emptyOutDir: false,
      target: 'es2015',
    },
  };
});
