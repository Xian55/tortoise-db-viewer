// Wearing armor: the rules that turn an item_appearance row into layers on the character
// body atlas and geosets on the character model. No three.js and no DOM, so both the
// viewer and a test can use it, and the rules can be read in one place.
//
// Most gear is ONLY this. Of 10,204 item displays, 5,362 carry no model whatsoever --
// a chestpiece is eight rectangles of texture and a couple of geoset switches.

// item.inventory_type -> the geoset GROUP each of ItemDisplayInfo's three geoset values
// addresses. Derived by cross-tabbing item_appearance against the groups the character
// models actually contain: a chest writes sleeves/chest/robe, legs write kneepads/pants/
// robe, and a cloak writes the cape group -- whose values 1..5 line up exactly with the
// 1502..1506 variants every model carries.
export const SLOT_GEOSET_GROUPS = {
  4: [8, 10, 13],    // Shirt
  5: [8, 10, 13],    // Chest
  7: [9, 11, 13],    // Legs
  8: [5, null, null], // Feet
  10: [4, null, 13],  // Hands
  16: [15, null, null], // Back (cloak)
  19: [12, null, null], // Tabard
  20: [8, 10, 13],   // Robe
};

// The value is an OFFSET FROM THE BARE VARIANT, not a variant number: 0 means "leave the
// body as it is". Robe of the Archmage settles it -- its third value is 1 and a robe must
// show geoset 1302 (the skirt), because 1301 is the bare leg. Likewise a glove's 1 is
// 402, since 401 is the bare hand.
export const geosetFor = (group, value) => (value ? group * 100 + value + 1 : 0);

// Which region of the atlas each item_appearance component column paints.
// WHICH REGIONS EACH SLOT PAINTS. ItemDisplayInfo hands out eight component textures per
// row and a tier piece routinely carries the whole SET's pack: Dreadnaught Gauntlets name
// all eight, Sabatons six, and the Helmet names a chest and a trouser texture. Painting
// every one of them re-skinned the character's torso and legs the moment a helmet or a
// glove went on. The client reads only the regions that belong to the slot.
//
// Derived from the data rather than recalled -- share of rows setting each column, over
// every non-hidden item of that slot. Each slot has a dominant set at 88-100% and noise at
// 3-8%, and the cut is unambiguous:
//
//   shirt   arm_u 80  arm_l 63  torso_u 99  torso_l 98
//   chest   arm_u 78  arm_l 28  torso_u 99  torso_l 98   (leg 19% = the robes among them)
//   waist   leg_u 98                                     (a belt paints the hip, not the torso)
//   legs    leg_u 98  leg_l 94
//   feet    leg_l 91  foot 98
//   wrist   arm_l 98
//   hands   arm_l 88  hand 98
//   tabard  torso_u 94  torso_l 94
//   robe    arm_u 89  arm_l 60  torso_u 99  torso_l 97  leg_u 100  leg_l 99
const SLOT_REGIONS = {
  4: ["arm_u", "arm_l", "torso_u", "torso_l"],
  5: ["arm_u", "arm_l", "torso_u", "torso_l"],
  6: ["leg_u"],
  7: ["leg_u", "leg_l"],
  8: ["leg_l", "foot"],
  9: ["arm_l"],
  10: ["arm_l", "hand"],
  19: ["torso_u", "torso_l"],
  20: ["arm_u", "arm_l", "torso_u", "torso_l", "leg_u", "leg_l"],
};

/** The [column, region] pairs this item may paint. Empty for anything that is a model, is
 *  held, or is the cape -- none of those touch the skin atlas. */
export function componentLayers(it) {
  // A robe is filed as a plain chest (inv 5) and its skirt is the reason the leg regions
  // are in play at all, so it takes the robe list rather than the chest one.
  const allow = SLOT_REGIONS[isRobe(it) ? 20 : it.inv];
  if (!allow) return [];
  return COMPONENT_REGIONS.filter(([, region]) => allow.includes(region));
}

export const COMPONENT_REGIONS = [
  ["t_arm_u", "arm_u"], ["t_arm_l", "arm_l"], ["t_hand", "hand"],
  ["t_torso_u", "torso_u"], ["t_torso_l", "torso_l"],
  ["t_leg_u", "leg_u"], ["t_leg_l", "leg_l"], ["t_foot", "foot"],
];

