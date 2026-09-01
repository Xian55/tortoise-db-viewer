import { page, nav, T, smoke } from "../harness.mjs";
import { afterRemount, viewerIdle } from "./_shared.mjs";

// The DRESSED character: what a helm hides, which slot a piece lands in, how a set and a
// hover preview look worn -- and how the result moves (idle animation, the turntable, the
// frame budget, the meshes the client keeps hidden).
//
// Split out of model3d.test.mjs, which had grown to 46 tests / ~47s and WAS the smoke
// suite's wall floor: the runner shards by file, so one file longer than the ideal shard
// caps the whole suite however well the rest is balanced. Two files of ~23s each sit right
// at that ideal. The name keeps the `model3d` prefix on purpose -- run.mjs filters on a
// substring of the basename, so `bun run smoke -- model3d` still runs both halves.

// A helm hides what it covers. The client keeps that in HelmetGeosetVisData -- five
// bitmasks per helm style (hair, the three facial groups, ears) where a set bit means
// "covered, do not draw" -- and without it a hood renders with the hair through the cloth.
// Two things this pins: the bit index is the GEOSET number, not the picker's variation,
// and geoset 0 is the BODY, which shares group 0 with the hair and must never be hidden
// (the mask has bit 0 set on most full helms; obeying it deleted the whole character).
async function testHelmetHides() {
  const at = async (url) => {
    await nav(url);
    await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
    return page.evaluate(() => window.__mv().geosets);
  };
  const bare = await at("?dressing&race=1&sex=m&hair=3&facial=4");
  const helmed = await at("?dressing&race=1&sex=m&hair=3&facial=4&head=1024");   // hides hair + facial
  const headband = await at("?dressing&race=1&sex=f&hair=5&head=1");             // hides nothing
  const g = (list, group) => list.filter((x) => Math.floor(x / 100) === group);
  console.log(`helmvis: bare=[${bare}] helmed=[${helmed}] headband=[${headband}]`);
  return bare.includes(0) && helmed.includes(0)              // the body survives
    && g(bare, 1).length > 0 && g(helmed, 1).length === 0     // facial hair covered
    && bare.includes(4) && !helmed.includes(4)                // the hairstyle covered
    && helmed.includes(701) && !helmed.includes(702)          // ears give way to the bare head
    && headband.includes(7) && headband.includes(702);        // and a headband covers nothing
}

smoke("a helm hides the hair and beard it covers", () => testHelmetHides());

// ...but only what is actually facial HAIR. Groups 1-3 are not facial hair on every race:
// Turtle reuses them for head SHAPES on goblins, so obeying a helm's beard mask deleted a
// goblin's face and left the hair and mask floating over nothing.
//
// Art was the first discriminator tried -- hide it only where the variation paints a
// texture -- and it is wrong: a goblin MALE's head shape paints a texture exactly as a
// beard does, so his face was still being deleted (geosets 102-106 are all head shapes,
// not the moustache they were taken for). SIZE is what separates them, measured against
// the body's own head rather than a constant: a beard is a patch on a head the body
// already has, so it comes to 0.14-0.65x the head-region vertices on every race with real
// facial hair, while a goblin's IS the head at 3.3x / 7.0x. His group-3 piece (302, 44
// verts) is genuinely small and stays hideable, which is what keeps this from being
// "never hide anything".
async function testHelmetKeepsHeads() {
  const at = async (url) => {
    await nav(url);
    await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
    return page.evaluate(() => window.__mv().geosets);
  };
  const fHelm = await at("?dressing&race=9&sex=f&face=5&hair=3&facial=1&head=81007");
  // variation 5 gives him a head shape (102) AND a small group-3 feature (302)
  const mBare = await at("?dressing&race=9&sex=m&hair=2&facial=5");
  const mHelm = await at("?dressing&race=9&sex=m&hair=2&facial=5&head=1024");
  const hum = await at("?dressing&race=1&sex=m&hair=3&facial=4&head=1024");
  console.log(`goblin: f -> ${fHelm} | m ${mBare} -> ${mHelm} | human -> ${hum}`);
  return fHelm.includes(103)                                 // her head survives the mask
    && mBare.includes(102) && mHelm.includes(102)            // and so does his
    && mBare.includes(302) && !mHelm.includes(302)           // his small feature does not
    && hum.filter((g) => g >= 100 && g < 400).length === 0;   // nor a human's beard
}

