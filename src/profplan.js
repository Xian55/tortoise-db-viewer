// Profession leveling planner (?profplan=<skillId>). For a crafting profession it
// derives an efficient 1->300 route -- what to craft in each skill window, chosen to
// stay in the guaranteed-skill-up (orange) band as long as possible with the fewest
// crafts -- plus a deduped materials shopping list with sourcing, and localStorage
// tick-off progress. Modeled on wow-professions.com/classic.
//
// EVERYTHING is generated live from the crafting graph (spell_creates / spell_reagent
// / craft_source) via Q_CRAFTING -- the same data the ?browse=crafting page uses. No
// new tables, no hardcoded recipe ids. "Craft-count optimal": we do NOT invent gold/AH
// prices (no server keeps them); we only show a vendor's buy price where a reagent is
// actually vendor-sold. See src/guide.js for the manifest/live-resolve/progress pattern
// this mirrors.
import { query } from "./db.js";
import { Q_CRAFTING } from "./queries.js";
import { itemLink, spellLink, iconImg, moneyHtml, esc } from "./render.js";
import { PROFESSION, PROFESSION_LABEL, GATHERING_SKILLS } from "./constants.js";
import { navigate } from "./main.js";

const appEl = () => document.getElementById("app");
const TARGET = 300;           // classic profession cap
const NOBAND_WINDOW = 20;     // fallback grey span for recipes whose trivial band is unknown
const MAX_ORANGE = 40;        // cap a recipe's assumed orange window (a few source rows have
                              // an implausibly high yellow -> would recommend crafting one item 150x)
const MAX_SPAN = 70;          // cap a recipe's total skill-up span (orange->grey); a handful of
                              // source rows have a nonsense band (e.g. skill_min 275, max 310)
// Skip unfinished / placeholder recipes the server ships but that aren't real content.
const SKIP_RE = /\(NYI\)|\bNYI\b|\[PH\]|placeholder|deprecated|do not use|\(test\)/i;

// The craftable professions (gathering-only skills craft nothing). Mining (186) stays
// in -- its smelting recipes are real crafts under that skill.
const CRAFTABLE = PROFESSION.filter(([id]) => !GATHERING_SKILLS.has(id) || id === 186);
const PROF_ICON = {
  171: "trade_alchemy", 164: "trade_blacksmithing", 185: "inv_misc_food_15",
  333: "trade_engraving", 202: "trade_engineering", 129: "inv_misc_bandage_03",
  755: "inv_misc_gem_variety_01", 165: "trade_leatherworking", 186: "trade_mining",
  197: "trade_tailoring", 142: "ability_tracking",
};

// ---- localStorage progress (set of completed segment ids for one profession) ----
const PKEY = (skill) => `twdb:profplan:${skill}`;
function readDone(skill) {
  try { const v = JSON.parse(localStorage.getItem(PKEY(skill))); return new Set(Array.isArray(v) ? v : []); }
  catch { return new Set(); }
}
function writeDone(skill, set) {
  try { localStorage.setItem(PKEY(skill), JSON.stringify([...set])); } catch { /* private mode */ }
}

