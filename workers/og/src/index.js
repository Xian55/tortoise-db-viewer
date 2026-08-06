/**
 * og.tortoiseclothing.org -- per-entity link-unfurl pages, rendered on demand.
 *
 * WHY THIS EXISTS
 * The site is a query-param SPA on GitHub Pages, so a crawler that sees ?item=19019
 * only gets index.html's generic <meta> (crawlers don't run JS, and a static host
 * can't vary a file by query string). That used to be solved by prerendering one tiny
 * HTML file per entity into the Pages artifact -- 94,930 of them. Pages syncs an
 * artifact file-by-file, so that took 15-20 min and routinely timed the deploy out.
 *
 * Now nothing is prerendered. This Worker builds the same page per request:
 *   items / NPCs / quests / spells  -> the JSON API already published to R2
 *                                      (api.tortoiseclothing.org), so it is always
 *                                      in sync with the DB and costs no build step
 *   objects / zones / factions / sets -> og-extra.json, bundled (1.9k entries, 107 KB)
 *                                      because those four have no API
 *
 * Humans are redirected straight into the app; crawlers get the meta and never follow.
 */
import EXTRA from "../og-extra.json";

const APP = "https://xian55.github.io/tortoise-db-viewer/";
const API = "https://api.tortoiseclothing.org";
const ICON_CDN = "https://render-us.worldofwarcraft.com/icons/56";
// Turtle-custom icons aren't on Blizzard's CDN; they're served per-icon from the site.
// EXTRA._customIcons is the set of those basenames (emitted by build-og.mjs).
const CUSTOM = new Set(EXTRA._customIcons || []);
const iconUrl = (basename) => {
  if (!basename) return null;
  const b = String(basename).toLowerCase();
  return CUSTOM.has(b) ? `${APP}icons/custom/${b}.webp` : `${ICON_CDN}/${b}.jpg`;
};

// prefix -> SPA query param. Mirrors SHARE_PREFIX in src/main.js and the PARAM map in
// public/404.html -- keep all three in step.
const PARAM = {
  i: "item", n: "npc", q: "quest", s: "spell",
  o: "object", z: "zone", f: "faction", is: "itemset",
};
// The four the JSON API covers (scripts/build-api.mjs emits i/n/q/s).
const API_BACKED = new Set(["i", "n", "q", "s"]);

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const trim = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n), sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:]+$/, "") + "…";
};

/** Title/description/image from the public JSON API, shaped per entity type. */
function fromApi(prefix, j) {
  // NB: class/subclass/slot/quality are {id,name} objects in the API, not strings.
  // Mirrors itemDesc() in scripts/build-og.mjs: weapons are named by their subclass,
  // armor by "<subclass> <slot>", anything else by slot or class.
  if (prefix === "i") {
    const sub = (j.class?.id === 2 || j.class?.id === 4) ? j.subclass?.name : null;
    const slot = j.slot?.name;
    const kind = sub ? (j.class?.id === 4 && slot ? `${sub} ${slot}` : sub) : (slot || j.class?.name || "");
    const ilvl = j.itemLevel > 0 ? ` · Item Level ${j.itemLevel}` : "";
    const req = j.requiredLevel > 0 ? ` · Requires Level ${j.requiredLevel}` : "";
    const desc = ([j.quality?.name, kind].filter(Boolean).join(" ") + ilvl + req).trim();
    return { title: j.name, desc: trim(desc || "Item in Tortoise-WoW.", 180),
             image: iconUrl(j.icon) };
  }
  // `level` is already a formatted string ("11" or "60-61"); rank/creatureType are names.
  if (prefix === "n") {
    const head = j.subname ? `<${j.subname}> · ` : "";
    const tail = `Level ${j.level ?? "?"} ${j.rank || ""} ${j.creatureType || ""}`.replace(/\s+/g, " ").trim();
    return { title: j.name, desc: trim(head + tail, 180), image: null };
  }
  if (prefix === "q") {
    const lvl = j.level > 0 ? `Level ${j.level} quest. ` : "";
    return { title: j.title, desc: trim(lvl + (j.objectives || j.details || ""), 200) || "Quest in Tortoise-WoW.", image: null };
  }
  // spell
  return { title: j.name, desc: trim(j.description || "Spell in Tortoise-WoW.", 200),
           image: iconUrl(j.icon) };
}

function page({ title, desc, image }, appUrl, ogUrl) {
  const t = esc(title), d = esc(desc);
  const img = image ? `
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${t}">
<meta name="twitter:image" content="${esc(image)}">` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${t} - Tortoise-WoW DB</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${esc(appUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tortoise-WoW Database">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${esc(ogUrl)}">${img}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta http-equiv="refresh" content="0; url=${esc(appUrl)}">
<script>location.replace(${JSON.stringify(appUrl)})</script>
</head>
<body>Redirecting to <a href="${esc(appUrl)}">${t}</a>…</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const m = /^\/([a-z]{1,2})\/(\d+)\/?$/.exec(url.pathname);
    const param = m && PARAM[m[1]];
    if (!param) return Response.redirect(APP, 302);

    const [, prefix, id] = m;
    const appUrl = `${APP}?${param}=${id}`;

    // Serve from the edge cache when we can -- a popular link gets unfurled by many
    // crawlers at once, and the API fetch below is the only slow part.
    //
    // The cache key carries the Worker VERSION. Without it a bad render is pinned for
    // the full s-maxage (24h) with no purge path -- exactly what happened when a
    // pre-fix build cached CDN urls for Turtle-custom icons. Keying on the version
    // means every `wrangler deploy` invalidates cleanly.
    const cache = caches.default;
    const key = new Request(`${url.origin}${url.pathname}?v=${env.CF_VERSION?.id || "dev"}`, request);
    const hit = await cache.match(key);
    if (hit) return hit;

    let meta = null;
    if (API_BACKED.has(prefix)) {
      try {
        const r = await fetch(`${API}/${prefix}/${id}`, { cf: { cacheTtl: 3600, cacheEverything: true } });
        if (r.ok) meta = fromApi(prefix, await r.json());
      } catch { /* fall through to the generic card */ }
    } else {
      const e = EXTRA[prefix]?.[id];
      if (e) meta = { title: e[0], desc: e[1], image: e[2] ?? null };
    }

    // Unknown id (or the API is down): still redirect the human, just without rich
    // meta. Never 404 -- a shared link must always open.
    if (!meta) meta = { title: "Tortoise-WoW Database", desc: "Item, NPC and quest database for Tortoise-WoW.", image: null };

    const res = new Response(page(meta, appUrl, url.href), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=3600, s-maxage=86400",
      },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },
};
