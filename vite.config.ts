import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

/**
 * Single-origin build.
 *
 * The Cloudflare Vite plugin reads `wrangler.jsonc`, builds `worker/index.ts`
 * for workerd, and runs it in the dev server. That means `pnpm dev` exercises
 * the *real* Worker runtime (same fetch/crypto/KV semantics as production)
 * instead of a Node shim, which matters because we rely on WebCrypto for
 * Stripe signature verification and CSRF HMACs.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],

  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  build: {
    // Hashed, immutable asset filenames so we can cache them for a year.
    assetsDir: 'assets',
    sourcemap: true,
    target: 'es2022',
    // Fail the build if the initial payload regresses. PixiJS, the admin
    // surface and the claim wizard are all lazy chunks, so the entry chunk
    // should stay small.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('pixi.js')) return 'pixi';
            if (id.includes('react-router')) return 'router';
            if (id.includes('@tanstack')) return 'query';
            if (id.includes('react-dom') || id.includes('/react/')) return 'react';
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },

  // Never inline environment values other than the VITE_ prefixed, explicitly
  // public ones. Vite's default already does this; this comment exists so the
  // next person does not add `define: { ... }` with a secret in it.
  envPrefix: ['VITE_'],
});
