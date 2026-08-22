// The character body texture: one 256x256 atlas the client builds by painting skin,
// face, underwear and every worn armor piece into fixed rectangles. Pure canvas 2D and
// no three.js import, so it can be tested without a WebGL context.
//
// The client never ships this atlas -- it composites it at runtime from CharSections and
// ItemDisplayInfo.Texture[8] -- so the rectangles below had to be recovered. They were
// NOT taken from a wiki: each was located by matching real component textures into the
// client's own pre-baked NPC atlases (Textures\BakedNpcTextures\, the composites Blizzard
// shipped for character-model NPCs), then taking the modal offset across hundreds of
// bakes. Eight of the ten agreed unanimously; `torso_u` is the one rectangle no bake
// matched confidently, and it is pinned by exhaustion instead -- the two columns tile the
// atlas exactly, with no gap and no overlap, and it is the only free slot left.
//
// Region order in ItemDisplayInfo.Texture[8] is arm_u, arm_l, hand, torso_u, torso_l,
// leg_u, leg_l, foot -- which is why item_appearance stores them under those names.

export const ATLAS = 256;

export const REGIONS = {
  arm_u:   [0, 0, 128, 64],
  arm_l:   [0, 64, 128, 64],
  hand:    [0, 128, 128, 32],
  face_u:  [0, 160, 128, 32],
  face_l:  [0, 192, 128, 64],
  torso_u: [128, 0, 128, 64],
  torso_l: [128, 64, 128, 32],
  leg_u:   [128, 96, 128, 64],
  leg_l:   [128, 160, 128, 64],
  foot:    [128, 224, 128, 32],
};

// CharSections rows carry up to 3 textures; which region each lands in depends on the
// section. Skin is the whole atlas (it IS the base), the rest are overlays.
export const SECTION_REGIONS = {
  face: ["face_l", "face_u"],       // FaceLower is 128x64, FaceUpper 128x32
  facial: ["face_l", "face_u"],     // beard/moustache paint over the same rectangles
  underwear: ["leg_u", "torso_u"],  // NakedPelvis then NakedTorso
  // A hairstyle carries three textures and only two of them are painted here:
  // [0] is the hair MESH texture (a separate texture slot on the model), while
  // [1]/[2] are the scalp, which blends the hairline into the face.
  hair: [null, "face_l", "face_u"],
};

// fetch, not `new Image()`. A layer legitimately ASKS for a name that may not exist --
// armor ships a male+female pair or one unisex file, so one of the two candidates is
// always a miss -- and a failed <img> is logged by the browser as a red console error,
// which meant a perfectly normal outfit printed a dozen 404s into a public console. A
// fetch that 404s is an ordinary response and logs nothing. ImageBitmap draws onto a
// canvas exactly as an Image does.
async function loadImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;            // a missing layer is a gap, never a thrown page
    return await createImageBitmap(await res.blob());
  } catch {
    return null;                         // offline, blocked, or an undecodable body
  }
}

/**
 * Build the body atlas.
 *   base    the full-atlas skin texture URL (CharSections base section "skin")
 *   layers  [{ url, region }] painted in order; later layers win, which is how armor
 *           covers skin and a glove covers a bracer.
 * Returns a canvas, or null when even the base could not be loaded.
 */
export async function compositeBody({ base, layers = [] }) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ATLAS;
  const ctx = canvas.getContext("2d");
  const baseImg = base ? await loadImage(base) : null;
  if (baseImg) ctx.drawImage(baseImg, 0, 0, ATLAS, ATLAS);
  else ctx.fillStyle = "#b98d6a", ctx.fillRect(0, 0, ATLAS, ATLAS);   // untextured stand-in

  // Loaded in parallel, drawn in order: the sequence is what makes layering correct, and
  // awaiting them one at a time would serialise ~10 requests for no reason. A layer may
  // list SEVERAL candidate urls -- armor ships either a male+female pair or one unisex
  // file, never both -- and the first that loads wins.
  const imgs = await Promise.all(layers.map(async (l) => {
    for (const url of (l.urls || [l.url])) {
      const img = await loadImage(url);
      if (img) return img;
    }
    return null;
  }));
  imgs.forEach((img, i) => {
    if (!img) return;
    const r = REGIONS[layers[i].region];
    if (!r) return;
    ctx.drawImage(img, r[0], r[1], r[2], r[3]);
  });
  return canvas;
}
