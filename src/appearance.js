/**
 * The character-creator pickers: race and gender portraits, skin and hair-colour
 * swatches, and the per-race steppers for face, hair and whatever that race calls its
 * facial variation.
 *
 * Its own module because THREE pages ask the same question -- the dressing room, an item
 * set's preview, and an item's 3D tab -- and every rule in here is a race-specific reading
 * of the client's own data (which axes split, what a race calls them, which values exist
 * at all). A second copy would drift the moment one of them grew an option, the same
 * reason src/selbar.js exists.
 *
 * The picker owns the CONTROLS and the state object; it does not know what to do when
 * something changes, which is the caller's business (the room re-mounts and rewrites the
 * URL; a set page re-mounts and keeps its own query).
 */
import CHAR_PALETTE from "../scripts/data/char-palette.json";
import RACE_LABELS from "../scripts/data/race-labels.json";
import { ASSETS_BASE } from "./config.js";
import { esc } from "./render.js";

export const KEY = { hcolor: "hairColor", facial: "facialHair", paint: "facePaint" };

/** URL params -> an appearance, falling back to `base` (a remembered look, or human male
 *  when there is nothing to remember). */
export function readAppearance(params, base = {}) {
  const num = (k, d) => (params.get(k) !== null && params.get(k) !== "" ? Number(params.get(k)) : d);
  const sex = params.get("sex") === "f" ? "f" : params.get("sex") === "m" ? "m" : (base.sex || "m");
  return {
    race: num("race", base.race ?? 1), sex,
    skin: num("skin", base.skin ?? 0), face: num("face", base.face ?? 0),
    hair: num("hair", base.hair ?? 0), hairColor: num("hcolor", base.hairColor ?? 0),
    facialHair: num("facial", base.facialHair ?? 0),
    // Absent from a link the paint FOLLOWS the facial index, which is what the single
    // coupled stepper used to do -- so every URL written before the split still renders
    // the character it described.
    facePaint: params.get("paint") !== null
      ? num("paint", 0) : num("facial", base.facePaint ?? base.facialHair ?? 0),
  };
}

/** The same appearance as plain query params, so every page spells it identically. */
export const appearanceParams = (state) => ({
  race: state.race, sex: state.sex, skin: state.skin, face: state.face,
  hair: state.hair, hcolor: state.hairColor, facial: state.facialHair, paint: state.facePaint,
});

// Whoever the visitor last built in the dressing room. A set or an item is then previewed
// on THEIR character rather than on a stock human male, which is the question they were
// asking of the preview in the first place.
const REMEMBER = "tw-appearance";
export function rememberAppearance(state) {
  try { localStorage.setItem(REMEMBER, JSON.stringify(appearanceParams(state))); } catch { /* private mode */ }
}
export function recallAppearance() {
  try {
    const raw = JSON.parse(localStorage.getItem(REMEMBER) || "null");
    if (!raw || typeof raw !== "object") return null;
    return readAppearance(new URLSearchParams(Object.entries(raw).map(([k, v]) => [k, String(v)])));
  } catch { return null; }
}

/**
 * Mount the pickers into `el`, driving `state`. `onChange(key, value)` is awaited after
 * every change, once the controls have already repainted.
 */
