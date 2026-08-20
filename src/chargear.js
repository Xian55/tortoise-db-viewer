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

/** Equipped items sorted into paint order. `items` are rows from qDressItemsIn. */
export const inPaintOrder = (items) =>
  [...items].sort((a, b) => layerRank(a.inv) - layerRank(b.inv));

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
