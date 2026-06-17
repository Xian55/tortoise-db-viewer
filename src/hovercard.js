// Floating item tooltip shown when hovering an item link. Reuses renderTooltip;
// queries the item (+ its spell text) lazily and caches per id.
import { queryOne } from "./db.js";
import { renderTooltip } from "./render.js";
import { Q_ITEM, Q_SPELL } from "./queries.js";

const cache = new Map();
let card = null, currentId = null, mx = 0, my = 0, raf = 0;

function ensureCard() {
  if (!card) {
    card = document.createElement("div");
    card.className = "hovercard";
    card.style.display = "none";
    document.body.appendChild(card);
  }
  return card;
}

async function getItem(id) {
  if (cache.has(id)) return cache.get(id);
  const it = await queryOne(Q_ITEM, [id]);
  let data = null;
  if (it) {
    const spellMap = new Map();
    const sids = [1, 2, 3, 4, 5].map((i) => it[`spellid_${i}`]).filter(Boolean);
    await Promise.all(sids.map(async (sid) => { const sp = await queryOne(Q_SPELL, [sid]); if (sp) spellMap.set(sid, sp); }));
    data = { it, spellMap };
  }
  cache.set(id, data);
  return data;
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
  currentId = null;
  if (card) card.style.display = "none";
}

async function showFor(a) {
  const id = Number(new URLSearchParams(a.getAttribute("href").slice(1)).get("item"));
  if (!id || id === currentId) return;
  currentId = id;
  const data = await getItem(id);
  if (currentId !== id) return;        // pointer moved away during the query
  if (!data) { hide(); return; }
  const c = ensureCard();
  c.innerHTML = renderTooltip(data.it, { spellMap: data.spellMap });
  c.style.display = "block";
  position();
}

export function initHovercards() {
  document.addEventListener("mouseover", (e) => {
    mx = e.clientX; my = e.clientY;
    const a = e.target.closest('a.ilink[href^="?item="]');
    if (a) showFor(a);
    else if (currentId !== null) hide();
  });
  document.addEventListener("mousemove", (e) => {
    mx = e.clientX; my = e.clientY;
    if (currentId !== null && !raf) raf = requestAnimationFrame(() => { raf = 0; position(); });
  });
  // hide while scrolling (the anchor moves out from under the pointer)
  window.addEventListener("scroll", hide, { passive: true });
}