// Paint order, bottom first. Only the overlaps matter, and they are the ones everyone
// knows from wearing the gear: a glove covers the bracer under it, a boot covers the
// trouser leg, a belt sits over both shirt and trousers, and a tabard goes over the
// chest. Anything not listed lands last.
const LAYER_ORDER = [4 /* shirt */, 5, 20 /* chest, robe */, 9 /* wrist */, 7 /* legs */,
  8 /* feet */, 6 /* waist */, 10 /* hands */, 19 /* tabard */, 16 /* back */];

export const layerRank = (inv) => {
  const i = LAYER_ORDER.indexOf(inv);
  return i === -1 ? LAYER_ORDER.length : i;
};

/** A chest piece that is really a ROBE: it addresses the robe geoset group (13), which is
 *  what turns the legs into a skirt. Inventory type does not say so -- most robes are
 *  filed as plain chest (inv 5), and it is the geoset that gives them away. */
export const isRobe = (it) =>
  (it.inv === 20 || it.inv === 5 || it.inv === 4)
  && (SLOT_GEOSET_GROUPS[it.inv] || []).some((g, i) => g === 13 && [it.geo1, it.geo2, it.geo3][i]);

/** Equipped items sorted into paint order. `items` are rows from qDressItemsIn.
 *
 *  A robe paints AFTER the legs. Its skirt covers them -- that is the whole point of the
 *  robe geoset -- so leaving it in the chest's usual slot let a pair of trousers paint
 *  over the skirt the robe had just drawn, and the legs won. It still goes UNDER the belt
 *  and the boots, which is where those sit on a robe in game. */
export const inPaintOrder = (items) => {
  const rank = (it) => (isRobe(it) ? layerRank(7) + 0.5 : layerRank(it.inv));
  return [...items].sort((a, b) => rank(a) - rank(b));
};

/**
 * The geosets an outfit turns on, applied over the naked set.
 * Returns a NEW Set: for each group an item addresses, its own variant replaces whatever
 * the bare body had there (a glove replaces the bare hand rather than drawing over it).
 * `present` is the set of geoset ids the model actually contains -- a race that lacks a
 * variant simply keeps its bare one instead of vanishing.
 */