// Fold Q_CRAFTING's one-row-per-(spell,reagent) into one craft per spell (mirrors
// browse.js browseCrafting) and annotate each with its orange/yellow/green/grey band.
function foldCrafts(rows, skill) {
  const bySpell = new Map();
  for (const r of rows) {
    if (String(r.skill) !== String(skill)) continue;
    let g = bySpell.get(r.spell);
    if (!g) {
      g = {
        spell: r.spell, item: r.item, item_name: r.item_name, quality: r.quality, item_icon: r.item_icon,
        spell_name: r.spell_name, spell_icon: r.spell_icon, skill: r.skill,
        cooldown: (r.cooldown_ms || 0) + (r.cat_cooldown_ms || 0),
        learn_req: r.learn_req, skill_req: r.skill_req, min: r.skill_min, max: r.skill_max,
        trainer: r.trainer, auto: r.auto, recipe_item: r.recipe_item, recipe_name: r.recipe_name,
        recipe_quality: r.recipe_quality, recipe_icon: r.recipe_icon, reagents: [],
      };
      bySpell.set(r.spell, g);
    }
    if (r.reagent) g.reagents.push({ item: r.reagent, name: r.reagent_name, quality: r.reagent_quality, icon: r.reagent_icon, count: r.count || 1 });
  }
  for (const c of bySpell.values()) {
    // Orange floor: learn_req (trainer/recipe required skill) is the reliable field; a bogus
    // learn_req<=1 falls back to the spell's skill_req, then skill_min.
    const o = (c.learn_req && c.learn_req > 1) ? c.learn_req : (c.skill_req > 0 ? c.skill_req : (c.min || 1));
    const band = !!c.max;
    const grey = Math.max(o + 1, Math.min(band ? c.max : o + NOBAND_WINDOW, o + MAX_SPAN)); // clamp total span
    const yRaw = c.min && c.min > o ? c.min : o;
    c._o = o;
    c._gr = grey;
    c._y = Math.min(yRaw, o + MAX_ORANGE, grey);                        // yellow (orange window capped)
    c._g = Math.min(grey, Math.max(c._y, band ? Math.round(((c.min || o) + Math.min(c.max, o + MAX_SPAN)) / 2) : Math.round((o + grey) / 2))); // green
    c._band = band;
    c._cost = c.reagents.reduce((s, r) => s + (r.count || 1), 0) || 1;  // count fallback; sell-price-weighted in showProfPlan
    c._srcPref = c.trainer || c.auto ? 0 : 1;                           // prefer trainer/auto over recipe-drop
  }
  // learnable only (has a trainer / auto / recipe item -- you can't level on a recipe you
  // can never obtain), drop unfinished/placeholder rows, and drop cooldown recipes -- a
  // recipe on a cooldown (e.g. Mooncloth, 4-day CD) can't be spam-crafted to level.
  return [...bySpell.values()].filter((c) =>
    (c.recipe_item || c.trainer || c.auto) && !c.cooldown && !SKIP_RE.test(c.item_name || c.spell_name || ""));
}

// Color of a recipe at skill S: 0 orange (guaranteed), 1 yellow, 2 green, 3 grey (no skill-up).
function colorAt(c, S) { return S < c._y ? 0 : S < c._g ? 1 : S < c._gr ? 2 : 3; }
const COLOR = ["#ff8040", "#ffd100", "#40c040", "#808080"];
const COLOR_NAME = ["orange", "yellow", "green", "grey"];

// Expected crafts to move `from`->`to` on recipe c: ~1 craft/point in orange, a bit more in
// yellow, ~2 in green (skill-ups thin out). Deliberately approximate -- flagged in the UI.
function craftsFor(c, from, to) {
  let n = 0, s = from;
  while (s < to) {
    const col = colorAt(c, s);
    const bnd = col === 0 ? c._y : col === 1 ? c._g : c._gr;
    const e = Math.min(to, bnd);
    n += (e - s) * (col === 0 ? 1 : col === 1 ? 1.3 : 2);
    s = e;
    if (e === s && e < to) { s = to; }   // guard (shouldn't trigger; monotonic bands)
  }
  return Math.max(1, Math.ceil(n));
}

// Best recipe to craft at skill S: the CHEAPEST-material recipe that still yields a skill-up
// (any colour but grey). This is what keeps the shopping list small -- it leans on cheap
// filler (sharpening/weightstones) the way real leveling guides do, rather than grinding
// expensive gear. Ties: fewest crafts (orange first), trainer-taught, then newest.
function pickAt(crafts, S) {
  const usable = crafts.filter((c) => c._o <= S && S < c._gr);
  if (!usable.length) return null;
  // Prefer a reliable skill-up (orange/yellow); only fall back to green (~25% chance -> many
  // wasted crafts) when nothing reliable is craftable at this skill.
  const reliable = usable.filter((c) => colorAt(c, S) <= 1);
  const pool = reliable.length ? reliable : usable;
  pool.sort((a, b) =>
    (a._cost - b._cost) || (colorAt(a, S) - colorAt(b, S)) || (a._srcPref - b._srcPref) || (b._o - a._o) || (a.spell - b.spell));
  return pool[0];
}

// Other recipes viable in the same bracket -- the value-add over a linear guide: at a
// given skill range you often have several skill-up options using different mats, so the
// player can craft with whatever they already have. Craftable + still skilling up at the
// bracket start, ranked orange-first then cheaper; the chosen recipe is excluded.
function altsFor(crafts, seg) {
  const S = seg.from;
  return crafts
    .filter((c) => c.spell !== seg.c.spell && c._o <= S && S < c._gr)
    .sort((a, b) => (a._cost - b._cost) || (colorAt(a, S) - colorAt(b, S)) || (a._srcPref - b._srcPref) || (a.spell - b.spell))
    .slice(0, 6);
}

