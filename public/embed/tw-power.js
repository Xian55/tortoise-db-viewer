/* Tortoise-WoW DB — embeddable powered tooltips.
 *
 * Drop this on any page to turn links to the Tortoise-WoW database into hover
 * tooltips (like Wowhead's power.js), no backend required:
 *
 *   <script src="https://xian55.github.io/tortoise-db-viewer/embed/tw-power.js" defer></script>
 *
 * It scans for links of either form and, on hover, fetches a tiny JSON blob
 * (built by scripts/build-tooltips.mjs, served with permissive CORS):
 *   ?item=123 / ?npc= / ?quest= / ?spell=      (SPA query links)
 *   /i/123    / /n/    / /q/     / /s/          (Open Graph stub links)
 *
 * Config (optional) via attributes on the <script> tag:
 *   data-tt-base="https://.../tortoise-db-viewer/"  override the data origin
 *   data-color="0"                                   don't recolor item links
 * The base is otherwise derived from this script's own src.
 */
(function () {
  "use strict";
  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName("script");
    return s[s.length - 1];
  })();

  // Base = everything up to and including the site path (…/tortoise-db-viewer/),
  // derived from this script's own src. Used for the custom-icon webp fallback.
  var base = "";
  if (script && script.src) base = script.src.replace(/embed\/[^/]*$/, "");
  if (base && base.slice(-1) !== "/") base += "/";
  // The tooltip JSON (~74k tiny files) is served from the R2 asset bucket, not the
  // Pages origin -- that many files overruns the Pages deploy's file sync. Default
  // the data origin to R2; data-tt-base overrides it (e.g. a self-host mirror).
  var ttBase = (script && script.getAttribute("data-tt-base"))
    || "https://pub-aedb97cad2314db2a24aed17421e1254.r2.dev/";
  if (ttBase.slice(-1) !== "/") ttBase += "/";
  var RECOLOR = !(script && script.getAttribute("data-color") === "0");

  var QUALITY = ["#9d9d9d", "#ffffff", "#1eff00", "#0070dd", "#a335ee", "#ff8000", "#e6cc80", "#e6cc80"];
  var KIND = { item: "i", npc: "n", quest: "q", spell: "s" };

  var cache = {};      // "i:123" -> {promise|data}
  var tip = null;      // the floating tooltip element
  var current = null;  // key currently shown

  function css() {
    if (document.getElementById("twp-style")) return;
    var s = document.createElement("style");
    s.id = "twp-style";
    s.textContent =
      ".twp-tip{position:fixed;z-index:2147483647;max-width:320px;pointer-events:none;" +
      "background:#0b0d13;border:1px solid #2a2f3a;border-radius:8px;padding:9px 11px;" +
      "font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif;color:#fff;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.65);opacity:0;transition:opacity .08s}" +
      ".twp-tip.on{opacity:1}.twp-name{font-weight:600;font-size:14px}" +
      ".twp-head{display:flex;gap:8px;align-items:center;margin-bottom:4px}" +
      ".twp-icon{width:36px;height:36px;border-radius:5px;border:1px solid #000;background:#000;flex:none}" +
      ".twp-sub{color:#9aa0ad}.twp-green{color:#1eff00}.twp-gold{color:#ffd100}";
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
    var parts = key.split(":");
    var p = fetch(ttBase + "tt/" + parts[0] + "/" + parts[1] + ".json", { mode: "cors" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
    cache[key] = p;
    p.then(function (d) { cache[key] = d || null; });
    return p;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function render(d) {
    if (!d) return "";
    var name = '<div class="twp-name" style="color:' + (d.q != null ? QUALITY[d.q] || "#fff" : "#fff") + '">' + esc(d.n) + "</div>";
    // items + spells carry an icon basename; try the WoW icon CDN, fall back to the
    // site's custom-icon webp (Turtle icons that aren't on Blizzard's CDN).
    var head = name;
    if (d.ic) {
      var cdn = "https://render-us.worldofwarcraft.com/icons/56/" + encodeURIComponent(String(d.ic).toLowerCase()) + ".jpg";
      var alt = base + "icons/custom/" + encodeURIComponent(String(d.ic).toLowerCase()) + ".webp";
      head = '<div class="twp-head"><img class="twp-icon" src="' + cdn + '" data-alt="' + esc(alt) + '" alt="">' + name + "</div>";
    }
    var lines = [];
    if (d.k === "i") {
      if (d.b) lines.push('<div class="twp-sub">' + esc(d.b) + "</div>");
      if (d.il) lines.push('<div class="twp-sub">Item Level ' + d.il + "</div>");
      if (d.rl) lines.push('<div class="twp-sub">Requires Level ' + d.rl + "</div>");
    } else if (d.k === "n") {
      if (d.s) lines.push('<div class="twp-sub">&lt;' + esc(d.s) + "&gt;</div>");
      lines.push('<div class="twp-sub">Level ' + esc(d.l) + (d.r ? " " + esc(d.r) : "") + (d.t ? " " + esc(d.t) : "") + "</div>");
    } else if (d.k === "q") {
      lines.push('<div class="twp-gold">' + (d.l ? "Level " + d.l + " quest" : "Quest") + "</div>");
      if (d.rl) lines.push('<div class="twp-sub">Requires level ' + d.rl + "</div>");
    } else if (d.k === "s") {
      if (d.d) lines.push('<div class="twp-green">' + esc(d.d) + "</div>");
    }
    return head + lines.join("");
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
      if (current !== key || !d) return;
      tip.innerHTML = render(d);
      var img = tip.querySelector(".twp-icon"); // CDN miss -> custom webp -> hide
      if (img) img.onerror = function () {
        if (this.dataset.alt && this.src !== this.dataset.alt) this.src = this.dataset.alt;
        else this.style.display = "none";
      };
      tip.classList.add("on");
      place(e);
      if (RECOLOR && d.k === "i" && d.q != null && !a.dataset.twpColored) {
        a.style.color = QUALITY[d.q] || a.style.color;
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
    if (!key || !base) return;
    show(a, key, e);
  });
  document.addEventListener("mousemove", function (e) { if (current) place(e); });
  document.addEventListener("mouseout", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (a && idOf(a.getAttribute("href") || "")) hide();
  });

  window.TWPower = { base: base, hide: hide };
})();
