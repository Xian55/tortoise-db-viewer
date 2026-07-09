import { defineConfig } from "vite";

// GitHub Pages project site is served from /<repo>/.
// Override with BASE_PATH env (e.g. "/" for a user/custom-domain site).
const base = process.env.BASE_PATH || "/tortoise-db-viewer/";

export default defineConfig({
  base,
  optimizeDeps: {
    // sqlite-wasm ships its own .wasm; let Vite handle it as an asset.
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  // ES-format workers so db-worker.js can code-split its lazy `import("brotli-wasm")`
  // (the brotli decoder is only pulled in on the CDN-mirror fallback path).
  worker: {
    format: "es",
  },
  build: {
    target: "esnext",
    assetsInlineLimit: 0, // never inline the wasm
  },
});