smoke("a helm covers a goblin's moustache but not her head", () => testHelmetKeepsHeads());

// A weapon goes in the slot you opened the picker for, not the one its inventory type
// implies. A one-hander is inv 13, which maps to the main hand, so choosing a second Cruel
// Barb in the OFF-hand picker re-equipped the hand that already held one -- dual-wielding
// was impossible through the UI, while the same pair set straight from a URL worked fine.
async function testEquipIntoTheOpenSlot() {
  await nav("?dressing&race=2&sex=f&mainhand=5191");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  // Scoped to #dress-pop: the slot picker is the same panel component as the TOP-BAR
  // search, so a bare `.search-dropdown input` types into the wrong one.
  await page.evaluate(() => document.querySelector('[data-slot="offhand"]').click());
  await page.waitForFunction(() => !document.getElementById("dress-pop").hidden, { timeout: 10000 });
  await page.type("#dress-find", "Cruel Barb");
  await page.waitForSelector("#dress-pop .sd-row[data-i]", { timeout: 15000 });
  await page.click("#dress-pop .sd-row[data-i]");
  // The equip re-mounts the viewer, so wait for the model rather than for the URL, which
  // is written first.
  // Guarded: the hook is briefly absent while the viewer is torn down and rebuilt, and an
  // unguarded poll throws into the page, which the harness rightly counts as an error.
  await page.waitForFunction(
    () => window.__mv
      && window.__mv().attached.filter((a) => a.attach === 1 || a.attach === 2).length === 2,
    { timeout: 20000 },
  ).catch(() => {});
  const url = await page.evaluate(() => location.search);
  const hands = await page.evaluate(() => window.__mv().attached.filter((a) => a.attach === 1 || a.attach === 2));
  console.log(`open slot: url=${/mainhand=5191/.test(url)}/${/offhand=5191/.test(url)} weapons held=${hands.length}`);
  return /mainhand=5191/.test(url) && /offhand=5191/.test(url) && hands.length === 2;
}

smoke("a weapon goes in the slot whose picker you opened", () => testEquipIntoTheOpenSlot());

// An item set is where someone decides whether to chase it, and eight tooltips do not
// answer "what does it look like". The set page wears the whole thing on the same
// mannequin the item page uses -- one piece per SLOT, best first, since a set routinely
// carries several items for one slot (a 1H and a 2H, two rings).
async function testItemSetPreview() {
  await nav("?itemset=201");                       // Arcanist's Regalia: 8 visible pieces
  await page.waitForSelector("#mv-host", { timeout: T });
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const st = await page.evaluate(() => window.__mv());
  const link = await page.$eval(".item-dress a", (a) => a.getAttribute("href"));
  const attached = st.attached.map((a) => a.model).join(" ");
  // a set with a weapon puts it in a hand, which the robe set cannot prove
  await nav("?itemset=630");                       // Towerforge Battlegear: a 2H maul
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const held = await page.evaluate(() => window.__mv().attached.filter((a) => a.attach === 1).length);
  console.log(`set preview: 201 attached [${attached}] link=${link} | 630 weapons held=${held}`);
  return st.triangles > 0 && /Helm_Robe_RaidMage/i.test(attached) && /Shoulder_Robe_RaidMage/i.test(attached)
    && /^\?dressing&/.test(link) && /head=16795/.test(link) && /chest=16798/.test(link)
    && held === 1;
}

smoke("an item set is shown worn, and links into the room", () => testItemSetPreview());