export function appearancePicker({ data, state, el, onChange = () => {} }) {
  // Sampled colours for the skin/hair swatches (scripts/build-char-palette.py). Bundled
  // rather than fetched with the rest of the appearance data: it is 4 KB and the picker
  // needs it on first paint.
  const palette = (key) => CHAR_PALETTE[key] || null;

  // How many variations/colours this race+gender actually offers. Asked of the data
  // rather than assumed: Turtle's own races do not carry the same counts as Blizzard's.
  const opts = (kind, idx) => {
    const rows = data.sections[`${state.race}-${state.sex}-${kind}`] || [];
    return [...new Set(rows.map((r) => r[idx]))].sort((a, b) => a - b);
  };
  // Hair and facial-hair VARIATIONS come from the geoset tables, not from the texture
  // sections: a variation can exist as geometry while painting no texture at all (every
  // race's bald, and all five of the goblin's facial options), and offering only the
  // textured ones hides real choices -- while offering ones the race lacks used to leave
  // it headless.
  const geosetOpts = (table) =>
    [...new Set((data[table][`${state.race}-${state.sex}`] || []).map((r) => r[0]))].sort((a, b) => a - b);

  // Shape and paint are TWO CHOICES on some races and one on others, and the data says
  // which. A troll's fourteen "tusk" variations resolve to five tusk shapes and nine war
  // paints, and the game lets you pick one of each; a human's nine beards are nine
  // beards -- shape and texture travel together and splitting them would offer 54
  // combinations the game does not have.
  //
  // The test is the collapse: split when the distinct geoset sets number two thirds of
  // the variations or fewer. Measured, that is trolls, undead and night elf females
  // (ratios 0.36, 0.25, 0.10) but not orc males (0.91) or human males (0.67), which
  // matches what those races' creators actually offer.
  const SPLIT_RATIO = 0.65;
  const facialAxes = () => {
    const rows = data.facial[`${state.race}-${state.sex}`] || [];
    const byGeoset = new Map();               // geoset signature -> its lowest variation
    for (const r of [...rows].sort((a, b) => a[0] - b[0])) {
      const key = r.slice(1).join(",");
      if (!byGeoset.has(key)) byGeoset.set(key, r[0]);
    }
    const painted = [...new Set((data.sections[`${state.race}-${state.sex}-facial`] || [])
      .filter((r) => r[2].length).map((r) => r[0]))].sort((a, b) => a - b);
    const bare = rows.map((r) => r[0]).filter((v) => !painted.includes(v)).sort((a, b) => a - b);
    const split = rows.length > 1 && byGeoset.size <= rows.length * SPLIT_RATIO
      && painted.length > 0 && bare.length > 0;
    return {
      split,
      shapes: [...byGeoset.values()].sort((a, b) => a - b),
      // "no paint" is a real choice, and it is whichever variation carries no texture.
      paints: [bare[0], ...painted],
    };
  };
  // The pickers are the character creator's, not a form's. Every option that HAS a
  // preview shows it -- a race is its portrait, a skin or hair colour is that colour --
  // and only the ones that cannot be previewed in a swatch (face, hairstyle, markings)
  // stay as a stepper, which is still one click per change rather than three.
  const RACE_ICON = (id, sex) => `${ASSETS_BASE}icons/race/${id}-${sex}.webp`;
  const swatch = (label, key, values, cur, colours) => {
    if (values.length < 2) return "";
    const cells = values.map((v) => {
      const c = colours && colours[v];
      // No sampled colour (a race whose art the client does not ship) degrades to the
      // number rather than to an empty circle that looks broken. One class attribute,
      // not two -- a second is silently dropped, which left the fallback unstyled.
      const face = c ? ` style="background:${c}"` : "";
      return `<button type="button" class="sw${c ? "" : " sw-num"}" data-key="${key}" data-val="${v}"${face}`
        + ` aria-pressed="${v === cur}" title="${esc(label)} ${v}">${c ? "" : v}</button>`;
    }).join("");
    return field(label, `${values.indexOf(cur) + 1} / ${values.length}`,
      `<div class="swatches">${cells}</div>`, key);
  };
  const stepper = (label, key, values, cur) => {
    if (values.length < 2) return "";
    const at = Math.max(0, values.indexOf(cur));
    return `<div class="stepper" data-key="${key}">`
      + `<button type="button" data-step="-1" aria-label="Previous ${esc(label)}">\u2039</button>`
      + `<span class="val">${esc(label)} ${at + 1} / ${values.length}</span>`
      + `<button type="button" data-step="1" aria-label="Next ${esc(label)}">\u203a</button></div>`;
  };
  // Every field names itself. The module renders the CONTROLS; where they sit is the
  // page's business -- the room stacks them down a rail, a set page flanks the model with
  // them -- and a `data-field` hook is all that takes.
  const field = (label, note, body, key = "") =>
    `<div class="dfield" data-field="${key}"><div class="dfield-lbl"><span>${esc(label)}</span>`
    + `<span class="dim">${esc(note)}</span></div>${body}</div>`;

  const render = () => {
    const raceName = data.races.find((r) => r.id === state.race)?.name || "";
    const lab = RACE_LABELS[state.race] || {};
    const axes = facialAxes();
    // With the shape split off, the race's own word names the SHAPE (a troll's "Tusks");
    // where a race has only one shape -- a night elf female has exactly one -- the shape
    // stepper hides itself and the word belongs to the paint, which is what "Markings"
    // means there.
    const labels = {
      hair: lab.hair || "Hair",
      facial: lab[state.sex] || "Facial hair",
    };
    if (axes.split && axes.shapes.length < 2) labels.paint = labels.facial;
    // Gender leads the same row as the races, because it IS one of the choices the row
    // is making -- and because the portraits are per gender, so the two controls are
    // reading the same picture.
    const sexTile = (val, label, glyph) =>
      `<button type="button" class="race-tile sex-tile" data-key="sex" data-val="${val}"`
      + ` aria-pressed="${state.sex === val}" title="${label}">`
      + `<i>${glyph}</i><span>${label}</span></button>`;
    const tiles = data.races.map((r) =>
      `<button type="button" class="race-tile" data-key="race" data-val="${r.id}"`
      + ` aria-pressed="${r.id === state.race}" title="${esc(r.name)}">`
      + `<img src="${RACE_ICON(r.id, state.sex)}" alt="" loading="lazy" width="38" height="38">`
      + `<span>${esc(r.name)}</span></button>`).join("");
    el.innerHTML =
      field("Race", raceName,
        `<div class="race-row">${sexTile("m", "Male", "\u2642")}${sexTile("f", "Female", "\u2640")}`
        + `<span class="race-sep"></span>${tiles}</div>`, "race")
      + swatch("Skin", "skin", opts("skin", 1), state.skin, palette(`${state.race}-${state.sex}-skin`))
      + swatch("Hair colour", "hcolor", opts("hair", 1), state.hairColor,
        palette(`${state.race}-${state.sex}-hair`))
      + field("Face & hair", "",
        `<div class="steps">`
        + stepper("Face", "face", opts("face", 0), state.face)
        + stepper(labels.hair, "hair", geosetOpts("hair"), state.hair)
        // What this option is CALLED is per race, and the client says so: ChrRaces names a
        // token per race and gender and the glue strings give it text. A troll's option is
        // Tusks, an undead's is Features, a tauren's hair slider is Horns. Calling them all
        // "Facial hair" sends people looking for a beard slider that does not exist -- and
        // the guess it replaces ("Face detail" when a race had no facial textures) was
        // right about goblins by accident and wrong about trolls.
        + (axes.split
          ? stepper(labels.facial, "facial", axes.shapes, state.facialHair)
            + stepper(labels.paint || "Paint", "paint", axes.paints, state.facePaint)
          : stepper(labels.facial, "facial", geosetOpts("facial"), state.facialHair))
        + `</div>`, "steps");
  };

  const clamp = () => {
    const fit = (vals, cur) => (vals.includes(cur) ? cur : (vals[0] ?? 0));
    state.skin = fit(opts("skin", 1), state.skin);
    state.face = fit(opts("face", 0), state.face);
    state.hairColor = fit(opts("hair", 1), state.hairColor);
    state.hair = fit(geosetOpts("hair"), state.hair);
    const ax = facialAxes();
    state.facialHair = fit(ax.split ? ax.shapes : geosetOpts("facial"), state.facialHair);
    // Where the race does NOT split the two, the paint IS the shape. Clamping them apart
    // let them drift, and both ride in the URL, so a link written after the drift pinned
    // the texture while the geoset kept moving.
    state.facePaint = ax.split ? fit(ax.paints, state.facePaint) : state.facialHair;
  };

  const set = async (key, value) => {
    state[KEY[key] || key] = value;
    // A gnome has fewer skins than a tauren, so carrying an out-of-range index across a
    // race change renders a character with no head.
    if (key === "race" || key === "sex") clamp();
    // ONE stepper, TWO params. On a race whose shape and paint are a single choice the
    // picker moves only `facial` -- but `appearanceParams` writes `paint` regardless, so
    // leaving it behind pinned the TEXTURE at whatever it last was while the geoset went
    // on changing. That is nine human male beards rendering as two (bare chin, sideburns),
    // and it survived every reload because the stale pair was in the URL and in storage.
    else if (key === "facial" && !facialAxes().split) state.facePaint = value;
    render();
    await onChange(key, value);
  };

  const onPick = async (e) => {
    const step = e.target.closest(".stepper button");
    if (step) {
      // Steppers wrap. Reaching the end of eleven hairstyles and having to click back
      // through all of them is the kind of thing a dropdown was at least honest about.
      const box = step.closest(".stepper");
      const key = box.dataset.key;
      const ax = facialAxes();
      const vals = key === "paint" ? ax.paints
        : key === "facial" ? (ax.split ? ax.shapes : geosetOpts("facial"))
          : key === "hair" ? geosetOpts("hair")
            : opts(key === "hcolor" ? "hair" : key, key === "face" ? 0 : 1);
      const at = Math.max(0, vals.indexOf(state[KEY[key] || key]));
      const next = vals[(at + Number(step.dataset.step) + vals.length) % vals.length];
      await set(key, next);
      return;
    }
    const btn = e.target.closest("[data-key][data-val]");
    if (!btn) return;
    const key = btn.dataset.key;
    await set(key, key === "sex" ? btn.dataset.val : Number(btn.dataset.val));
  };
  // Three hosts, one handler: the strips are part of the same picker, they just sit
  // beside the model instead of above it.

  el.addEventListener("click", onPick);
  // `opts`/`geosetOpts`/`facialAxes` are exposed because rolling a random look needs the
  // same answers the pickers give, and asking the data twice in two places is how the two
  // come to disagree.
  return { render, clamp, state, opts, geosetOpts, facialAxes };
}
