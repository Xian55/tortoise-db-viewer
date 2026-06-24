// Asset hosts. Default to the Pages base path so dev + Pages still resolve when
// the R2 env vars are unset; CI sets VITE_*_BASE to the R2 public URL so the
// heavy DB + maps + icon atlas are served off GitHub Pages bandwidth.
export const DATA_BASE = import.meta.env.VITE_DATA_BASE || `${import.meta.env.BASE_URL}data/`;
export const ASSETS_BASE = import.meta.env.VITE_ASSETS_BASE || import.meta.env.BASE_URL;