// The set preview wears the dressing room's own pickers (src/appearance.js), so a set can
// be judged on the character you actually play rather than on a stock human male. Three
// things have to hold: the pickers drive the model, the choice rides in the URL so a
// shared link shows what the sender saw, and the look is REMEMBERED -- which is what lets
// a set page open on your character without a link saying so.
async function testSetAppearance() {
  await nav("?itemset=201&race=1&sex=m");
  await viewerIdle();
  const human = await page.evaluate(() => window.__mv.snapshot({ background: false }));
  // every group is one row or one column -- the rule that keeps the controls off the model
  const shapes = await page.$$eval(".mv-appearance .dfield", (els) => els.map((e) => {
    const inner = e.querySelector(".race-row, .swatches, .steps");
    if (!inner) return "?";
    const kids = [...inner.children].filter((c) => c.getBoundingClientRect().width > 0);
    const rows = new Set(kids.map((c) => Math.round(c.getBoundingClientRect().top)));
    const cols = new Set(kids.map((c) => Math.round(c.getBoundingClientRect().left)));
    return `${e.dataset.field}:${rows.size === 1 ? "row" : cols.size === 1 ? "col" : "block"}`;
  }));
  await afterRemount(async () => {
    await page.click('.mv-appearance [data-key="race"][data-val="6"]');
    await page.waitForFunction(() => /race=6/.test(location.search), { timeout: 15000 });
  });
  const tauren = await page.evaluate(() => window.__mv.snapshot({ background: false }));
  const link = await page.$eval(".item-dress a", (a) => a.getAttribute("href"));
  const remembered = await page.evaluate(() => localStorage.getItem("tw-appearance"));
  // ...and a fresh set page, with nothing in its URL, opens on that same character
  await nav("?itemset=630");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const opened = await page.evaluate(() => window.__mv().race ?? null);
  console.log(`set pickers: ${shapes.join(" ")} | changed=${tauren !== human} link=${/race=6/.test(link)} remembered=${/"race":6/.test(remembered || "")}`);
  return shapes.every((s2) => s2.endsWith("row") || s2.endsWith("col"))
    && tauren !== human && /race=6/.test(link) && /"race":6/.test(remembered || "")
    && (opened === null || opened === 6);
}

smoke("a set can be tried on any race, and remembers which", () => testSetAppearance());

// Hover a search result and it goes ON the character. A row of icons and names says
// nothing about how a piece will look with the rest of an outfit, which is what people
// are actually choosing between. The preview must be exactly that -- a preview: it may
// not touch the URL, and moving away must put the outfit back.
async function testHoverPreview() {
  await nav("?dressing&race=1&sex=m&hair=3&chest=60180");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const worn = await page.evaluate(() => window.__mv.snapshot({ background: false }));
  const url = await page.evaluate(() => location.search);
  await page.evaluate(() => document.querySelector('[data-slot="chest"]').click());
  await page.waitForFunction(() => !document.getElementById("dress-pop").hidden, { timeout: 10000 });
  await page.type("#dress-find", "robe");
  await page.waitForSelector("#dress-pop .sd-row[data-i]", { timeout: 15000 });

  await afterRemount(async () => {
    await page.hover("#dress-pop .sd-row[data-i='1']");
    await page.waitForFunction(() => !document.getElementById("dress-preview-tag").hidden, { timeout: 15000 })
      .catch(() => {});
  });
  const previewed = await page.evaluate(() => window.__mv.snapshot({ background: false }));
  const urlWhilePreviewing = await page.evaluate(() => location.search);

  await afterRemount(async () => {
    await page.evaluate(() => document.getElementById("dress-hits")
      .dispatchEvent(new MouseEvent("mouseleave")));
  });
  const back = await page.evaluate(() => window.__mv.snapshot({ background: false }));

  // No wait here, and deliberately not a hover-settled one: the mouseleave above was
  // DISPATCHED, so the real pointer never left this row. Re-hovering it fires nothing, the
  // preview badge never comes back, and waiting for it burns the full timeout (measured:
  // 15s, which is what turned this test from 3.5s into 15.7s). The click is what the
  // assertion below is about, and it lands whether or not a preview is showing.
  await page.click("#dress-pop .sd-row[data-i='1']");
  await page.waitForFunction(() => document.getElementById("dress-preview-tag").hidden, { timeout: 10000 })
    .catch(() => {});
  const committed = await page.evaluate(() => location.search);
  console.log(`hover preview: changed=${previewed !== worn} urlUntouched=${urlWhilePreviewing === url} restored=${back === worn} committed=${committed !== url}`);
  return previewed !== worn && urlWhilePreviewing === url && back === worn && committed !== url;
}

