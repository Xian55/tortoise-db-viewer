// Hunter Pets section (?pets index + ?petfamily=<id> detail).
//
// Data is DERIVED, not hand-listed: the tameable creatures + their family come from
// creature_template (beast_family + the type_flags TAMEABLE bit, ingested in build-db);
// family name/diet/icon from the client CreatureFamily.dbc; the trainable ability set
// from the spells table (skill 261 Beast Training) plus each family's own skill line.
// Curated pet-families.json adds only role + Health/Armor/Damage stat modifiers.
// Turtle-WoW custom families (Serpent/Fox/Moth) and custom tameable NPCs are flagged.
import { query, queryOne } from "./db.js";
import * as Q from "./queries.js";
import { npcLink, petFamilyLink, iconImg, zoneLink, esc, resolveSpellText } from "./render.js";
import { createTable } from "./table.js";
import { CREATURE_RANK } from "./constants.js";

// ability page path -> ?petability=<key> (Petopia-style per-rank "who to tame" view)
const abilityLink = (key, name, icon) => `<a class="ilink" href="?petability=${esc(key)}">${icon ? iconImg(icon) : ""}${esc(name)}</a>`;

const appEl = () => document.getElementById("app");
const lvlRange = (r) => (r.level_max && r.level_max !== r.level_min ? `${r.level_min}-${r.level_max}` : `${r.level_min || "?"}`);
const twTag = (custom) => (custom ? ` <span class="tagx tw-tag" title="Added by Turtle WoW (not in vanilla 1.12)">TW</span>` : "");

// A Health/Armor/Damage stat-modifier bar cell (multiplier vs a 1.0 baseline). We show the
// exact multiplier (authoritative) rather than Petopia's Low/Med/High label. Bar maps
// 0.85–1.15 -> 0–100%; green above 1.0, red below.
const statBarCell = (v) => {
  if (v == null) return `<span class="muted">—</span>`;
  const pctv = Math.max(0, Math.min(100, ((v - 0.85) / 0.30) * 100));
  const cls = v > 1.001 ? "hi" : v < 0.999 ? "lo" : "mid";
  return `<span class="pet-statcell"><span class="pet-statcell-bar"><span class="pet-statcell-fill ${cls}" style="width:${pctv.toFixed(0)}%"></span></span><span class="pet-statcell-val">×${v.toFixed(2)}</span></span>`;
};
// Diet label -> item food_type (item_template.food_type; matches CreatureFamily PetFoodMask
// bit order). `asLinks` makes each pill link the item browse filtered to that food type --
// only safe OUTSIDE an <a> (the family index cards are themselves anchors; nested <a> is
// invalid HTML), so cards pass false and the family-detail header passes true.
const FOOD_TYPE = { meat: 1, fish: 2, cheese: 3, bread: 4, fungus: 5, fruit: 6, "raw meat": 7, "raw fish": 8 };
const dietPills = (diet, asLinks = false) => (diet || "").split(",").map((d) => d.trim()).filter(Boolean).map((d) => {
  const ft = FOOD_TYPE[d.toLowerCase()];
  return asLinks && ft
    ? `<a class="pet-diet-pill nav" href="?browse=items&food=${ft}" title="Food a ${esc(d.toLowerCase())}-eating pet can be fed">${esc(d)}</a>`
    : `<span class="pet-diet-pill">${esc(d)}</span>`;
}).join("");

// ability_key -> [{rank, spell, level}] (ascending). `level` = the pet level a rank
// needs; a tamed pet gets the highest rank its level allows.
function groupRanks(rows) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r.ability_key)) m.set(r.ability_key, []); m.get(r.ability_key).push(r); }
  for (const list of m.values()) list.sort((a, b) => a.rank - b.rank);
  return m;
}
// Per-rank chips: number + the pet level to tame for it; hover explains, click -> spell.
const rankChips = (ranks) => (ranks || []).map((r) =>
  `<a class="pet-rank ilink spell" href="?spell=${r.spell}" title="Rank ${r.rank} — tame a beast of level ${r.level}+ to learn it">${r.rank}<small>L${r.level}</small></a>`).join("");

// One "Learn by taming" list item: NPC (Family, level, Zone), all links.
const petBullet = (c) => `<li>${npcLink(c.entry, c.name)}${twTag(c.custom)} <span class="muted">(${petFamilyLink(c.pet_family, c.family)}, ${lvlRange(c)}${c.zone ? `, ${zoneLink(c.areaid, c.zone)}` : ""})</span></li>`;

