// Custom gear-score presets: user-defined stat-weight sets, saved in localStorage,
// selectable in the item browser's gear-score dropdown and the character sheet's
// spec dropdown. Managed on the ?weights page; shareable via ?weightset=<b64url>.
import { GEAR_STAT_LABEL, STAT_WEIGHT_PRESET_MAP } from "./constants.js";
import { esc } from "./render.js";

const KEY = "tw_weightsets";
// weightable stats = the gear stats + weapon speed (matches the character scoring;
// a negative speed weight favours faster weapons).
export const WEIGHT_STATS = [...Object.entries(GEAR_STAT_LABEL), ["speed", "Weapon Speed"]];
const LABELS = Object.fromEntries(WEIGHT_STATS);
export const weightLabel = (k) => LABELS[k] || k;

// ---- storage ----
export function loadSets() { try { const a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveSets(l) { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* private mode */ } }
export function getSet(id) { return loadSets().find((s) => s.id === id) || null; }
function upsertSet(s) { const l = loadSets(); const i = l.findIndex((x) => x.id === s.id); if (i >= 0) l[i] = s; else l.push(s); saveSets(l); }
function removeSet(id) { saveSets(loadSets().filter((s) => s.id !== id)); }
function newId() { return "w" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

// Resolve a preset/spec id to its weights: a saved custom set first, else a built-in.
export function resolveWeights(id) {
  const s = getSet(id);
  if (s) return s.weights;
  return STAT_WEIGHT_PRESET_MAP[id]?.weights || null;
}

// keep only valid stat keys + finite non-zero numbers
function cleanWeights(obj) {
  const w = {};
  for (const k in (obj || {})) { const v = Number(obj[k]); if (LABELS[k] && Number.isFinite(v) && v !== 0) w[k] = v; }
  return w;
}

// ---- share link (name + weights) ----
function b64urlEncode(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlDecode(s) { return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))); }
export function encodeSet(s) { return b64urlEncode(JSON.stringify({ n: s.name, w: s.weights })); }
function decodeSet(str) {
  try { const p = JSON.parse(b64urlDecode(str)); return { name: String(p.n || "Imported preset").slice(0, 60), weights: cleanWeights(p.w) }; }
  catch { return null; }
}
const exportJson = (s) => JSON.stringify({ name: s.name, weights: s.weights }, null, 2);

// ---- editor bits ----
const weightsPills = (w) => Object.entries(w).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  .map(([k, v]) => `<span class="wpill">${esc(weightLabel(k))} <b>×${v}</b></span>`).join('<span class="wsep">·</span>') || `<span class="muted">no weights</span>`;

