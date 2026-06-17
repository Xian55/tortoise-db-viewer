import { defineConfig } from "vite";

// GitHub Pages project site is served from /<repo>/.
// Override with BASE_PATH env (e.g. "/" for a user/custom-domain site).
const base = process.env.BASE_PATH || "/tortoise-wow-database/";

export default defineConfig({
  base,
  optimizeDeps: {
    // sql.js-httpvfs ships its own worker + wasm; don't pre-bundle it.
    exclude: ["sql.js-httpvfs"],
  },
  build: {
    target: "esnext",
    assetsInlineLimit: 0, // never inline the wasm
  },
  worker: {
    format: "es",
  },
});
