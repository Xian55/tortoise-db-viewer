/* Tortoise-WoW DB — embeddable powered tooltips.
 *
 * Drop this on any page to turn links to the Tortoise-WoW database into rich hover
 * tooltips (like Wowhead's power.js), no backend required:
 *
 *   <script src="https://xian55.github.io/tortoise-db-viewer/embed/tw-power.js" defer></script>
 *
 * It scans for links of either form and, on hover, fetches the entity's JSON from
 * the public API (scripts/build-api.mjs -> R2, permissive CORS) and injects the
 * pre-rendered in-game `tooltipHtml` (the SAME tooltip the detail page shows —
 * stats, sources, set bonuses, spell effects):
 *   ?item=123 / ?npc= / ?quest= / ?spell=      (SPA query links)
 *   /i/123    / /n/    / /q/     / /s/          (Open Graph stub links)
 *
 * Config (optional) via attributes on the <script> tag:
 *   data-api-base="https://api.tortoiseclothing.org/"  override the API origin
 *   data-color="0"                                      don't recolor item links
 * The site base (for the Turtle custom-icon webp fallback) is derived from src.
 */
(function () {
  "use strict";
  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName("script");
    return s[s.length - 1];
  })();

  // Site base = everything up to and including the site path (…/tortoise-db-viewer/),
  // derived from this script's own src. Used only for the custom-icon webp fallback.
  var base = "";
  if (script && script.src) base = script.src.replace(/embed\/[^/]*$/, "");
  if (base && base.slice(-1) !== "/") base += "/";

  // The rich per-entity JSON is served from the public API custom domain (R2 +
  // Cloudflare, CORS *). data-api-base overrides it (self-host mirror); the legacy
  // data-tt-base attr is still honoured for back-compat.
  var apiBase = (script && (script.getAttribute("data-api-base") || script.getAttribute("data-tt-base")))
    || "https://api.tortoiseclothing.org/";
  if (apiBase.slice(-1) !== "/") apiBase += "/";
  var RECOLOR = !(script && script.getAttribute("data-color") === "0");

  var KIND = { item: "i", npc: "n", quest: "q", spell: "s" };
  var QUESTMARK = "https://render.worldofwarcraft.com/us/icons/56/inv_misc_questionmark.jpg";

  var cache = {};      // "i:123" -> {promise|data}
  var tip = null;      // the floating tooltip element
  var current = null;  // key currently shown

  // Scoped copy of the app's tooltip CSS (src/style.css), so the injected
  // `tooltipHtml` renders identically. Everything is under `.twp-tip` and the CSS
  // vars are redefined locally so it can't clash with or depend on the host page.
  function css() {
    if (document.getElementById("twp-style")) return;
    var s = document.createElement("style");
    s.id = "twp-style";
    s.textContent =
      ".twp-tip{position:fixed;z-index:2147483647;max-width:360px;pointer-events:none;" +
      "opacity:0;transition:opacity .08s;" +
      "--text:#d6d6d6;--muted:#8a8f9c;--gold:#ffd100;--tooltip-bg:#06060a;--tooltip-border:#3a3f4b}" +
      ".twp-tip.on{opacity:1}" +
      ".twp-tip *{box-sizing:border-box}" +
      ".twp-tip .tooltip{width:auto;background:var(--tooltip-bg);border:1px solid var(--tooltip-border);" +
      "border-radius:8px;padding:12px 14px;color:var(--text);" +
      "font:14px/1.5 'Segoe UI',system-ui,sans-serif}" +
      ".twp-tip a{color:#4ea3ff;text-decoration:none}" +
      ".twp-tip .tt-head{display:flex;gap:12px;align-items:center;margin-bottom:8px}" +
      ".twp-tip .tt-icon{width:48px;height:48px;border-radius:6px;border:1px solid #000;background:#000;flex:none}" +
      ".twp-tip .tt-name{font-size:17px;font-weight:600;line-height:1.2}" +
      ".twp-tip .tt-rank{margin-left:auto;align-self:center;font-size:13px}" +
      ".twp-tip .tt-line{color:#fff}" +
      ".twp-tip .tt-split{display:flex;justify-content:space-between;gap:12px}" +
      ".twp-tip .tt-l{text-align:left}.twp-tip .tt-r{color:var(--muted)}" +
      ".twp-tip .tt-stat,.twp-tip .tt-req{color:#fff}" +
      ".twp-tip .tt-set{margin-top:8px;border-top:1px solid var(--tooltip-border);padding-top:6px}" +
      ".twp-tip .tt-set-name,.twp-tip .tt-set-name a{color:var(--gold);font-weight:600;margin-bottom:2px}" +
      ".twp-tip .tt-set-member{padding-left:8px;line-height:1.45;color:var(--muted)}" +
      ".twp-tip .tt-set-member a{color:var(--muted)}.twp-tip .tt-set-member b{color:var(--text);font-weight:600}" +
      ".twp-tip .tt-set-bonus{padding-top:2px}" +
      ".twp-tip .tt-spell{color:#1eff00}.twp-tip .tt-spell a{color:inherit}" +
      ".twp-tip .tt-flavor{color:var(--gold);font-style:italic;margin-top:4px}" +
      ".twp-tip .tt-buy,.twp-tip .tt-sell{color:var(--muted);margin-top:6px}" +
      ".twp-tip .tt-buy+.tt-sell{margin-top:2px}" +
      ".twp-tip .muted{color:var(--muted)}" +
      ".twp-tip .il-icon{width:18px;height:18px;vertical-align:-4px;margin-right:6px;" +
      "border-radius:3px;border:1px solid #000;background:#000}" +
      ".twp-tip a.ilink.quest{color:var(--gold)}.twp-tip a.ilink.faction{color:#66c2cc}" +
      ".twp-tip a.ilink.zone{color:#8fd18f}" +
      ".twp-tip .spell-card{max-width:360px}.twp-tip .spell-card .tt-spell{color:var(--gold)}";
    document.head.appendChild(s);
  }

  function idOf(href) {
    if (!href) return null;
    var m = href.match(/[?&](item|npc|quest|spell)=(\d+)/);
    if (m) return KIND[m[1]] + ":" + m[2];
    m = href.match(/\/(i|n|q|s)\/(\d+)(?:[?#].*)?$/);
    if (m) return m[1] + ":" + m[2];
    return null;
  }

  function fetchData(key) {
    if (cache[key]) return cache[key];
    var parts = key.split(":");                       // ["i","19019"]
    var p = fetch(apiBase + parts[0] + "/" + parts[1], { mode: "cors" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    cache[key] = p;
    p.then(function (d) { cache[key] = d || null; });
    return p;
  }

  // The API's tooltipHtml <img>s point at the WoW icon CDN with an inline onerror
  // to the "?" icon. Turtle custom icons aren't on that CDN, so re-chain each image:
  // CDN -> the site's committed custom webp -> "?" -> hidden.
  function fixIcons() {
    var imgs = tip.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        var m = /\/icons\/56\/([^/.]+)\.jpg/i.exec(img.getAttribute("src") || "");
        var name = m && m[1];
        var stage = 0;
        img.onerror = function () {
          stage++;
          if (stage === 1 && name && base) { this.src = base + "icons/custom/" + name + ".webp"; return; }
          if (stage <= 2) { this.src = QUESTMARK; return; }
          this.style.visibility = "hidden";
        };
      })(imgs[i]);
    }
  }

  function place(e) {
    if (!tip) return;
    var pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    var x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = Math.max(8, e.clientY - h - pad);
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  function show(a, key, e) {
    css();
    if (!tip) { tip = document.createElement("div"); tip.className = "twp-tip"; document.body.appendChild(tip); }
    current = key;
    Promise.resolve(fetchData(key)).then(function (d) {
      if (current !== key || !d || !d.tooltipHtml) return;
      tip.innerHTML = d.tooltipHtml;
      fixIcons();
      tip.classList.add("on");
      place(e);
      if (RECOLOR && d.type === "item" && d.quality && d.quality.color && !a.dataset.twpColored) {
        a.style.color = d.quality.color;
        a.dataset.twpColored = "1";
      }
    });
  }

  function hide() { current = null; if (tip) tip.classList.remove("on"); }

  // Delegated hover: works for links added after load, too.
  document.addEventListener("mouseover", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var key = idOf(a.getAttribute("href") || "");
    if (!key) return;
    show(a, key, e);
  });
  document.addEventListener("mousemove", function (e) { if (current) place(e); });
  document.addEventListener("mouseout", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (a && idOf(a.getAttribute("href") || "")) hide();
  });

  window.TWPower = { base: base, apiBase: apiBase, hide: hide };
})();
