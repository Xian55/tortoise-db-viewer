// Interactive 3D item preview. Lazy chunk: this is the ONLY module that imports three,
// so nothing here is downloaded until a visitor actually opens a 3D tab -- the same
// discipline src/zonemap.js follows for Leaflet/Pixi.
//
// The models are ours (scripts/export-models.py converts the client's M2s to .m2b);
// nothing here talks to Wowhead. See src/m2b.js for the format, and CLAUDE.md
// "3D model viewer" for why we render our own.
//
// WebGL-context discipline, learned from zonemap.js: a browser allows only a handful of
// live contexts, so the viewer MUST be destroy()ed on route change or a few navigations
// silently kill the oldest canvas. destroy() also stops the RAF loop -- a viewer left
// spinning in a hidden pane burns battery for nothing.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { parseM2B, bounds, TEX_HAIR } from "./m2b.js";
import { compositeBody, SECTION_REGIONS } from "./charcomposite.js";
import { MODELS_BASE } from "./config.js";

/** Cheap probe -- callers use it to decide whether to offer a 3D tab at all. Creating
 *  and dropping one throwaway context is far cheaper than importing this chunk, but this
 *  lives here so the answer and the renderer can never disagree. */
export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

const modelUrl = (name) => `${MODELS_BASE}item/${String(name).toLowerCase()}.m2b`;
const textureUrl = (name) => `${MODELS_BASE}itemtex/${String(name).toLowerCase()}.webp`;

async function fetchModel(name) {
  const res = await fetch(modelUrl(name));
  if (!res.ok) throw new Error(`model ${name} unavailable (${res.status})`);
  return parseM2B(await res.arrayBuffer());
}

// A texture named INSIDE the model keeps its client path (`SPELLS\ZAP1.BLP` ->
// `tex/spells/zap1.webp`), matching what export-models.py wrote.
const embeddedUrl = (name) =>
  `${MODELS_BASE}tex/${String(name).toLowerCase().replace(/\\/g, "/").replace(/\.blp$/, "")}.webp`;

function loadTexture(url) {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.flipY = false;                 // M2 UVs are top-left origin, like the client
        resolve(t);
      },
      undefined,
      () => resolve(null),               // a missing texture is a grey model, not a crash
    );
  });
}

/** One material per submesh, honouring the M2 blend mode. The mapping is the one
 *  render-model-thumbs.py already validated on ~1,500 creature renders: 0/1 are opaque
 *  (1 being 1-bit alpha, hence the cutoff), 2 is ordinary alpha, and 3+ are the additive
 *  glow planes -- which must not write depth or they punch holes in what is behind. */
