import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import scriptca from '@unikit-bridge/scriptca/vite';

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter(),
    }),
    scriptca(),
  ],
  build: {
    // The drop-in browser client initializes WASM with top-level await.
    target: 'es2022',
  },
  optimizeDeps: {
    exclude: ['@unikit-bridge/scriptca/core', '@unikit-bridge/scriptca/core/wasm', '@unikit-bridge/scriptca/core/wasi'],
  },
});