// Route: walk skill 1->TARGET, "sticky" on the current recipe -- keep crafting it while it
// still gives skill-ups, only switching when it greys out OR a fresher recipe drops into a
// better color band. This yields chunky, wow-professions-style steps (one recipe per band)
// rather than a switch every few points. Consecutive same-recipe steps merge.
function buildPath(crafts) {
  if (!crafts.length) return { segments: [], reachable: 0 };
  let S = Math.max(1, Math.min(...crafts.map((c) => c._o)));
  let cur = null;
  const raw = [];
  let guard = 0;
  while (S < TARGET && guard++ < 4000) {
    const cand = pickAt(crafts, S);
    const stale = !cur || S >= cur._gr ||
      (cand && cand.spell !== cur.spell && (cand._cost < cur._cost || colorAt(cand, S) < colorAt(cur, S)));
    if (stale) {
      if (!cand) {                           // nothing craftable now -> jump to next unlock
        const next = crafts.filter((c) => c._o > S).sort((a, b) => a._o - b._o)[0];
        if (!next) break;                    // route ends short
        raw.push({ gap: true, from: S, to: next._o });
        S = next._o; cur = null;
        continue;
      }
      cur = cand;
    }
    // ride the current recipe through orange+yellow (re-pick when it turns green), stopping
    // early if it greys out or a strictly cheaper recipe unlocks
    const relBound = S < cur._g ? cur._g : cur._gr;
    const cheaperUnlock = Math.min(TARGET, ...crafts.filter((c) => c._o > S && c._cost < cur._cost).map((c) => c._o));
    const to = Math.min(TARGET, relBound, cheaperUnlock);
    raw.push({ c: cur, from: S, to });
    S = to;
  }
  const segments = [];
  for (const seg of raw) {
    const prev = segments[segments.length - 1];
    if (seg.gap) { segments.push(seg); continue; }
    if (prev && !prev.gap && prev.c.spell === seg.c.spell) prev.to = seg.to;
    else segments.push({ ...seg });
  }
  for (const seg of segments) if (!seg.gap) { seg.crafts = craftsFor(seg.c, seg.from, seg.to); seg.id = `${seg.c.spell}:${seg.from}`; }
  return { segments, reachable: S };
}

// Weight each recipe's "cost" by its reagents' vendor sell price (a rarity proxy) so the
// route prefers genuinely cheap mats (stones/basic bars) over count-cheap but expensive
// ones (gold/truesilver bars). Falls back to reagent count when a price is unknown.
async function applyReagentCost(crafts) {
  const ids = [...new Set(crafts.flatMap((c) => c.reagents.map((r) => r.item)))];
  if (!ids.length) return;
  const rows = await query(`SELECT entry, sell_price FROM items WHERE entry IN (${ids.join(",")})`);
  const price = new Map(rows.map((r) => [r.entry, r.sell_price || 0]));
  for (const c of crafts) {
    c._cost = c.reagents.reduce((s, r) => s + (r.count || 1) * Math.max(price.get(r.item) || 0, 1), 0) || 1;
  }
}

// Flag each recipe as "cross-profession" (`_foreign`) when a reagent can only be obtained
// through ANOTHER crafting profession -- enchanting dusts/essences (disenchanting) or
// transmutes/enchanted bars. A reagent is fine (self-sufficient) if it's vendor-sold,
// gatherable, mob-dropped, or crafted by your own profession or a gathering partner
// (Mining smelting / Herbalism / Skinning). Powers the "Self-sufficient" toggle.
async function markForeign(crafts, skill) {
  const ids = [...new Set(crafts.flatMap((c) => c.reagents.map((r) => r.item)))];
  if (!ids.length) return;
  const inl = ids.join(",");
  const [obtain, disen, crafted] = await Promise.all([
    query(`SELECT DISTINCT item FROM npc_vendor WHERE item IN (${inl})
           UNION SELECT DISTINCT item FROM npc_vendor_template WHERE item IN (${inl})
           UNION SELECT DISTINCT item FROM drops WHERE src IN ('o','c','s','p') AND item IN (${inl})`),
    query(`SELECT DISTINCT item FROM drops WHERE src='e' AND item IN (${inl})`),
    query(`SELECT item, GROUP_CONCAT(DISTINCT skill) AS skills FROM spell_creates WHERE item IN (${inl}) GROUP BY item`),
  ]);
  const obtainSet = new Set(obtain.map((r) => r.item));
  const disenSet = new Set(disen.map((r) => r.item));
  const skillsBy = new Map(crafted.map((r) => [r.item, String(r.skills || "").split(",").filter(Boolean).map(Number)]));
  const selfSkills = new Set([skill, 186, 182, 393]);   // your profession + gathering partners
  const foreignItem = (id) => {
    if (obtainSet.has(id)) return false;
    const sk = skillsBy.get(id) || [];
    if (sk.some((k) => selfSkills.has(k))) return false;
    return disenSet.has(id) || sk.length > 0;
  };
  for (const c of crafts) c._foreign = c.reagents.some((r) => foreignItem(r.item));
}