smoke("hovering a result tries it on without keeping it", () => testHoverPreview());

// A robe paints AFTER the legs: its skirt covers them, which is what the robe geoset is
// for. Filed under the chest's usual paint slot, a pair of trousers painted over the skirt
// the robe had just drawn and the legs won. Asserted by pixels rather than by order --
// wearing trousers under a robe must render exactly the same as wearing none.
async function testRobeOverLegs() {
  const shot = async (url) => {
    await nav(url);
    await viewerIdle();
    return page.evaluate(() => window.__mv.snapshot({ background: false }));
  };
  const robeOnly = await shot("?dressing&race=1&sex=m&hair=3&chest=51848");
  const withLegs = await shot("?dressing&race=1&sex=m&hair=3&chest=51848&legs=6568");
  const legsOnly = await shot("?dressing&race=1&sex=m&hair=3&legs=6568");
  console.log(`robe: covered=${robeOnly === withLegs} legsDiffer=${robeOnly !== legsOnly}`);
  // the second half of the check guards the first: if the viewer rendered nothing at all,
  // every snapshot would match and "covered" would pass for the wrong reason.
  return robeOnly === withLegs && robeOnly !== legsOnly;
}

smoke("a robe covers the trousers under it", () => testRobeOverLegs());

// ...and it swallows the GEOMETRY of the pieces that reach into the same space, which no
// per-item geoset pass can see: each item is right about its own group and wrong only in
// company. Reported from the live site as three separate bugs -- boots poking through the
// skirt, a tabard's flaps hanging in front of it, and puff sleeves flaring out past the
// gloves -- and they are one rule each, applied once the whole outfit is known.
// "Hidden" is an EMPTY group, never the bare variant. Only groups 4, 5 and 13 carry a
// variant 1 at all (measured over all 20 character models), so for the sleeve and the
// tabard there is nothing else it could mean -- and for the boot the bare variant is the
// trap: 501 is the SHIN, not an ankle trim, so falling back to it left the calf inside the
// skirt and poking through it, which is what "the boots still clip with the robe from
// behind" was. The skirt reaches the floor on every race, so dropping the group bares
// nothing.
async function testOutfitOverrides() {
  const at = async (url) => {
    await nav(url);
    await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
    return page.evaluate(() => window.__mv().geosets);
  };
  const group = (list, g) => list.filter((x) => Math.floor(x / 100) === g);
  const who = "?dressing&race=1&sex=m&hair=3";
  // Feet of the Lynx -> 504, Naga Battle Gloves -> 402, Greymane Tabard -> 1202,
  // Ancient Elven Robes -> 802 (sleeve) + 1302 (skirt).
  const plain = await at(`${who}&feet=1121&tabard=61368`);
  const robed = await at(`${who}&chest=51848&feet=1121&tabard=61368`);
  const robe = await at(`${who}&chest=51848`);
  const gloved = await at(`${who}&chest=51848&hands=888`);
  console.log(`overrides: plain=[${plain}] robed=[${robed}] robe=[${robe}] gloved=[${gloved}]`);
  return plain.includes(504) && plain.includes(1202)          // worn normally, both show
    && robed.includes(1302)                                   // the robe is actually on
    && group(robed, 5).length === 0                           // no boot, and no bare shin
    && group(robed, 12).length === 0                          // tabard flaps gone
    && robe.includes(802)                                     // the sleeve, with no glove
    && gloved.includes(402) && group(gloved, 8).length === 0;  // glove cuff replaces it
}

smoke("a robe hides the boots and tabard, a glove the sleeve", () => testOutfitOverrides());