function materialFor(sub, map) {
  const common = { map, side: THREE.DoubleSide, transparent: false };
  if (sub.blend === 0) return new THREE.MeshLambertMaterial(common);
  if (sub.blend === 1) return new THREE.MeshLambertMaterial({ ...common, alphaTest: 0.3 });
  if (sub.blend === 2) {
    return new THREE.MeshLambertMaterial({ ...common, transparent: true, alphaTest: 0.02, depthWrite: false });
  }
  return new THREE.MeshBasicMaterial({
    map, side: THREE.DoubleSide, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Bounds of the opaque (blend 0/1) submeshes only, or null when a model is nothing but
 *  effect planes. Walks the index buffer because a submesh is a range of INDICES, so its
 *  vertices are not a contiguous slice of the position array. */
function opaqueBounds(model) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let seen = 0;
  for (const sub of model.submeshes) {
    if (sub.blend > 1 || !sub.count) continue;
    for (let i = sub.first; i < sub.first + sub.count; i++) {
      const v = model.idx[i] * 3;
      for (let a = 0; a < 3; a++) {
        const c = model.pos[v + a];
        if (c < lo[a]) lo[a] = c;
        if (c > hi[a]) hi[a] = c;
      }
      seen++;
    }
  }
  if (!seen) return null;
  return {
    center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    radius: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1,
  };
}

/**
 * Mount an item preview into `el`.
 *   opts: { model, texture, background }
 * Returns a viewer handle; call destroy() when the view goes away.
 */
export async function mountItemViewer(el, opts = {}) {
  const model = await fetchModel(opts.model);

  // One texture PER SLOT, not one per model. An effect weapon is the item's own mesh
  // plus glow/lightning planes that name their own textures inside the file, so binding
  // the item texture to everything paints the blade onto its own glow -- which is
  // exactly how Thunderfury came out as a lit square. texType 2 (object skin) is the
  // slot the item texture fills; type 0 carries its own path.
  const slotTex = await Promise.all(model.textures.map((t) => (
    t.type === 0 && t.name
      ? loadTexture(embeddedUrl(t.name))
      : (opts.texture ? loadTexture(textureUrl(opts.texture)) : Promise.resolve(null))
  )));
  return buildViewer(el, model, slotTex, { label: opts.model, texture: opts.texture || null });
}

/**
 * The shared scene: geometry, materials, camera, controls and the render scheduling.
 * Both entry points end here -- an item and a character differ only in which model they
 * load, which textures fill its slots, and which geosets are visible.
 *   opts: { label, texture, geosets (Set of visible geoset ids, or null for all) }
 */
function buildViewer(el, model, slotTex, opts = {}) {
  const tex = slotTex.find((t, i) => t && model.textures[i].type !== 0)
    || slotTex.find(Boolean) || null;

  const width = () => Math.max(1, el.clientWidth || 480);
  const height = () => Math.max(1, el.clientHeight || 360);

  const renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: true,
    // A postage-stamp preview of a few thousand triangles has no business waking a
    // discrete GPU on a laptop that has one.
    powerPreference: "low-power",
  });
  // Beyond 2x the extra pixels are invisible and quadratic in cost.
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(width(), height());
  renderer.setClearColor(0x000000, 0);
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // WoW is Z-up with +X forward; three is Y-up. One rotation on the root converts the
  // whole model -- positions, and later bones and attachments -- rather than baking a
  // basis change into the exporter, where it would have to be got right four times over.
  const root = new THREE.Object3D();
  root.rotation.x = -Math.PI / 2;
  scene.add(root);
  // Lighting copied from render-model-thumbs.py (amb + key from front-left-above
  // + a small fill), so a model looks the same here as in the thumbnail the site already
  // shows. These textures are pre-shaded, so anything brighter blows them out -- an
  // earlier ambient+key of 1.6+1.5 washed Gressil to a pale ghost of itself. The key
  // direction is the shader's (0.35, 0.5, 0.8) mapped into three's Y-up axes.
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 0.6);
  key.position.set(0.35, 0.8, -0.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.18);
  fill.position.set(-0.35, -0.8, 0.5);
  scene.add(fill);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(model.pos, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(model.nrm, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
  geom.setIndex(new THREE.BufferAttribute(model.idx, 1));

  const materials = [];
  const drawnSubs = [];
  let drawn = 0;
  model.submeshes.forEach((sub) => {
    if (!sub.count) return;
    // A character model carries EVERY variant of every geoset -- all hairstyles, all
    // beards, gloves, boots, robe, cape -- and drawing them all gives you a figure with
    // four hairstyles at once. The caller passes the set it wants.
    if (opts.geosets && !opts.geosets.has(sub.geoset)) return;
    // Props the client animates at runtime. Turtle's goblin models carry a cloth rag
    // (Character\Goblin\RAG_02.blp) as an embedded-texture plane; with the pose baked at
    // Stand frame 0 and no cloth simulation it hangs straight out from the waist like a
    // flag. A character has no other use for an embedded texture, so the whole class is
    // skipped rather than special-casing one file.
    if (opts.skipEmbedded && sub.texType === 0) return;
    geom.addGroup(sub.first, sub.count, materials.length);
    // texSlot 0xFF means the submesh resolved no texture at all; fall back to the item's
    // own rather than drawing it untextured.
    const map = (sub.texSlot < slotTex.length ? slotTex[sub.texSlot] : null) || tex;
    materials.push(materialFor(sub, map));
    drawnSubs.push([sub.geoset, sub.texType, sub.blend, map ? 1 : 0]);
    drawn++;
  });
  const mesh = new THREE.Mesh(geom, materials);
  root.add(mesh);

  // Frame on the SOLID body, not the whole bbox: effect planes reach well past the mesh
  // (Thunderfury's lightning quads are wider than the sword), so including them shrinks
  // the item and pushes it off-centre. Same rule render-model-thumbs.py frames by.
  const { center, radius } = opaqueBounds(model) || bounds(model);
  const camera = new THREE.PerspectiveCamera(35, width() / height(), radius / 100, radius * 100);
  const target = new THREE.Vector3(center[0], center[2], -center[1]);  // same swap as root
  // A weapon reads best from a three-quarter angle; a character has a front, and showing
  // it in profile makes the face -- the thing the pickers change -- invisible.
  const dir = opts.front || [2.2, 1.1, 2.6];
  camera.position.set(target.x + radius * dir[0], target.y + radius * dir[1], target.z + radius * dir[2]);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = radius * 1.2;
  controls.maxDistance = radius * 8;
  controls.update();

  let spin = true;                       // idles gently until the visitor takes over
  controls.addEventListener("start", () => { spin = false; });

  // ---- render scheduling -------------------------------------------------------
  // The viewer must cost nothing when nothing is happening. Three things would
  // otherwise burn a core and a GPU queue for no visible benefit:
  //   * rendering while the 3D pane is hidden behind another tab of the item page --
  //     the canvas is still in the DOM, so nothing stops it on its own;
  //   * rendering after the model has come to rest -- a still image redrawn 60x a second;
  //   * spinning on in a background browser tab (rAF throttles there, but page
  //     visibility is free to check and makes the intent explicit).
  // So: the loop runs only while something is actually moving, and any input, resize or
  // visibility change wakes it again.
  let raf = 0;
  let alive = true;
  let running = false;
  let visible = true;
  let frames = 0;
  let spun = 0;                          // radians of idle spin so far
  let last = 0;

  // controls.update() reports whether the camera actually moved -- that, not
  // `enableDamping` (which is simply always on), is what says damping has settled and
  // the loop may stop.
  const draw = () => {
    const changed = controls.update();
    renderer.render(scene, camera);
    frames++;
    return changed;
  };

  // Rotation is per SECOND, not per frame: the draw rate is throttled below, and a
  // frame-based step silently turns "one revolution" into two different durations on a
  // 30 fps and a 60 fps machine (measured: a 17s turn became 35s once throttled).
  const SPIN_RATE = (Math.PI * 2) / 17;  // rad/s -> one full turn in 17 seconds
  const MIN_MS = 1000 / 30;              // the idle spin looks the same at 30fps

  const tick = (now) => {
    if (!alive) { running = false; return; }
    if (!visible || document.hidden) { running = false; return; }   // sleep until woken
    // The idle spin exists to show the model from every side, so it stops after one full
    // revolution instead of turning forever: a preview nobody is looking at should end
    // up costing exactly nothing, and any interaction wakes it again anyway.
    let step = false;
    if (spin && (!last || now - last >= MIN_MS)) {
      const dt = last ? Math.min((now - last) / 1000, 0.25) : 0;  // clamp: a backgrounded
      last = now;                                                 // tab returns a huge dt
      root.rotation.z += SPIN_RATE * dt;
      spun += SPIN_RATE * dt;
      if (spun >= Math.PI * 2) spin = false;
      step = true;
    }
    const changed = draw();
    if (spin || changed || step) raf = requestAnimationFrame(tick);
    else running = false;
  };
  const wake = () => {
    if (!alive || running || !visible || document.hidden) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(tick);
  };
  // Dragging/zooming emits `change`; that both re-renders and keeps damping alive.
  controls.addEventListener("change", wake);

  const onResize = () => {
    if (!alive) return;
    camera.aspect = width() / height();
    camera.updateProjectionMatrix();
    renderer.setSize(width(), height());
    if (running) return;
    draw();                              // a resize while asleep still needs one frame
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
  ro?.observe(el);
  addEventListener("resize", onResize);

  // Is the canvas actually on screen? Covers both the hidden tab pane (zero-size box)
  // and simply scrolling the viewer out of view.
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) wake(); })
    : null;
  io?.observe(el);
  const onVisibility = () => { if (!document.hidden) wake(); };
  document.addEventListener("visibilitychange", onVisibility);

  draw();                                // first frame, so the pane is never blank
  wake();

  const viewer = {
    state: () => ({
      status: "ok", model: opts.label || null, texture: opts.texture || null,
      textured: !!tex, meshes: drawn, triangles: model.idx.length / 3,
      vertices: model.pos.length / 3, frames, spinning: spin,
      running, visible,                  // false/false = costing nothing right now
      geosets: opts.geosets ? [...opts.geosets].sort((a, b) => a - b) : null,
      // [geoset, texType, blend, hasTexture] per drawn submesh -- what actually
      // reached the GPU, which is the only way to tell "filtered out" from
      // "drawn but invisible".
      drawn: drawnSubs,
    }),
    /** Render and read back in ONE tick. A WebGL canvas is blank to toDataURL() unless
     *  it is read in the same frame as the draw, and paying preserveDrawingBuffer
     *  forever to avoid that would cost every visitor for one smoke test. */
    snapshot: () => {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/png");
    },
    resize: onResize,
    destroy: () => {
      if (!alive) return;
      alive = false;
      running = false;
      cancelAnimationFrame(raf);
      removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      io?.disconnect();
      ro?.disconnect();
      controls.dispose();
      geom.dispose();
      materials.forEach((m) => m.dispose());
      tex?.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
      if (window.__mv === hook) delete window.__mv;
    },
  };
  const hook = () => viewer.state();
  hook.snapshot = viewer.snapshot;
  window.__mv = hook;                    // smoke-test hook, same convention as __zoneDots
  return viewer;
}