// Resolve the transitive recipe tree for crafted reagents: a shopping-list mat that is
// itself crafted (e.g. Enchanted Thorium Bar = Thorium Bar + Illusion Dust) hides its own
// components. BFS from the crafted roots, one recipe (cheapest spell id) per item, so the
// list can expand each into its base mats. Returns Map<itemId, reagents[] | null>
// (null = base material, not craftable). Depth-bounded; cycle-safe via the visited set.
async function resolveRecipeMap(rootIds) {
  const map = new Map();
  let frontier = [...new Set(rootIds)];
  let depth = 0;
  while (frontier.length && depth++ < 5) {
    const need = [...new Set(frontier)].filter((id) => !map.has(id));
    if (!need.length) break;
    const recRows = await query(`SELECT item, MIN(spell) AS spell FROM spell_creates WHERE item IN (${need.join(",")}) GROUP BY item`);
    const spellByItem = new Map(recRows.map((r) => [r.item, r.spell]));
    const spells = [...new Set(spellByItem.values())];
    const [reagRows, prodRows] = spells.length ? await Promise.all([
      query(`SELECT sr.spell, sr.item AS reagent, sr.count, i.name, i.quality, di.icon
             FROM spell_reagent sr JOIN items i ON i.entry = sr.item
             LEFT JOIN item_display_info di ON di.ID = i.display_id
             WHERE sr.spell IN (${spells.join(",")})`),
      query(`SELECT entry, effects FROM spells WHERE entry IN (${spells.join(",")})`),
    ]) : [[], []];
    // how many the craft yields per cast (create-item effect 24; e.g. Smelt Bronze -> 2 bars)
    const produceBySpell = new Map();
    for (const r of prodRows) {
      let p = 1;
      try { const e = JSON.parse(r.effects || "[]").find((x) => x.effect === 24); if (e && e.value > 0) p = e.value; } catch { /* ignore */ }
      produceBySpell.set(r.entry, p);
    }
    const bySpell = new Map();
    for (const r of reagRows) (bySpell.get(r.spell) || bySpell.set(r.spell, []).get(r.spell)).push(r);
    const next = [];
    for (const id of need) {
      const spell = spellByItem.get(id);
      const reags = (bySpell.get(spell) || []).filter((r) => r.reagent !== id)
        .map((r) => ({ item: r.reagent, count: r.count || 1, name: r.name, quality: r.quality, icon: r.icon }));
      map.set(id, reags.length ? { reagents: reags, produce: produceBySpell.get(spell) || 1 } : null);
      for (const r of reags) next.push(r.item);
    }
    frontier = next;
  }
  return map;
}

// Nested transitive-reagent list for one crafted mat, quantities multiplied by how many the
// shopping list needs. Depth-capped + visited-guarded.
function subTree(itemId, qty, recipeMap, seen, depth) {
  const rec = recipeMap.get(itemId);
  if (!rec || !rec.reagents.length || depth >= 3 || seen.has(itemId)) return "";
  const seen2 = new Set(seen).add(itemId);
  const casts = Math.ceil(qty / (rec.produce || 1));   // e.g. 240 Bronze Bar / 2-per-cast = 120 casts
  return `<ul class="pp-sub">${rec.reagents.map((r) => {
    const need = (r.count || 1) * casts;
    return `<li><span class="pp-sub-q">${need}×</span> ${itemLink(r.item, r.name, r.quality, r.icon)}${subTree(r.item, need, recipeMap, seen2, depth + 1)}</li>`;
  }).join("")}</ul>`;
}