// The same rule on the TEXTURE side. `leg_l` is the lower-leg rectangle of the body atlas,
// and under a robe the thing sampling it is the skirt -- so a boot painting there replaced
// the robe's own authored hem with a band of boot. Read off the composited atlas rather
// than off the screen: the rectangle either changed or it did not, and a rendered
// comparison would also pick up the toes, which the boot legitimately still paints.
async function testRobeKeepsItsHem() {
  const legLower = async (url) => {
    await nav(url);
    await viewerIdle();
    return page.evaluate(async () => {
      const img = await createImageBitmap(await (await fetch(window.__mv.bodyAtlas())).blob());
      const c = document.createElement("canvas");
      c.width = 128; c.height = 64;                        // charcomposite REGIONS.leg_l
      c.getContext("2d").drawImage(img, 128, 160, 128, 64, 0, 0, 128, 64);
      return c.toDataURL();
    });
  };
  const who = "?dressing&race=1&sex=f&hair=3";
  const robe = await legLower(`${who}&chest=51848`);
  const robeBoots = await legLower(`${who}&chest=51848&feet=4320`);
  const legs = await legLower(`${who}&legs=6568`);
  const legsBoots = await legLower(`${who}&legs=6568&feet=4320`);
  console.log(`hem: robeKept=${robe === robeBoots} bootsStillPaint=${legs !== legsBoots}`);
  // The second half guards the first: if the boot painted nothing anywhere, "kept" would
  // pass for the wrong reason.
  return robe === robeBoots && legs !== legsBoots;
}

smoke("a robe keeps its own hem under boots", () => testRobeKeepsItsHem());

// One stepper, two URL params. Where a race does not SPLIT its facial shape from its face
// paint (a human's nine beards are nine beards), the picker moves only `facial` -- but the
// look is written out as `facial` AND `paint`, so leaving `paint` behind pinned the beard
// TEXTURE while the geoset went on changing. Nine human male beards rendered as two, and
// the stale pair survived every reload by riding in the URL and in localStorage.
async function testFacialPaintCoupled() {
  const shot = async (url) => {
    await nav(url);
    await viewerIdle();
    return page.evaluate(() => window.__mv.snapshot({ background: false }));
  };
  // The poisoned link the old build wrote: shape 0 with style 8's paint. It must render as
  // shape 0 does when asked honestly -- arriving is clamped, not only changing.
  const healed = await shot("?dressing&race=1&sex=m&hair=3&facial=0&paint=8");
  const honest = await shot("?dressing&race=1&sex=m&hair=3&facial=0&paint=0");
  const other = await shot("?dressing&race=1&sex=m&hair=3&facial=3&paint=3");
  await afterRemount(() => page.click('.stepper[data-key="facial"] button[data-step="1"]'));
  const q = new URLSearchParams(await page.evaluate(() => location.search));
  console.log(`facial/paint: healed=${healed === honest} distinct=${honest !== other}`
    + ` stepped facial=${q.get("facial")} paint=${q.get("paint")}`);
  // `distinct` guards `healed`: if the viewer drew nothing, every snapshot would match.
  return healed === honest && honest !== other && q.get("facial") === q.get("paint");
}

smoke("facial hair and its paint move together where the race has one choice",
  () => testFacialPaintCoupled());

// On a phone the two rails cannot stand beside the model, and stacking them in source
// order buried it under fourteen slot rows: you scrolled PAST the character to change it,
// then back up to see the result. The model leads and stays put, and tabs swap which rail
// is under it. (beforeEach resets the viewport, so the phone size does not leak.)
async function testPhoneLayout() {
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await nav("?dressing&race=9&sex=f&hair=3&head=81007&chest=10399&legs=10400");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const m = await page.evaluate(() => {
    const stage = document.querySelector(".mv-wrap").getBoundingClientRect();
    const slot = document.querySelector(".dress-slot").getBoundingClientRect();
    return { stageTop: Math.round(stage.top), slotTop: Math.round(slot.top),
      tabs: getComputedStyle(document.querySelector(".dress-tabs")).display,
      sticky: getComputedStyle(document.querySelector(".mv-wrap")).position,
      xOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      doc: document.documentElement.scrollHeight };
  });
  // switching to Appearance must hide the gear rail rather than stack it
  await page.click('.dress-tab[data-pane="look"]');
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".dress-col-l")).display === "none", { timeout: T }).catch(() => {});
  const swapped = await page.evaluate(() => ({
    gear: getComputedStyle(document.querySelector(".dress-col-l")).display,
    look: getComputedStyle(document.querySelector(".dress-bar")).display,
  }));
  console.log(`phone: ${JSON.stringify(m)} swapped=${JSON.stringify(swapped)}`);
  return m.stageTop < m.slotTop && m.tabs !== "none" && m.sticky === "sticky"
    && !m.xOverflow && swapped.gear === "none" && swapped.look !== "none";
}