// An ability learned by ~all families is "universal" (Growl, Cower, the passives): its
// per-rank "who to tame" list would be EVERY beast — redundant with the family-specific
// abilities and ~74% of the page's DOM. For those we show the ranks + a note, not the list.
const UNIVERSAL_MIN = 18; // families-with-abilities is ~20; family-specific abilities top out ~16

// Per-rank sections for ONE ability (Petopia-style). `ranks` ascending, each with the real
// spell's effect fields (for the resolved "7 to 9 damage" text); `tames` = tameable beasts
// of the ability's families. `showTames=false` prints the ranks without the beast lists.
// A beast whose level range spans a rank boundary appears under both adjacent ranks.
function rankSectionsHtml(name, ranks, tames, showTames = true) {
  return ranks.map((rk, i) => {
    const next = ranks[i + 1]?.level || 0;
    const desc = resolveSpellText(rk.description, rk);
    let list = "";
    if (showTames) {
      const band = tames
        .filter((c) => (c.level_max || 0) >= rk.level && (next === 0 || (c.level_min || 0) < next))
        .sort((x, y) => (x.level_min || 0) - (y.level_min || 0) || x.name.localeCompare(y.name));
      list = band.length
        ? `<div class="muted pet-tame-lead">Learn by taming:</div><ul class="pet-tame-list">${band.map(petBullet).join("")}</ul>`
        : `<div class="muted">No tameable beast in the data falls in this rank's level band.</div>`;
    }
    return `<section class="pet-rank-sec">
      <h4><a class="pet-rank-title ilink spell" href="?spell=${rk.spell}" title="Spell details">${esc(name)}${rk.rank ? ` ${rk.rank}` : ""}</a>
        ${rk.level ? `<span class="muted">· Pet Level ${rk.level}</span>` : ""}
        ${desc ? `<span class="pet-rank-desc">— ${esc(desc)}</span>` : ""}</h4>
      ${list}
    </section>`;
  }).join("");
}