// Aggregate the deduped shopping list across chosen segments (reagent -> total count +
// the skill it's first needed at, for ordering).
function shoppingList(segments) {
  const totals = new Map();
  for (const seg of segments) {
    if (seg.gap) continue;
    for (const r of seg.c.reagents) {
      let t = totals.get(r.item);
      if (!t) { t = { item: r.item, name: r.name, quality: r.quality, icon: r.icon, total: 0, firstSkill: seg.from }; totals.set(r.item, t); }
      t.total += (r.count || 1) * seg.crafts;
      t.firstSkill = Math.min(t.firstSkill, seg.from);
    }
  }
  return [...totals.values()].sort((a, b) => a.firstSkill - b.firstSkill || a.name.localeCompare(b.name));
}

// Where each shopping-list reagent comes from. Five batched queries regardless of list
// size (integer ids are DB-sourced -> safe to inline). Vendor price = items.buy_price,
// shown only when the reagent is genuinely vendor-stocked.
async function sourceReagents(list) {
  const ids = list.map((r) => r.item);
  if (!ids.length) return new Map();
  const inl = ids.join(",");
  const [meta, vendor, gather, drop, crafted] = await Promise.all([
    query(`SELECT entry, buy_price FROM items WHERE entry IN (${inl})`),
    query(`SELECT DISTINCT item FROM npc_vendor WHERE item IN (${inl}) UNION SELECT DISTINCT item FROM npc_vendor_template WHERE item IN (${inl})`),
    query(`SELECT DISTINCT item FROM drops WHERE src='o' AND item IN (${inl})`),
    query(`SELECT DISTINCT item FROM drops WHERE src IN ('c','s','p') AND item IN (${inl})`),
    query(`SELECT DISTINCT item FROM spell_creates WHERE item IN (${inl})`),
  ]);
  const buy = new Map(meta.map((r) => [r.entry, r.buy_price]));
  const setOf = (rows) => new Set(rows.map((r) => r.item));
  const vend = setOf(vendor), gat = setOf(gather), drp = setOf(drop), crf = setOf(crafted);
  const out = new Map();
  for (const id of ids) out.set(id, { buy: buy.get(id) || 0, vendor: vend.has(id), gather: gat.has(id), drop: drp.has(id), crafted: crf.has(id) });
  return out;
}