smoke("dressing room puts the model first on a phone", () => testPhoneLayout());

// A slot paints only ITS OWN regions of the body atlas. ItemDisplayInfo hands out eight
// component textures per row and a tier piece routinely carries the whole set's pack --
// Dreadnaught Gauntlets name all eight, the Helmet names a chest and a trouser texture --
// so painting every one of them re-skinned the torso and legs the moment a helmet went on.
async function testSlotPaintsItsOwnRegions() {
  const shot = async (url) => {
    await nav(url);
    await viewerIdle();
    return page.evaluate(() => window.__mv.snapshot({ background: false }));
  };
  const bare = await shot("?dressing&race=1&sex=m&hair=1");
  const helmed = await shot("?dressing&race=1&sex=m&hair=1&head=22418");
  const gloved = await shot("?dressing&race=1&sex=m&hair=1&hands=22421");
  // A helm and a glove must each change the picture -- and the body underneath must be
  // the same in both, which it is not if either painted the torso from its stale pack.
  const chest = async (url) => {
    await nav(url);
    await viewerIdle();
    // sample the torso from the composited atlas: same skin means no bleed
    return page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const ctx = c.getContext("2d");
      const src = document.querySelector("#mv-host canvas");
      ctx.drawImage(src, 0, 0, 256, 256);
      const d = ctx.getImageData(128, 90, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    });
  };
  const bareChest = await chest("?dressing&race=1&sex=m&hair=1");
  const helmChest = await chest("?dressing&race=1&sex=m&hair=1&head=22418");
  console.log(`regions: helmChanged=${bare !== helmed} gloveChanged=${bare !== gloved} torso ${bareChest} -> ${helmChest}`);
  return bare !== helmed && bare !== gloved && bareChest === helmChest;
}

smoke("a slot paints only its own regions of the body", () => testSlotPaintsItsOwnRegions());

// An attachment wears its BONE'S SCALE, which the client applies and which is per race:
// measured 1.000 on a human male, 0.574 on a blood elf female, 0.650 on a gnome and 1.600
// on a tauren -- the reason one pair of pauldrons looks tiny on a gnome and enormous on a
// tauren. Dropping it dressed a blood elf in human-sized shoulders, reported as "two
// shoulders", the oversized pair being ours.
async function testAttachmentScale() {
  const scaleOf = async (race, sex) => {
    await nav(`?dressing&race=${race}&sex=${sex}&hair=3&shoulder=70783`);
    await page.waitForFunction(() => window.__mv && window.__mv().attached?.length === 2, { timeout: T });
    return page.evaluate(() => window.__mv().attached[0].scale);
  };
  const human = await scaleOf(1, "m");
  const belf = await scaleOf(10, "f");
  const tauren = await scaleOf(6, "m");
  console.log(`attach scale: human=${human} bloodElf=${belf} tauren=${tauren}`);
  // A v2 model (not yet re-exported) reports 1 for everything, which is the old bug --
  // so the test also proves the character models on this origin are v3.
  return human === 1 && belf < 0.7 && tauren > 1.4;
}

smoke("an attached shoulder wears its bone's scale", () => testAttachmentScale());