// ---- index: ?pets ----
export async function showPets() {
  document.title = "Hunter Pets - Tortoise-WoW DB";
  const app = appEl();
  app.innerHTML = `<div class="muted">Loading pet families…</div>`;
  const [families, abilities, members, allRanks, allTames] = await Promise.all([
    query(Q.Q_PET_FAMILIES),
    query(Q.Q_PET_ABILITIES),
    query(Q.Q_PET_ABILITY_MEMBERS),
    query(Q.Q_PET_ALL_ABILITY_RANKS),
    query(Q.Q_PET_ALL_TAMES),
  ]);
  const rankMapAll = groupRanks(allRanks);

  // Which families learn each ability, and each family's tameable beasts.
  const byAbil = new Map();
  for (const m of members) {
    if (!byAbil.has(m.ability_key)) byAbil.set(m.ability_key, []);
    byAbil.get(m.ability_key).push(m);
  }
  const tamesByFamily = new Map();
  for (const c of allTames) {
    if (!tamesByFamily.has(c.pet_family)) tamesByFamily.set(c.pet_family, []);
    tamesByFamily.get(c.pet_family).push(c);
  }
  // Only abilities a family can actually learn (drops orphan skill-261 entries like
  // "Avoidance" that no pet family gets). Active first, then passives; alphabetical.
  const abilSorted = abilities
    .filter((a) => (byAbil.get(a.key) || []).length > 0)
    .sort((a, b) => (a.active ? 0 : 1) - (b.active ? 0 : 1) || a.name.localeCompare(b.name));

  // One full section per ability (Petopia abilities.php on a single page): header +
  // description + which families learn it + a per-rank list of exactly which beasts to tame.
  const abilityBlock = (a) => {
    const fams = byAbil.get(a.key) || [];
    const ranks = rankMapAll.get(a.key) || [];
    const universal = fams.length >= UNIVERSAL_MIN;
    const tames = universal ? [] : fams.flatMap((f) => tamesByFamily.get(f.id) || []);
    return `<section class="pet-ability-block" id="ab-${esc(a.key)}">
      <div class="pet-ability-head">
        ${iconImg(a.icon || "inv_misc_questionmark", "pet-abil-block-icon")}
        <div class="pet-ability-headtext">
          <h3 class="pet-ability-name"><a class="ilink pet-ability-namelink" href="?petability=${esc(a.key)}" title="Open this ability on its own page">${esc(a.name)}</a>
            <span class="muted pet-ability-kind">${a.active ? "Active" : "Passive"} · ${ranks.length} rank${ranks.length === 1 ? "" : "s"}</span></h3>
          ${fams.length ? `<div class="muted pet-learnedby-inline">Learned by: ${fams.map((f) => petFamilyLink(f.id, f.name) + twTag(f.custom)).join(", ")}</div>` : ""}
          ${universal ? `<div class="muted pet-universal-note">Learned by taming <b>any</b> beast of these families — no specific pet needed; the rank scales with your pet's level.</div>` : ""}
        </div>
      </div>
      ${rankSectionsHtml(a.name, ranks, tames, !universal)}
    </section>`;
  };
  const toc = abilSorted.map((a) =>
    `<button class="pet-toc-link" data-target="ab-${esc(a.key)}">${iconImg(a.icon || "inv_misc_questionmark", "pet-toc-icon")}${esc(a.name)}</button>`).join("");

  app.innerHTML = `<div class="pet-index">
    <h1>Hunter Pets</h1>
    <p class="muted">Every tameable beast family in Turtle WoW — compare their stat focus, diet and abilities,
      then find exactly which beast to tame. <span class="tagx tw-tag">TW</span> marks Turtle-WoW-custom
      families and pets. Sort any column to compare.</p>
    <h2 class="pet-h">Family Comparison</h2>
    <p class="muted">Stat focus is the <b>classic pet-family reference</b> (multipliers vs a baseline pet, green
      above 1.0, red below). Turtle's 1.12 core actually scales all pets uniformly — family sets model size,
      diet and abilities — so treat these as role guidance. <span class="tagx tw-tag">TW</span> custom families
      use their closest classic analog. Click a family for abilities + where to tame; click a diet to browse foods.</p>
    <div id="pet-fam-compare"></div>
    <h2 class="pet-h" id="pet-abilities">Pet Abilities</h2>
    <p class="muted">A pet <b>learns an ability rank by taming a beast that already knows it</b> — a fresh pet
      comes with the highest rank its level allows. Every ability, every rank, and exactly which beasts to
      tame (with family, level and zone) are listed below. Jump to one:</p>
    <nav class="pet-toc">${toc}</nav>
    <div class="pet-ability-blocks">${abilSorted.map(abilityBlock).join("")}</div>
  </div>`;

  createTable(document.getElementById("pet-fam-compare"), {
    columns: [
      { key: "name", label: "Family", cell: (f) => `${iconImg(f.icon || "ability_hunter_beasttaming", "pet-fam-icon-sm")} ${petFamilyLink(f.id, f.name)}${twTag(f.custom)}`, value: (f) => f.name },
      { key: "role", label: "Role", cell: (f) => esc(f.role || "—"), value: (f) => f.role || "~", group: (f) => esc(f.role || "Unknown") },
      { key: "health", label: "Health", num: true, cell: (f) => statBarCell(f.mod_health), value: (f) => f.mod_health || 0 },
      { key: "armor", label: "Armor", num: true, cell: (f) => statBarCell(f.mod_armor), value: (f) => f.mod_armor || 0 },
      { key: "damage", label: "Damage", num: true, cell: (f) => statBarCell(f.mod_damage), value: (f) => f.mod_damage || 0 },
      { key: "diet", label: "Diet", cell: (f) => dietPills(f.diet, true), value: (f) => f.diet || "" },
      { key: "count", label: "Tameable", num: true, cls: "num", cell: (f) => String(f.npc_count), value: (f) => f.npc_count },
    ],
    rows: families,
    pageSize: 50,
    groupable: true,
    sort: "name",
  });

  // TOC -> smooth-scroll to the ability block (buttons, so no #hash routing conflict).
  for (const btn of app.querySelectorAll(".pet-toc-link")) {
    btn.addEventListener("click", () => document.getElementById(btn.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
}

// ---- one ability: ?petability=<key> (Petopia-style: each rank + who to tame for it) ----
export async function showPetAbility(key) {
  const app = appEl();
  app.innerHTML = `<div class="muted">Loading…</div>`;
  const a = await queryOne(Q.Q_PET_ABILITY, [key]);
  if (!a) { app.innerHTML = `<div class="empty">Unknown pet ability.</div>`; return; }
  document.title = `${a.name} — Pet Ability — Tortoise-WoW DB`;
  const [ranks, tames, members] = await Promise.all([
    query(Q.Q_PET_ABILITY_RANKS_ONE, [key]),
    query(Q.Q_PET_ABILITY_TAMES, [key]),
    query(Q.Q_PET_ABILITY_MEMBERS),
  ]);
  const fams = members.filter((m) => m.ability_key === key);
  const universal = fams.length >= UNIVERSAL_MIN;

  app.innerHTML = `<div class="pet-ability">
    <div class="pet-fam-header">
      ${iconImg(a.icon || "inv_misc_questionmark", "pet-fam-hero-icon")}
      <div>
        <h1>${esc(a.name)}</h1>
        <div class="pet-fam-sub muted">${a.active ? "Active" : "Passive"} pet ability · ${ranks.length} rank${ranks.length === 1 ? "" : "s"}</div>
      </div>
    </div>
    ${fams.length ? `<p class="muted pet-learnedby">Can be learned by: ${fams.map((f) => petFamilyLink(f.id, f.name) + twTag(f.custom)).join(", ")}</p>` : ""}
    ${universal ? `<p class="muted pet-universal-note">Learned by taming <b>any</b> beast of these families — no specific pet needed; the rank scales with your pet's level.</p>` : ""}
    <div class="pet-rank-secs">${rankSectionsHtml(a.name, ranks, universal ? [] : tames, !universal)}</div>
  </div>`;
}

// ---- detail: ?petfamily=<id> ----
export async function showPetFamily(id) {
  const app = appEl();
  app.innerHTML = `<div class="muted">Loading…</div>`;
  const fam = await queryOne(Q.Q_PET_FAMILY, [id]);
  if (!fam) { app.innerHTML = `<div class="empty">Unknown pet family.</div>`; return; }
  document.title = `${fam.name} — Hunter Pets — Tortoise-WoW DB`;
  const [abilities, npcs, ranks] = await Promise.all([
    query(Q.Q_PET_FAMILY_ABIL, [id]),
    query(Q.Q_PET_FAMILY_NPCS, [id]),
    query(Q.Q_PET_ABILITY_RANKS),
  ]);
  const rankMap = groupRanks(ranks);

  // One row per ability: icon + name (links max-rank spell) + a chip per rank showing
  // the pet level to tame for it -> answers "which pet gives Bite Rank 3" (level 16+).
  const abilRow = (a) => `<div class="pet-abil-row">
    ${abilityLink(a.key, a.name, a.icon || "inv_misc_questionmark")}
    <span class="pet-abil-ranks">${rankChips(rankMap.get(a.key) || [])}</span>
  </div>`;
  const active = abilities.filter((a) => a.active);
  const passive = abilities.filter((a) => !a.active);

  app.innerHTML = `<div class="pet-family">
    <div class="pet-fam-header">
      ${iconImg(fam.icon || "ability_hunter_beasttaming", "pet-fam-hero-icon")}
      <div>
        <h1>${esc(fam.name)}${twTag(fam.custom)}</h1>
        <div class="pet-fam-sub muted">
          ${fam.role ? `<span>${esc(fam.role)}</span> · ` : ""}
          <span>${fam.npc_count} tameable creature${fam.npc_count === 1 ? "" : "s"}</span>
          ${fam.diet ? ` · Diet:` : ""}
        </div>
        <div class="pet-diet">${dietPills(fam.diet, true)}</div>
      </div>
    </div>

    <section class="pet-panel">
      <h2>Trainable Abilities <a class="pet-compare-link nav" href="?pets" title="Compare stat focus across all families">compare families ›</a></h2>
      <p class="muted pet-note">Each rank chip shows the <b>pet level to tame for it</b> — a fresh pet comes with
        the highest rank its level allows. Tame a ${esc(fam.name)} of that level (see “Where to Tame” below)
        to get the rank. Hover a chip for details; click for the spell.</p>
      ${active.length ? `<div class="pet-abil-group"><h3>Active</h3><div class="pet-abil-rows">${active.map(abilRow).join("")}</div></div>` : ""}
      ${passive.length ? `<div class="pet-abil-group"><h3>Passive</h3><div class="pet-abil-rows">${passive.map(abilRow).join("")}</div></div>` : ""}
    </section>

    <section class="pet-panel">
      <h2>Where to Tame <span class="muted">(${npcs.length})</span></h2>
      <div id="pet-npc-table"></div>
    </section>
  </div>`;

  createTable(document.getElementById("pet-npc-table"), {
    columns: [
      { key: "name", label: "Creature", cell: (r) => npcLink(r.entry, r.name) + (r.subname ? ` <span class="muted">&lt;${esc(r.subname)}&gt;</span>` : "") + twTag(r.custom), value: (r) => r.name },
      { key: "level", label: "Level", num: true, cls: "num", cell: (r) => lvlRange(r), value: (r) => r.level_min || 0 },
      { key: "rank", label: "Rank", cell: (r) => CREATURE_RANK[r.rank] || "", value: (r) => r.rank || 0 },
      { key: "zone", label: "Zone", cell: (r) => (r.zone ? zoneLink(r.areaid, r.zone) : `<span class="muted">—</span>`), value: (r) => r.zone || "", group: (r) => (r.zone ? esc(r.zone) : "Unknown") },
    ],
    rows: npcs,
    pageSize: 50,
    groupable: true,
    sort: "level",
  });
}