// ---- rendering ----
const tag = (cls, text, title) => `<span class="tagx ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;

function productLink(c) {
  return c.item ? itemLink(c.item, c.item_name, c.quality, c.item_icon) : spellLink(c.spell, c.spell_name, c.spell_icon);
}
function sourceCell(c) {
  if (c.recipe_item) return `Recipe: ${itemLink(c.recipe_item, c.recipe_name, c.recipe_quality, c.recipe_icon)}`;
  if (c.trainer) return tag("src-crafted", "Trainer", "Taught by a profession trainer");
  if (c.auto) return tag("", "Auto", "Learned automatically with the profession");
  return "—";
}
// inline (comma) reagent list -- used in the compact alternatives rows
function reagentsCell(c) {
  return c.reagents.map((r) => `${itemLink(r.item, r.name, r.quality, r.icon)}${r.count > 1 ? ` ×${r.count}` : ""}`).join(", ") || "<span class=muted>—</span>";
}
// stacked reagent list (one per line) -- used for the main step
function reagentLines(c) {
  if (!c.reagents.length) return "";
  return `<ul class="pp-reagents">${c.reagents.map((r) =>
    `<li>${itemLink(r.item, r.name, r.quality, r.icon)}${r.count > 1 ? ` <span class="pp-rc">×${r.count}</span>` : ""}</li>`).join("")}</ul>`;
}
// The skill-range pill doubles as the done toggle (click to check off the bracket).
// Colored by the recipe's difficulty at the bracket start.
function rangeToggle(seg) {
  const col = COLOR[colorAt(seg.c, seg.from)];
  return `<button type="button" class="pp-range pp-toggle" data-seg="${esc(seg.id)}" style="--rc:${col}" aria-pressed="false" title="${COLOR_NAME[colorAt(seg.c, seg.from)]} here — click to mark this bracket done">` +
    `<span class="pp-tick" aria-hidden="true">✓</span>${seg.from}<span class="dim">→</span>${seg.to}</button>`;
}

// One alternative recipe line: its color at the bracket start, product, reagents, source.
function altLine(a, seg) {
  const col = COLOR[colorAt(a, seg.from)];
  const n = craftsFor(a, seg.from, Math.min(seg.to, a._gr));
  return `<div class="pp-alt">
    <span class="pp-alt-dot" style="background:${col}" title="${COLOR_NAME[colorAt(a, seg.from)]} here"></span>
    <span class="pp-alt-n">~${n}×</span> ${productLink(a)}
    <span class="pp-alt-sub muted">${reagentsCell(a)} <span class="dim">·</span> ${sourceCell(a)}</span>
  </div>`;
}

function segRow(seg) {
  if (seg.gap) return `<div class="pp-seg pp-gap"><span class="pp-range" style="border-color:#666;color:#888">${seg.from}<span class="dim"> → </span>${seg.to}</span>
    <span class="muted">No learnable recipe covers this range in the data — grind a lower recipe a little further, or check a trainer.</span></div>`;
  const c = seg.c;
  const alts = seg.alts || [];
  const altBlock = alts.length
    ? `<details class="pp-alts"><summary>${alts.length} alternative${alts.length === 1 ? "" : "s"} for this bracket</summary>${alts.map((a) => altLine(a, seg)).join("")}</details>`
    : "";
  const foreignTag = c._foreign
    ? `<span class="tagx pp-foreign" title="A reagent here needs another crafting profession (e.g. Enchanting/Alchemy) or the auction house">⚑ cross-profession</span>` : "";
  return `<div class="pp-seg" data-seg="${esc(seg.id)}">
    ${rangeToggle(seg)}
    <div class="pp-seg-main">
      <div class="pp-seg-title"><b>${seg.crafts}×</b> ${productLink(c)}${foreignTag} <span class="pp-seg-src muted">— ${sourceCell(c)}</span></div>
      ${reagentLines(c)}
      ${altBlock}
    </div>
  </div>`;
}

function shoppingRow(r, src, recipeMap) {
  const s = src.get(r.item) || {};
  const chips = [];
  if (s.vendor) chips.push(`<span class="pp-vendor">${tag("src-vendor", "Vendor")}${s.buy > 0 ? `<span class="pp-price">${moneyHtml(s.buy)}</span>` : ""}</span>`);
  if (s.gather) chips.push(tag("src-object", "Gather"));
  if (s.drop) chips.push(tag("src-drop", "Drops"));
  if (s.crafted) chips.push(tag("src-crafted", "Crafted"));
  // if this mat is itself crafted, break it down into its transitive base reagents
  const sub = recipeMap.get(r.item)?.reagents?.length ? subTree(r.item, r.total, recipeMap, new Set(), 0) : "";
  return `<div class="pp-shop-row">
    <span class="pp-qty"><b>${r.total}×</b></span>
    <div class="pp-shop-main">
      <div>${itemLink(r.item, r.name, r.quality, r.icon)}</div>
      <div class="pp-src">${chips.join(" ") || '<span class="muted">Unknown — see item page</span>'}</div>
      ${sub}
    </div>
  </div>`;
}

function profPicker(skill) {
  return CRAFTABLE.map(([id, name]) =>
    `<a class="pp-prof${String(id) === String(skill) ? " active" : ""}" href="?profplan=${id}">${iconImg(PROF_ICON[id] || "trade_engineering")}${esc(name)}</a>`
  ).join("");
}

export async function showProfPlan(rawSkill) {
  const app = appEl();
  // default to Blacksmithing when no/blank skill given
  let skill = Number(rawSkill) || 164;
  const name = PROFESSION_LABEL[skill];
  document.title = `${name || "Profession"} Leveling Planner - Tortoise-WoW DB`;

  if (!name || GATHERING_SKILLS.has(skill) && skill !== 186) {
    // gathering profession (or unknown) -> no craft path; point at the browse view
    app.innerHTML = `<div class="pp-page"><h1>Profession Leveling Planner</h1>
      <div class="pp-picker">${profPicker(skill)}</div>
      <p class="muted">${name ? `${esc(name)} is a gathering profession — you level it by gathering nodes out in the world, not by crafting.` : "Pick a crafting profession above."}
      ${name ? ` See <a class="nav" href="?browse=crafting&prof=${skill}">${esc(name)} in the browser</a>.` : ""}</p></div>`;
    return;
  }

  // Self-sufficient (default ON): steer away from recipes needing another profession's mats.
  const selfSuff = new URLSearchParams(location.search).get("self") !== "0";

  app.innerHTML = `<div class="loading">Planning ${esc(name)} 1→${TARGET}…</div>`;
  const rows = await query(Q_CRAFTING, []);
  const crafts = foldCrafts(rows, skill);
  await applyReagentCost(crafts);
  await markForeign(crafts, skill);
  if (selfSuff) for (const c of crafts) if (c._foreign) c._cost += 1e9;   // sort cross-profession recipes last
  const { segments, reachable } = buildPath(crafts);
  for (const seg of segments) if (!seg.gap) seg.alts = altsFor(crafts, seg);
  const list = shoppingList(segments);
  const src = await sourceReagents(list);
  // expand crafted mats (e.g. Enchanted Thorium Bar) into their transitive base reagents
  const recipeMap = await resolveRecipeMap(list.filter((r) => src.get(r.item)?.crafted).map((r) => r.item));

  const steps = segments.filter((s) => !s.gap);
  const totalCrafts = steps.reduce((n, s) => n + s.crafts, 0);
  const shortNote = reachable < TARGET
    ? `<p class="pp-note muted">⚠ The data yields a learnable route up to skill <b>${reachable}</b>. Higher ranks may need recipes the database can't tie to a trainer/pattern, or content beyond this dataset.</p>` : "";

  app.innerHTML = `<div class="pp-page">
    <div class="pp-head">
      <h1>${iconImg(PROF_ICON[skill] || "trade_engineering")} ${esc(name)} Leveling Planner</h1>
      <p class="muted">A low-cost 1→${TARGET} route generated live from the recipe database — it favours cheap materials and reliable skill-ups (never grinding a low-chance green recipe). Craft counts are estimates. Tick each step; progress is saved in this browser.</p>
    </div>
    <div class="pp-picker">${profPicker(skill)}</div>
    <label class="pp-self"><input type="checkbox" class="pp-self-cb"${selfSuff ? " checked" : ""}> Self-sufficient
      <span class="muted">— avoid recipes needing another profession's mats (enchanting dusts, transmutes, enchanted bars)</span></label>
    ${shortNote}
    <div class="pp-progress-row">
      <div class="pp-progress"><i></i></div>
      <span class="pp-progress-label"></span>
      <button type="button" class="pp-reset">Reset</button>
    </div>
    <div class="pp-body">
      <section class="pp-route panel">
        <h2>Route <span class="muted">(${steps.length} steps · ~${totalCrafts} crafts)</span></h2>
        ${segments.length ? segments.map(segRow).join("") : '<p class="muted">No learnable recipes found for this profession in the current dataset.</p>'}
      </section>
      <aside class="pp-shop panel">
        <h2>Shopping list <span class="muted">(${list.length} materials)</span></h2>
        ${list.length ? `<div class="pp-shop-list">${list.map((r) => shoppingRow(r, src, recipeMap)).join("")}</div>
          <p class="pp-note muted">Totals assume you follow the route above. Prices shown are the vendor buy price where a reagent is actually sold; gathered/looted mats have no fixed price.</p>` : '<p class="muted">—</p>'}
      </aside>
    </div>
  </div>`;

  wireProgress(skill, steps);
  app.querySelector(".pp-self-cb")?.addEventListener("change", (e) =>
    navigate(`?profplan=${skill}&self=${e.target.checked ? "1" : "0"}`));
}

function wireProgress(skill, steps) {
  const app = appEl();
  const done = readDone(skill);
  const bar = app.querySelector(".pp-progress > i");
  const label = app.querySelector(".pp-progress-label");
  const total = steps.length;
  const apply = () => {
    let d = 0;
    for (const btn of app.querySelectorAll(".pp-toggle")) {
      const on = done.has(btn.dataset.seg);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.closest(".pp-seg")?.classList.toggle("done", on);
      if (on) d++;
    }
    const pct = total ? Math.round((100 * d) / total) : 0;
    if (bar) bar.style.width = `${pct}%`;
    if (label) label.textContent = `${d} / ${total} steps · ${pct}%`;
  };
  apply();
  app.querySelector(".pp-route")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".pp-toggle");
    if (!btn) return;
    const seg = btn.dataset.seg;
    if (done.has(seg)) done.delete(seg); else done.add(seg);
    writeDone(skill, done);
    apply();
  });
  app.querySelector(".pp-reset")?.addEventListener("click", () => { done.clear(); writeDone(skill, done); apply(); });
}