// The idle animation. A character is a RIGGED model (v4): bind-pose vertices plus a
// skeleton, weights and Stand's keys, posed per frame. Three things are pinned here --
// that a character is rigged at all, that the model HOLDS STILL until asked (the viewer's
// whole idle discipline), and that asking actually moves the mesh.
async function testIdleAnimation() {
  await nav("?dressing&race=1&sex=m&hair=3&chest=60180");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  // "Holds still" is a state the viewer reports, so wait for it rather than sleeping and
  // hoping. Restarting the clip is the one place a wait needs a QUANTITY: `animating`
  // flips on the click, but the two snapshots only differ once frames have actually been
  // drawn -- so wait for the frame COUNTER to advance instead of guessing how long that
  // takes. Faster on this machine and, unlike a fixed sleep, still correct on a slow one.
  await page.waitForFunction(() => window.__mv && window.__mv().running === false, { timeout: T });
  const still = await page.evaluate(() => window.__mv());
  const before = await page.evaluate(() => window.__mv.snapshot({ background: false }));
  const f0 = await page.evaluate(() => window.__mv().frames);
  await page.click("#dress-anim");
  await page.waitForFunction((f) => window.__mv().animating && window.__mv().frames > f + 10, { timeout: T }, f0);
  const moving = await page.evaluate(() => window.__mv());
  const after = await page.evaluate(() => window.__mv.snapshot({ background: false }));
  await page.click("#dress-anim");                       // and back to the still pose
  await page.waitForFunction(() => window.__mv().animating === false, { timeout: T });
  const stopped = await page.evaluate(() => window.__mv().animating);
  console.log(`anim: rigged=${still.rigged} loop=${still.animMs}ms idle(running=${still.running}) -> playing(running=${moving.running}) moved=${before !== after} stopped=${!stopped}`);
  return still.rigged && still.animMs > 500 && still.animating === false && still.running === false
    && moving.animating === true && before !== after && stopped === false;
}

smoke("a character stands still until asked to breathe", () => testIdleAnimation());

// The turntable and the animation are two movers on ONE clock. Each used to take the
// frame's elapsed time for itself, so with the animation running the spin's dt came out
// zero every frame: Rotate lit up and the model did not turn. Measured in radians, because
// the button's state was never the thing that was broken.
async function testSpinWhileAnimating() {
  await nav("?dressing&race=1&sex=m&hair=3");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const turn = async () => {
    const a = await page.evaluate(() => window.__mv.view().spin);
    await new Promise((r) => setTimeout(r, 1200));
    return (await page.evaluate(() => window.__mv.view().spin)) - a;
  };
  await page.click("#dress-spin");
  const alone = await turn();
  await page.click("#dress-anim");                       // now both at once
  const together = await turn();
  console.log(`spin: alone=${alone.toFixed(3)} rad, while animating=${together.toFixed(3)} rad`);
  return alone > 0.2 && together > 0.2;
}

smoke("the turntable still turns while the animation plays", () => testSpinWhileAnimating());

// Switching animations. The model file holds only its idle -- the other fifteen are a
// sidecar (.anm) fetched the first time someone opens the picker -- so this also proves
// the two halves agree on an encoding they no longer share a file with.
//
// It deliberately passes in BOTH states, because a model-format bump reaches R2 and the
// deployed code at different moments: against models that predate the sidecar the picker
// has nothing to offer and the room must simply keep working. It asserts the strong thing
// whenever the sidecar is actually there, and says in its log which half ran.
async function testAnimationPicker() {
  await nav("?dressing&race=1&sex=m&hair=3");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  await page.focus("#dress-clip");                       // what pulls the sidecar down
  await page.waitForFunction(
    () => document.querySelectorAll("#dress-clip option").length > 1, { timeout: 8000 },
  ).catch(() => {});
  const names = await page.$$eval("#dress-clip option", (o) => o.map((x) => x.value));
  if (names.length < 2) {
    const ok = await page.evaluate(() => window.__mv().triangles > 0);
    console.log(`clips: no sidecar on this origin (${names.join(",") || "none"}) - room still renders=${ok}`);
    return ok;
  }
  const idle = await page.evaluate(() => window.__mv());
  await page.click("#dress-anim");                       // play, so the pose is moving
  await new Promise((r) => setTimeout(r, 600));
  const before = await page.evaluate(() => window.__mv.snapshot({ background: false }));
  await page.select("#dress-clip", "EmoteDance");
  await new Promise((r) => setTimeout(r, 600));
  const dancing = await page.evaluate(() => window.__mv());
  const after = await page.evaluate(() => window.__mv.snapshot({ background: false }));
  console.log(`clips: ${names.length} offered, ${idle.clip}/${idle.animMs}ms -> ${dancing.clip}/${dancing.animMs}ms moved=${before !== after}`);
  return names.length >= 8 && names.includes("EmoteDance") && idle.clip === "Stand"
    && dancing.clip === "EmoteDance" && dancing.animMs !== idle.animMs && before !== after;
}

smoke("a character can be asked for a different animation", () => testAnimationPicker());