// ---------------------------------------------------------------------------
// Characters (the dressing-room mannequin)
// ---------------------------------------------------------------------------

let charDataPromise = null;
/** The race/skin/face/hair option tables (scripts/data/char-appearance.json). Fetched,
 *  not bundled: at ~1 MB it would be the largest single thing in the main JS chunk, paid
 *  by every visitor to serve one page. Cached for the session. */
export function charAppearance() {
  if (!charDataPromise) {
    charDataPromise = fetch(`${MODELS_BASE}char-appearance.json`)
      .then((r) => { if (!r.ok) throw new Error(`char-appearance.json (${r.status})`); return r.json(); })
      .catch((e) => { charDataPromise = null; throw e; });
  }
  return charDataPromise;
}

const charTexUrl = (name) =>
  `${MODELS_BASE}chartex/${String(name).toLowerCase().replace(/\\/g, "/").replace(/\.blp$/, "")}.webp`;

/** The CharSections row for one option, or the first row of that section as a fallback
 *  (a race may simply not offer the variation/colour a shared default asks for). */
function section(data, race, sex, kind, variation, color) {
  const rows = data.sections[`${race}-${sex}-${kind}`] || [];
  return rows.find((r) => r[0] === variation && r[1] === color)
    || rows.find((r) => r[0] === variation)
    || rows[0] || null;
}