export function applyGear(baseSet, items, present) {
  const out = new Set(baseSet);
  for (const it of inPaintOrder(items)) {
    const groups = SLOT_GEOSET_GROUPS[it.inv];
    if (!groups) continue;
    [it.geo1, it.geo2, it.geo3].forEach((value, i) => {
      const group = groups[i];
      if (!group || !value) return;
      const want = geosetFor(group, value);
      if (!present.has(want)) return;            // this race has no such variant
      for (const g of [...out]) if (Math.floor(g / 100) === group) out.delete(g);
      out.add(want);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Attached models: helms, shoulders, and what is held in the hands.
// ---------------------------------------------------------------------------

// Attachment ids, read off a posed body rather than recited (see src/m2b.js ATTACH).
// A shoulder is TWO models -- `L<name>` and `R<name>` -- hung on the mirrored pair.
// [attachment id, which of the item's two models]. A shoulder is a PAIR and the DBC
// names both: ModelName[0] is the left piece, ModelName[1] the right. (Guessing an L/R
// prefix instead is wrong twice over -- those names already start with L/R, so it built
// `LLShoulder_...` and hung nothing at all.)
export const SLOT_ATTACH = {
  1: [[11, "l"]],                   // Head -> head
  3: [[6, "l"], [5, "r"]],          // Shoulder -> left + right, one model each
};

// Held items. WHICH HAND is a property of the SLOT, not of the item: a one-hander
// (inv 13) is a main hand or an off hand depending on where you put it, and reading the
// item alone puts a dual-wielder's second sword in the hand that already holds the first.
// So the slot decides when the caller knows it, and the inventory type is the fallback
// for the pages that only know what is worn (the character sheet).
//
// Attachment ids were measured off a posed body, not recited: on a 2.13-unit human male,
// 1 and 2 are a mirrored pair at 42% of height on the -Y / +Y side (hands at rest), 0
// sits further out at 47% on the +Y arm (a shield is strapped to the forearm, not
// gripped), and 12 is 0.19 behind the spine at 76% (the back).
export const HAND_BY_SLOT = { mainhand: 1, offhand: 2, ranged: 2 };

// Inventory type -> the dressing room's URL parameter for it. Lives here rather than in
// the room itself because the item page needs the same answer to link INTO the room, and
// two copies would drift the first time a slot moved. Anything absent (rings, trinkets,
// relics, non-equippable) changes nothing about how a character looks.
export const DRESS_SLOT = {
  1: "head", 3: "shoulder", 4: "shirt", 5: "chest", 6: "waist", 7: "legs", 8: "feet",
  9: "wrist", 10: "hands", 16: "back", 19: "tabard", 20: "chest",
  13: "mainhand", 17: "mainhand", 21: "mainhand",
  14: "offhand", 22: "offhand", 23: "offhand",
  15: "ranged", 25: "ranged", 26: "ranged", 28: "ranged",
};
export const HAND_BY_INV = {
  13: 1, 17: 1, 21: 1, 25: 1,       // one-hand, two-hand, main hand, thrown -> right hand
  22: 2, 23: 2, 15: 2, 26: 2,       // off hand, held in off hand, bow, gun -> left hand
  14: 0,                            // shield -> the forearm point
};
// Inv 28 (relic -- idol, libram, totem) is deliberately absent: it occupies the ranged
// slot but a relic is never drawn on the character in game either.
const SHIELD = 14;


// A weapon is posed by the hand bone's own rotation, which the .m2b bakes alongside the
// attachment position (format v2), and by NOTHING else -- the client applies no
// correction on top of the bone either. It reads as the weapon held out from the fist
// rather than hanging at the side, because the pose is Stand frame 0 and a vanilla bind
// pose is already arms-down, so the hand bone barely rotates. That is what the data says
// the weapon looks like on this frame; an invented rotation to make it hang would be a
// guess dressed up as a pose. The sheath rules in items.sheath are likewise NOT applied:
// a standing character wears its weapons, but a dressing room exists to show them.
function heldAttach(it) {
  if (it.inv === SHIELD) return 0;
  const bySlot = it.slot ? HAND_BY_SLOT[it.slot] : undefined;
  return bySlot !== undefined ? bySlot : HAND_BY_INV[it.inv];
}

// ChrRaces id -> the client's model-name code. A helm is modelled once per race AND
// gender, so `Helm_Mail_D_01` alone is never a file: `Helm_Mail_D_01_HuM` is.
export const RACE_CODE = {
  1: "hu", 2: "or", 3: "dw", 4: "ni", 5: "sc", 6: "ta", 7: "gn", 8: "tr", 9: "go", 10: "be",
};

// What a helmet HIDES. The client keeps this in HelmetGeosetVisData: one row per helm
// style, five bitmasks -- hair, the three facial groups, ears -- and a set bit means "this
// geoset is covered, do not draw it". Without it a hood renders with the character's hair
// sticking straight through the cloth.
//
// The bit index is the GEOSET NUMBER within its group, not the picker's variation index:
// a human female's hairstyle 0 is geoset 2, and row 306 (this helm, female) has bit 2 set
// while bit 0 is clear. Indexing by the variation would leave exactly the wrong hair on.
const HELM_VIS_GROUPS = [0, 1, 2, 3, 7];      // hair, facial 1-3, ears
const EAR_BARE = 701;                          // the earless head, drawn when ears are hidden

/** Geosets to drop for the worn helm, plus any that replace them.
 *
 *  `bearded` is the set of group 1-3 geosets that are really FACIAL HAIR -- the ones whose
 *  variation paints a texture. The groups are not facial hair everywhere: Turtle reuses
 *  them for head SHAPES on goblins (a goblin female's head is geoset 103) and for a troll's
 *  tusks, so obeying a helm's beard mask deleted her face and left the hair and the mask
 *  floating over nothing. A geoset with no art behind it is part of the head and stays.
 *  Hair and ears are masked for everyone. */
/** Geosets in the "facial hair" groups that are actually the character's HEAD, and which
 *  a helm's beard mask must therefore never remove.
 *
 *  Turtle reuses groups 1-3 for head SHAPES on goblins, and a goblin's head shape paints a
 *  texture exactly like a beard does -- so the art-backed test that separates a goblin
 *  female's blank 103 from a goblin male's moustache says "hideable" here, and equipping a
 *  hood deleted his entire face, ears and all.
 *
 *  The test that does separate them is SIZE, measured against the body's own head rather
 *  than against a constant: a beard is a patch on a head the body already has, while a
 *  goblin's "facial" geoset IS the head, so it outweighs whatever geometry the naked body
 *  carries up there. Measured over all 20 character models, the biggest facial geoset comes
 *  to 0.14-0.65x the body's head-region vertices on every race with real facial hair
 *  (human male beards 0.14, dwarf 0.28, human female piercings 0.65) and 3.3x / 7.0x on
 *  goblin males and females. Nothing sits between. */
export function structuralGeosets(model) {
  const group = (g) => Math.floor(g / 100);
  const { idx, pos, submeshes } = model;
  const vertsOf = (s) => {
    const set = new Set();
    for (let i = s.first; i < s.first + s.count; i++) set.add(idx[i]);
    return set;
  };
  const facial = submeshes.filter((s) => group(s.geoset) >= 1 && group(s.geoset) <= 3);
  if (!facial.length) return new Set();
  // Model space is Z-up (the viewer swaps to Y-up only when it builds the scene).
  let lowest = Infinity;
  const verts = new Map();
  for (const s of facial) {
    const vs = vertsOf(s);
    verts.set(s, vs);
    for (const v of vs) lowest = Math.min(lowest, pos[v * 3 + 2]);
  }
  const seen = new Set();
  let head = 0;                          // the naked body's own vertices up at face height
  for (const s of submeshes) {
    if (s.geoset !== 0) continue;
    for (const v of vertsOf(s)) {
      if (seen.has(v)) continue;
      seen.add(v);
      if (pos[v * 3 + 2] >= lowest) head++;
    }
  }
  const out = new Set();
  for (const [s, vs] of verts) if (vs.size > head) out.add(s.geoset);
  return out;
}

export function helmetHidden(head, sex, helmVis, geosets, bearded = null) {
  const id = head && (sex === "f" ? head.helm_f : head.helm_m);
  const masks = id ? helmVis?.[id] : null;
  if (!masks) return geosets;
  const out = new Set(geosets);
  for (const g of geosets) {
    // Geoset 0 is the BODY, not a hair variant -- it only shares group 0 with them. The
    // hair mask has bit 0 set on most full helms, so treating it as one deleted the whole
    // character and left a helmet floating over an empty stage.
    if (g === 0) continue;
    const group = Math.floor(g / 100);
    const at = HELM_VIS_GROUPS.indexOf(group);
    if (at < 0) continue;
    if (bearded && group >= 1 && group <= 3 && !bearded.has(g)) continue;
    const variant = group === 0 ? g : g % 100;
    if (!(masks[at] & (1 << variant))) continue;
    out.delete(g);
    // An open scalp is a hole in the head, so hair gives way to the bald cap and an ear
    // geoset to the earless head -- which is what 701 exists for.
    if (group === 0) out.add(1);
    if (group === 7) out.add(EAR_BARE);
  }
  return out;
}

/**
 * The model files an outfit needs hung off the skeleton.
 * Returns [{ model, texture, attach, item }] -- `model` is the .m2b basename.
 */
export function attachedModels(items, { race, sex }) {
  const code = `${RACE_CODE[race] || "hu"}${sex === "f" ? "f" : "m"}`;
  const out = [];
  for (const it of items) {
    // Same stale-model trap as the item page: a glove or a boot can name a shoulder in
    // ModelName, and only the slots that actually attach a model may read that field.
    const held = heldAttach(it);
    if (held !== undefined && it.model_l) {
      out.push({ model: it.model_l, texture: it.tex_l, attach: held, item: it.entry,
        inv: it.inv });
      continue;
    }
    const points = SLOT_ATTACH[it.inv];
    if (!points) continue;
    for (const [attach, which] of points) {
      const name = which === "r" ? it.model_r : it.model_l;
      if (!name) continue;
      // Per-race models exist ONLY as <name>_<racecode>; everything else is the name
      // exactly as the DBC gives it.
      const base = it.per_race ? `${name}_${code}` : name;
      out.push({ model: base, texture: (which === "r" ? it.tex_r : it.tex_l) || it.tex_l,
        attach, item: it.entry, inv: it.inv });
    }
  }
  return out;
}