// One step per frame, one frame per step. The loop used to render on every rAF while
// advancing the movers on a 33ms gate: half the frames redrew an identical pose, which is
// full GPU cost for the judder it produced. The turntable turns 0.37 degrees per 30fps
// frame and keeps that budget; the animation takes the display's rate. Measured as a
// RATIO so the assertion means the same thing on any machine.
async function testFramePacing() {
  await nav("?dressing&race=1&sex=m&hair=3");
  await page.waitForFunction(() => window.__mv && window.__mv().triangles > 0, { timeout: T });
  const rate = async (ms) => page.evaluate((ms) => new Promise((done) => {
    const a = window.__mv().frames;
    setTimeout(() => done((window.__mv().frames - a) / (ms / 1000)), ms);
  }), ms);
  await page.click("#dress-spin");
  const spinning = await rate(1500);
  await page.click("#dress-spin");
  await page.click("#dress-anim");
  const playing = await rate(1500);
  const target = await page.evaluate(() => window.__mv().fpsTarget);
  console.log(`pacing: turntable ${spinning.toFixed(0)}fps, animation ${playing.toFixed(0)}fps (target ${target})`);
  // The turntable is the regression guard: it must stay near its own 30fps budget however
  // fast the display is, and the bug being pinned drew every rAF for it (60). The
  // animation is only checked against the budget it actually chose -- a loaded CI box
  // legitimately steps down to 30, which is the adaptive rule doing its job.
  return spinning > 20 && spinning < 40 && playing > 20
    && (target === 60 ? playing > spinning * 1.5 : playing < spinning * 1.5);
}

smoke("the turntable draws half the frames the animation does", () => testFramePacing());

// A mesh the client hides is hidden by a SCALE OF EXACTLY ZERO, and zero is falsy: the
// old `v || 1` guard turned every hidden mesh back to full size. Characters carry two
// eyelids -- one animated, one for sleeping -- so a blood elf male wore a flat quad over
// his eyes, and only races whose spare lid is hidden this way showed it. Checked on the
// eye glow, which is unmistakable in pixels: bright blue where a covered eye is skin.
async function testHiddenMeshStaysHidden() {
  await nav("?dressing&race=10&sex=m&hair=0&face=0");
  await viewerIdle();
  const found = await page.evaluate(async () => {
    const url = window.__mv.snapshot({ background: false });
    const img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    // the head is the top of the figure; the glow is the only strongly blue thing on it
    let top = c.height, glow = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 8) { top = Math.floor((i >> 2) / c.width); break; }
    }
    const until = top + Math.floor(c.height * 0.12);
    for (let y = top; y < until; y++) {
      for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        if (data[o + 3] > 100 && data[o + 2] - data[o] > 30) glow++;
      }
    }
    return glow;
  });
  console.log(`hidden mesh: blood elf male glowing-eye pixels = ${found} (0 means a lid is covering them)`);
  return found > 20;
}

smoke("a mesh the client hides at scale zero stays hidden", () => testHiddenMeshStaysHidden());

// A still model sits at each global track's RESTING value, not at t=0. A tauren female's
// blink straddles the loop boundary -- her track starts at 1.0, lid shut -- so freezing
// the clock at zero left her with her eyes closed for good, while every other race
// happened to start open. The resting phase is the midpoint of the widest gap between
// keys: the state the cycle actually holds.
async function testRestPhase() {
  await nav("?dressing&race=6&sex=f&hair=0");
  await viewerIdle();
  // Global tracks live in .m2b v6; a model that predates it carries none, and on such an
  // origin there is no resting phase to be wrong about. Like the animation picker, this
  // asserts the strong thing only where the data for it exists.
  const globals = await page.evaluate(() => window.__mv().globals);
  const resting = await page.evaluate(() => window.__mv.snapshot({ background: false }));
  const atZero = await page.evaluate(() => {
    window.__mv.globalClock(0);                        // the phase the old code froze at
    return window.__mv.snapshot({ background: false });
  });
  console.log(`rest phase: ${globals} global tracks; tauren female differs from her t=0 pose = ${resting !== atZero}`);
  return globals ? resting !== atZero : true;
}

smoke("a still character rests where its blink cycle rests", () => testRestPhase());