function weightRowHtml(k, w) {
  return `<div class="ws-row">
    <select class="ws-stat"><option value="">Stat…</option>${WEIGHT_STATS.map(([v, l]) => `<option value="${v}"${v === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>
    <span class="cw-x">×</span>
    <input type="number" class="ws-val" step="0.5" value="${esc(String(w))}" placeholder="1">
    <button type="button" class="ws-rm" title="Remove">✕</button>
  </div>`;
}
function readWeights(root) {
  const w = {};
  root.querySelectorAll(".ws-row").forEach((r) => { const k = r.querySelector(".ws-stat").value; const v = Number(r.querySelector(".ws-val").value); if (k && Number.isFinite(v) && v !== 0) w[k] = v; });
  return w;
}
function editorHtml(set) {
  const rows = Object.entries(set.weights || {});
  return `<div class="ws-editor" data-id="${set.id}">
    <input type="text" class="ws-name" value="${esc(set.name)}" placeholder="Preset name" maxlength="60">
    <div class="ws-rows">${(rows.length ? rows : [["", ""]]).map(([k, w]) => weightRowHtml(k, w)).join("")}</div>
    <div class="ws-editor-actions">
      <button type="button" class="btn-sm ws-add">+ stat</button>
      <button type="button" class="btn ws-save">Save</button>
      <button type="button" class="btn ws-cancel">Cancel</button>
    </div>
    <p class="muted">Score = Σ (stat value × weight). Negative weights lower the score (e.g. Weapon Speed ×−3 favours faster weapons).</p>
  </div>`;
}

function copyLink(url, btn) {
  Promise.resolve(navigator.clipboard?.writeText(url)).then(() => { const t = btn.textContent; btn.textContent = "✓ Copied"; setTimeout(() => { btn.textContent = t; }, 1600); }).catch(() => {});
}
function download(name, text) {
  try { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = `${(name || "preset").replace(/[^\w-]+/g, "_")}.json`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href); } catch { /* clipboard fallback elsewhere */ }
}

// ---- manager page: ?weights ----
export function showWeightSets(navigate) {
  document.title = "Gear-score presets - Tortoise-WoW DB";
  const app = document.getElementById("app");
  const render = () => {
    const sets = loadSets();
    const cards = sets.length ? sets.map((s) => `<li class="ws-card" data-card="${s.id}">
        <div class="ws-card-head"><span class="ws-card-name">${esc(s.name)}</span>
          <span class="ws-card-actions">
            <button type="button" class="btn-sm" data-edit="${s.id}">Edit</button>
            <button type="button" class="btn-sm" data-share="${s.id}">Share</button>
            <button type="button" class="btn-sm" data-exp="${s.id}">Export</button>
            <button type="button" class="btn-sm danger" data-del="${s.id}">Delete</button>
          </span></div>
        <div class="ws-pills spec-weights">${weightsPills(s.weights)}</div>
      </li>`).join("")
      : `<li class="muted">No presets yet. Create one, or import below. They appear in the item browser's gear-score and the character sheet's spec picker.</li>`;
    app.innerHTML = `<div class="chars">
      <h1>Gear-score presets</h1>
      <p class="muted">Build reusable stat-weight sets (aowow-style "best gear for spec"). Saved in this browser; selectable wherever gear score is used.</p>
      <div class="char-toolbar"><button type="button" class="btn" id="wsNew">+ New preset</button></div>
      <ul class="char-list ws-list">${cards}</ul>
      <details class="char-import"${sets.length ? "" : " open"}>
        <summary>Import preset JSON</summary>
        <textarea id="wsJson" rows="7" spellcheck="false" placeholder='{"name":"My Tank","weights":{"def":12,"dodge":10,"sta":2}}'></textarea>
        <div class="char-import-actions"><button type="button" class="btn" id="wsImport">Import</button> <span class="muted" id="wsMsg"></span></div>
      </details>
    </div>`;

    app.querySelector("#wsNew").onclick = () => { const s = { id: newId(), name: "New preset", weights: {} }; upsertSet(s); render(); openEditor(s.id); };
    app.querySelector("#wsImport").onclick = () => {
      const raw = app.querySelector("#wsJson").value.trim(); const msg = app.querySelector("#wsMsg");
      if (!raw) { msg.textContent = "Paste JSON first."; return; }
      let data; try { data = JSON.parse(raw); } catch { msg.textContent = "Invalid JSON."; return; }
      const made = (Array.isArray(data) ? data : [data]).map((e) => ({ id: newId(), name: String(e.name || "Imported preset").slice(0, 60), weights: cleanWeights(e.weights) })).filter((s) => Object.keys(s.weights).length);
      if (!made.length) { msg.textContent = "No valid presets found."; return; }
      made.forEach(upsertSet); render();
    };
    app.querySelectorAll("[data-edit]").forEach((b) => { b.onclick = () => openEditor(b.dataset.edit); });
    app.querySelectorAll("[data-exp]").forEach((b) => { b.onclick = () => { const s = getSet(b.dataset.exp); if (s) { copyLink(exportJson(s), b); download(s.name, exportJson(s)); } }; });
    app.querySelectorAll("[data-share]").forEach((b) => { b.onclick = () => { const s = getSet(b.dataset.share); if (s) copyLink(`${location.origin}${location.pathname}?weightset=${encodeSet(s)}`, b); }; });
    app.querySelectorAll("[data-del]").forEach((b) => {
      let armed = false, t = 0;
      b.onclick = () => { if (!armed) { armed = true; b.textContent = "Confirm?"; b.classList.add("armed"); t = setTimeout(() => { armed = false; b.textContent = "Delete"; b.classList.remove("armed"); }, 3000); } else { clearTimeout(t); removeSet(b.dataset.del); render(); } };
    });
  };
  const openEditor = (id) => {
    const s = getSet(id); if (!s) return;
    const card = app.querySelector(`[data-card="${id}"]`); if (!card) return;
    card.innerHTML = editorHtml(s);
    const ed = card.querySelector(".ws-editor");
    ed.querySelector(".ws-name").focus();
    ed.querySelector(".ws-add").onclick = () => ed.querySelector(".ws-rows").insertAdjacentHTML("beforeend", weightRowHtml("", ""));
    ed.querySelector(".ws-rm") && ed.addEventListener("click", (e) => { if (e.target.matches(".ws-rm")) e.target.closest(".ws-row").remove(); });
    ed.querySelector(".ws-save").onclick = () => { s.name = ed.querySelector(".ws-name").value.trim() || s.name; s.weights = readWeights(ed); upsertSet(s); render(); };
    ed.querySelector(".ws-cancel").onclick = render;
  };
  render();
}

// ---- import a shared preset: ?weightset=<b64url> ----
export function showSharedWeightSet(encoded, navigate) {
  const app = document.getElementById("app");
  const dec = decodeSet(encoded);
  if (!dec || !Object.keys(dec.weights).length) {
    app.innerHTML = `<div class="chars"><h1>Invalid preset link</h1><p><a class="nav" href="?weights">← Gear-score presets</a></p></div>`;
    return;
  }
  document.title = `${dec.name} - Gear-score preset`;
  app.innerHTML = `<div class="chars">
    <h1>${esc(dec.name)}</h1>
    <p class="muted">A shared gear-score preset. Save it to use in the item browser and character sheet.</p>
    <div class="ws-pills spec-weights" style="margin:10px 0">${weightsPills(dec.weights)}</div>
    <div class="char-toolbar"><button type="button" class="btn" id="wsSave">★ Save to my presets</button>
      <a class="nav" href="?weights">← All presets</a></div>
  </div>`;
  app.querySelector("#wsSave").onclick = () => { upsertSet({ id: newId(), name: dec.name, weights: dec.weights }); navigate("?weights"); };
}