// Nothing is excluded by GROUP any more, and that is the point: the variant-1 rule below
// already separates body from equipment, including inside the cape group. Excluding group
// 15 outright looked right and was not -- 1501 is a 20-triangle patch of BODY, textured
// from the body atlas (texType 1), that closes the back where a cloak attaches, while
// 1502-1506 are the cloak sheets themselves (texType 2). Dropping the group punched a
// hole between the shoulders of every character on the site.
const NOT_BODY_GROUPS = new Set();

/** Which geosets a naked character shows: the body, its bare limbs, the chosen hairstyle
 *  and the chosen facial hair. Equipment overrides its own group later.
 *
 *  The rule is variant **1**, or nothing when the model has no variant 1 -- which is what
 *  the client does, and neither of the two obvious alternatives. Dropping the clothing
 *  groups entirely leaves a torso, hands and feet floating with no legs (Human male's
 *  bare legs live in geoset 1301). Taking each group's LOWEST variant instead dresses the
 *  mannequin in whatever garment happens to be numbered first -- on Human male that is a
 *  sleeve (802) and a kilt (1302), because the group has no variant 1 at all. */
export function baseGeosets(model, { hairGeoset = 0, facial = [] } = {}) {
  const present = new Set(model.submeshes.map((s) => s.geoset));
  const groups = new Set(model.submeshes.map((s) => Math.floor(s.geoset / 100)));
  const out = new Set([0]);                       // geoset 0 is the body itself
  for (const group of groups) {
    if (group === 0 || NOT_BODY_GROUPS.has(group)) continue;
    if (present.has(group * 100 + 1)) out.add(group * 100 + 1);
  }
  if (hairGeoset) out.add(hairGeoset);
  // Facial hair lives in groups 1/2/3 (beard, moustache, sideburns); a 0 means "none".
  facial.forEach((v, i) => { if (v) out.add((i + 1) * 100 + v); });
  return out;
}

