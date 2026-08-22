import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { defineConfig } from "vite";

// A cache-busting stamp for the model3d assets. They live on R2 behind a CDN with a
// seven-day max-age and their names never change, so REPLACING one -- re-exporting the
// character models, say -- leaves visitors and edge caches on the old copy until the TTL
// runs out. (Measured: a re-export was live at one PoP and a week stale at another, which
// showed up as one race's shoulders keeping the wrong scale.) Hashing the manifest gives
// one stamp for the whole set: any republish changes every model3d URL, which costs a
// re-download of a few megabytes on a release that changed models and nothing otherwise.
const model3dVersion = (() => {
  try {
    const m = JSON.parse(readFileSync("scripts/data/assets-manifest.json", "utf8"));
    const files = m.sets?.model3d?.files || m.sets?.model3d || {};
    const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    return digest.slice(0, 10);
  } catch {
    return "";                      // no manifest (a fork, a partial checkout): no stamp
  }
})();

// GitHub Pages project site is served from /<repo>/.
// Override with BASE_PATH env (e.g. "/" for a user/custom-domain site).
const base = process.env.BASE_PATH || "/tortoise-db-viewer/";

export default defineConfig({
  base,
  define: { __MODEL3D_V__: JSON.stringify(model3dVersion) },
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
