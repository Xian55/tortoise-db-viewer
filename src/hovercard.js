// Floating tooltip shown when hovering an item or quest link. Items reuse
// renderTooltip; quests get a compact card. Queried lazily, cached per key.
import { queryOne } from "./db.js";
import { renderTooltip, spellTooltip, modelThumbUrl, esc } from "./render.js";
import { Q_ITEM, Q_SPELL, Q_QUEST } from "./queries.js";
import { QUEST_TYPE, questZoneLabel } from "./constants.js";

const cache = new Map();              // `${kind}:${id}` -> rendered HTML (or null)
let card = null, currentKey = null, mx = 0, my = 0, raf = 0;

function ensureCard() {
  if (!card) {
    card = document.createElement("div");
    card.className = "hovercard";
    card.style.display = "none";
    document.body.appendChild(card);
  }
  return card;
}

function questCardHtml(q) {
  const bits = [];
  if (q.level > 0) bits.push(`Level ${q.level}`);
  const z = questZoneLabel(q.zone, q.zone_name);
  if (z) bits.push(esc(z));
  if (QUEST_TYPE[q.type]) bits.push(QUEST_TYPE[q.type]);
  const obj = q.objectives ? `<div class="tt-line">${esc(q.objectives)}</div>` : "";
  return `<div class="tooltip"><div class="tt-name" style="color:var(--gold)">${esc(q.title)}</div>` +
    `<div class="tt-line muted">${bits.join(" · ")}</div>${obj}</div>`;
}

async function getHtml(kind, id) {
  const key = `${kind}:${id}`;
  if (cache.has(key)) return cache.get(key);
  let html = null;
  if (kind === "item") {
    const it = await queryOne(Q_ITEM, [id]);
    if (it) {
      const spellMap = new Map();
      const sids = [1, 2, 3, 4, 5].map((i) => it[`spellid_${i}`]).filter(Boolean);
      await Promise.all(sids.map(async (sid) => { const sp = await queryOne(Q_SPELL, [sid]); if (sp) spellMap.set(sid, sp); }));
      html = renderTooltip(it, { spellMap });
    }
  } else if (kind === "quest") {
    const q = await queryOne(Q_QUEST, [id]);
    if (q) html = questCardHtml(q);
  } else if (kind === "spell") {
    const sp = await queryOne(Q_SPELL, [id]);
    if (sp) html = spellTooltip(sp);
  } else if (kind === "model") {
    // No DB round-trip: the display_id is already on the page. Render the
    // Wowhead thumb; if it 404s (Turtle-custom / un-rendered), swap to a note.
    html = `<div class="tooltip model-card"><div class="model-id muted">Display ID ${id}</div>` +
      `<img class="model-thumb" src="${modelThumbUrl(id)}" alt="" ` +
      `onerror="this.replaceWith(Object.assign(document.createElement('div'),` +
      `{className:'model-id muted',textContent:'No 3D preview available'}))"></div>`;
  }
  cache.set(key, html);
  return html;
}

function position() {
  if (!card || card.style.display === "none") return;
  const pad = 16, w = card.offsetWidth, h = card.offsetHeight;
  let x = mx + pad, y = my + pad;
  if (x + w > window.innerWidth - 8) x = mx - w - pad;
  if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
}

function hide() {
  currentKey = null;
  if (card) card.style.display = "none";
}

async function showFor(kind, id) {
  if (!id) return;
  const key = `${kind}:${id}`;
  if (key === currentKey) return;
  currentKey = key;
  const html = await getHtml(kind, id);
  if (currentKey !== key) return;      // pointer moved away during the query
  if (!html) { hide(); return; }
  const c = ensureCard();
  c.innerHTML = html;
  c.style.display = "block";
  position();
}

export function initHovercards() {
  document.addEventListener("mouseover", (e) => {
    mx = e.clientX; my = e.clientY;
    const model = e.target.closest("[data-display]");
    if (model) { showFor("model", Number(model.getAttribute("data-display"))); return; }
    const a = e.target.closest('a.ilink[href^="?item="], a.ilink[href^="?quest="], a.ilink[href^="?spell="]');
    if (a) {
      const p = new URLSearchParams(a.getAttribute("href").slice(1));
      if (p.get("item")) showFor("item", Number(p.get("item")));
      else if (p.get("quest")) showFor("quest", Number(p.get("quest")));
      else if (p.get("spell")) showFor("spell", Number(p.get("spell")));
    } else if (currentKey !== null) hide();
  });
  document.addEventListener("mousemove", (e) => {
    mx = e.clientX; my = e.clientY;
    if (currentKey !== null && !raf) raf = requestAnimationFrame(() => { raf = 0; position(); });
  });
  // hide while scrolling (the anchor moves out from under the pointer)
  window.addEventListener("scroll", hide, { passive: true });
}
