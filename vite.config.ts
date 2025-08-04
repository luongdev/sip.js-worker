import { defineConfig } from 'vite';
import path from 'path';
import dts from 'vite-plugin-dts';

// Main configuration for the library
export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';
  return {
    build: {
      lib: {
        entry: path.resolve('./src/client/index.ts'),
        name: 'SipWorker',
        formats: ['umd'],
        fileName: (format) => `sip-worker.${format}.js`,
      },
      rollupOptions: {
        external: ['sip.js'],
        output: {
          globals: {
            'sip.js': 'SIP'
          },
          inlineDynamicImports: true,
        },
      },
      emptyOutDir: isProd,
      sourcemap: !isProd,
      minify: isProd ? 'terser' : false,
      target: 'es2015',
    },
    plugins: [
      dts({
        insertTypesEntry: true,
        outDir: 'dist/types',
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
  };
});