/**
 * Mount a character mannequin.
 *   opts: { race (ChrRaces id), sex ("m"|"f"), skin, face, hair, hairColor, facialHair }
 */
export async function mountCharacterViewer(el, opts = {}) {
  const data = await charAppearance();
  const race = opts.race || 1;
  const sex = opts.sex === "f" ? "f" : "m";
  const skin = opts.skin || 0, face = opts.face || 0;
  const hairStyle = opts.hair || 0, hairColor = opts.hairColor || 0;
  const facialStyle = opts.facialHair || 0;

  const res = await fetch(`${MODELS_BASE}char/${race}-${sex}.m2b`);
  if (!res.ok) throw new Error(`character ${race}-${sex} unavailable (${res.status})`);
  const model = parseM2B(await res.arrayBuffer());

  // The body atlas, painted in the client's own order: skin, then the face, then
  // underwear over it.
  const skinRow = section(data, race, sex, "skin", 0, skin);
  const faceRow = section(data, race, sex, "face", face, skin);
  const underRow = section(data, race, sex, "underwear", 0, skin);
  const facialRow = section(data, race, sex, "facial", facialStyle, hairColor);
  const hairRow = section(data, race, sex, "hair", hairStyle, hairColor);

  const layers = [];
  const push = (row, regions) => {
    if (!row) return;
    row[2].forEach((tex, i) => {
      if (regions[i]) layers.push({ url: charTexUrl(tex), region: regions[i] });
    });
  };
  push(faceRow, SECTION_REGIONS.face);
  if (hairStyle) push(hairRow, SECTION_REGIONS.hair);   // scalp/hairline over the face
  push(underRow, SECTION_REGIONS.underwear);
  if (facialStyle) push(facialRow, SECTION_REGIONS.facial);

  const canvas = await compositeBody({
    base: skinRow?.[2]?.[0] ? charTexUrl(skinRow[2][0]) : null,
    layers,
  });
  const body = new THREE.CanvasTexture(canvas);
  body.colorSpace = THREE.SRGBColorSpace;
  body.flipY = false;

  // The hairstyle's own texture is a separate slot (texType 6) -- it is not part of the
  // body atlas, which is why a hairless mannequin is what you get if it is skipped.
  const hairTex = hairRow?.[2]?.[0] ? await loadTexture(charTexUrl(hairRow[2][0])) : null;

  // Slot resolution: the two SUBSTITUTED types get what we composited, anything that
  // names a file gets that file. Type is not enough on its own -- a Blood Elf's eye glow
  // is type 8 AND names its own BLP, so a rule keyed only on `type === 0` handed it the
  // body atlas and painted skin over the eyes.
  const slotTex = model.textures.map((t) => {
    if (t.type === TEX_HAIR) return hairTex || body;
    if (t.name) return null;                       // named; loaded below
    return body;                                   // 1 = character skin, 2 = object skin
  });
  await Promise.all(model.textures.map(async (t, i) => {
    if (t.type !== TEX_HAIR && t.name) slotTex[i] = await loadTexture(embeddedUrl(t.name));
  }));

  const hairGeoset = (data.hair[`${race}-${sex}`] || []).find((h) => h[0] === hairStyle)?.[1] || 0;
  const facialGeosets = (data.facial[`${race}-${sex}`] || []).find((f) => f[0] === facialStyle)?.slice(1) || [];

  return buildViewer(el, model, slotTex, {
    label: `${race}-${sex}`,
    geosets: baseGeosets(model, { hairGeoset, facial: facialGeosets }),
    skipEmbedded: true,
    // Straight on: a character model faces WoW +Y, which is -Z after the Y-up swap.
    // The distance is not a taste choice -- `radius` is half the LARGEST dimension, and
    // for an upright figure that is its height, so at a 35 degree FOV anything closer
    // than ~3.2 radii crops the head.
    front: [0, 0.2, -3.6],
  });
}
