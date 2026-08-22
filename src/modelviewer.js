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
import { parseM2B, bounds, TEX_HAIR, TEX_OBJECT_SKIN } from "./m2b.js";
import { compositeBody, SECTION_REGIONS } from "./charcomposite.js";
import { COMPONENT_REGIONS, applyGear, inPaintOrder, attachedModels } from "./chargear.js";
import { MODELS_BASE } from "./config.js";

// The ONE live viewer. A WebGL context is scarce and is not garbage-collected, so
// mounting a second without dropping the first eventually kills the oldest canvas. The
// registry lives here rather than in a caller because two different pages now mount
// viewers (the item tab and the character sheet), and the router needs a single teardown
// that works whichever one is up -- exposed as window.__mvDestroy so the router can call
// it WITHOUT importing this chunk and paying for three.js on every page.
let active = null;
function register(viewer) {
  if (active && active !== viewer) { try { active.destroy(); } catch { /* already gone */ } }
  active = viewer;
  return viewer;
}
// A mount that has been superseded must NOT reach register(): register() destroys the
// live viewer to make room, so a stale mount finishing last takes the CURRENT one's
// canvas down with it and the page is left blank. The host being detached says the same
// thing -- its page has been re-rendered underneath us -- and costs nothing to check.
function cancelled(el, opts) {
  return !el.isConnected || !!opts.cancelled?.();
}

export function destroyActive() {
  if (!active) return;
  try { active.destroy(); } catch { /* already gone */ }
  active = null;
}
if (typeof window !== "undefined") window.__mvDestroy = destroyActive;

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
// How far the attached models reach from the body's own centre, in the body's space.
// Their meshes are already positioned and rotated, so their world matrices carry the
// answer -- but they have not been added to a rendered scene yet, so the matrix has to
// be updated by hand first.
function attachedRadius(center, attached) {
  if (!attached.length) return 0;
  const c = new THREE.Vector3(center[0], center[1], center[2]);
  const v = new THREE.Vector3();
  let r = 0;
  for (const a of attached) {
    a.mesh.updateMatrixWorld(true);
    const pos = a.mesh.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(a.mesh.matrixWorld);
      r = Math.max(r, v.distanceTo(c));
    }
  }
  return r;
}

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
  if (cancelled(el, opts)) throw new Error("cancelled");
  return register(buildViewer(el, model, slotTex, { label: opts.model, texture: opts.texture || null }));
}

/**
 * The shared scene: geometry, materials, camera, controls and the render scheduling.
 * Both entry points end here -- an item and a character differ only in which model they
 * load, which textures fill its slots, and which geosets are visible.
 *   opts: { label, texture, geosets (Set of visible geoset ids, or null for all) }
 */
/** Geometry + materials for one model, ready to add to a scene. Shared by the character
 *  body and by everything hung off it, so an attached helm is drawn by exactly the same
 *  material rules (blend modes, alpha cutoff) as the item tab uses. */
function meshFor(model, slotTex, { geosets = null, skipEmbedded = false } = {}) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(model.pos, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(model.nrm, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
  geom.setIndex(new THREE.BufferAttribute(model.idx, 1));
  const fallback = slotTex.find((t, i) => t && model.textures[i].type !== 0)
    || slotTex.find(Boolean) || null;
  const materials = [];
  const drawn = [];
  model.submeshes.forEach((sub) => {
    if (!sub.count) return;
    if (geosets && !geosets.has(sub.geoset)) return;
    if (skipEmbedded && sub.texType === 0) return;
    geom.addGroup(sub.first, sub.count, materials.length);
    const map = (sub.texSlot < slotTex.length ? slotTex[sub.texSlot] : null) || fallback;
    materials.push(materialFor(sub, map));
    drawn.push([sub.geoset, sub.texType, sub.blend, map ? 1 : 0]);
  });
  return { mesh: new THREE.Mesh(geom, materials), geom, materials, drawn };
}

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
    // KEEP THE LAST FRAME. This viewer deliberately stops drawing once nothing is moving,
    // and without a preserved buffer the browser is free to clear the canvas after it
    // composites -- so the character appeared for a moment, the idle spin finished, and
    // it vanished. The alternative (render forever) is exactly the battery cost the
    // scheduling exists to avoid.
    preserveDrawingBuffer: true,
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

  const built = meshFor(model, slotTex, { geosets: opts.geosets, skipEmbedded: opts.skipEmbedded });
  const { mesh, geom, materials } = built;
  const drawnSubs = built.drawn;
  const drawn = drawnSubs.length;
  root.add(mesh);

  // Everything hung off the skeleton: helms, shoulder pairs, what is in the hands. The
  // attachment position is in the model's own space and ALREADY POSED (the exporter bakes
  // it through the bone matrices), so the item simply sits at that point in the same root
  // -- no skinning, no bone hierarchy at runtime.
  const attached = [];
  for (const a of (opts.attached || [])) {
    const point = model.attachments.find((at) => at.id === a.attach);
    if (!point) continue;
    const sub = meshFor(a.model, a.slotTex, {});
    sub.mesh.position.set(point.pos[0], point.pos[1], point.pos[2]);
    sub.mesh.quaternion.set(point.quat[0], point.quat[1], point.quat[2], point.quat[3]);
    root.add(sub.mesh);
    attached.push(sub);
    drawnSubs.push(...sub.drawn.map((d) => [`att${a.attach}`, d[1], d[2], d[3]]));
  }

  // Frame on the SOLID body, not the whole bbox: effect planes reach well past the mesh
  // (Thunderfury's lightning quads are wider than the sword), so including them shrinks
  // the item and pushes it off-centre. Same rule render-model-thumbs.py frames by.
  const body = opaqueBounds(model) || bounds(model);
  const center = body.center;
  // What is HELD reaches past the body -- a claymore points out past the fist, a helm's
  // spikes above the head -- so framing the body alone crops them. Framing the union is
  // worse: a weapon reaches ~1.5 body radii, so the CHARACTER then renders at two thirds
  // the size in the same pane, and the character is what the page is about. The widening
  // is capped hard at a tenth, which recovers the helm and lets the weapon overflow.
  const radius = Math.min(attachedRadius(center, attached) || body.radius, body.radius * 1.1);
  const camera = new THREE.PerspectiveCamera(35, width() / height(), radius / 100, radius * 100);
  const target = new THREE.Vector3(center[0], center[2], -center[1]);  // same swap as root
  // A weapon reads best from a three-quarter angle; a character has a front, and showing
  // it in profile makes the face -- the thing the pickers change -- invisible.
  const dir = opts.front || [2.2, 1.1, 2.6];
  camera.position.set(target.x + radius * dir[0], target.y + radius * dir[1], target.z + radius * dir[2]);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  // Panning is on: a dressing room is looked at close up -- the trim on a pauldron, the
  // hem of a robe -- and orbit alone can only circle the centre of the model, so the only
  // way to put a detail in the middle of the screen is to move the target with it.
  controls.enablePan = true;
  controls.screenSpacePanning = true;     // pan up = up the screen, not along the ground
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
    // The key light RIDES THE CAMERA. With it fixed in world space the model is lit from
    // one side only, so turning a character around to look at the back of a cloak showed
    // it in shadow -- the exact thing you rotated to see. Offset up-and-left of the eye
    // so the lighting still has direction rather than going flat.
    key.position.copy(camera.position);
    key.position.y += radius * 1.5;
    key.position.x -= radius * 0.8;
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
  // Measured, not just observed. IntersectionObserver's FIRST callback races layout: on a
  // page whose grid settles after mount it can report "not intersecting" for an element
  // that is plainly on screen, and since the intersection never changes afterwards no
  // second callback arrives to correct it -- the viewer then sleeps forever on a visible
  // canvas. So compute it directly too, and let the observer only update it.
  const onScreen = () => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < (innerHeight || 0);
  };
  visible = onScreen();
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(([e]) => { visible = e.isIntersecting || onScreen(); if (visible) wake(); })
    : null;
  io?.observe(el);
  addEventListener("scroll", onVisibilityCheck, { passive: true });
  const onVisibility = () => { if (!document.hidden) wake(); };
  // Scrolling changes visibility without any other event firing.
  function onVisibilityCheck() {
    const now = onScreen();
    if (now && !visible) { visible = true; wake(); } else if (!now) visible = false;
  }
  document.addEventListener("visibilitychange", onVisibility);

  draw();                                // first frame, so the pane is never blank
  wake();

  const viewer = {
    state: () => ({
      status: "ok", model: opts.label || null, texture: opts.texture || null,
      textured: !!tex, meshes: drawn, triangles: model.idx.length / 3,
      vertices: model.pos.length / 3, frames, spinning: spin,
      running, visible, onScreen: onScreen(),   // false/false = costing nothing right now
      geosets: opts.geosets ? [...opts.geosets].sort((a, b) => a - b) : null,
      cape: opts.cape || null,
      attached: (opts.attached || []).map((a) => ({ attach: a.attach, model: a.label || null })),
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
      removeEventListener("scroll", onVisibilityCheck);
      io?.disconnect();
      ro?.disconnect();
      controls.dispose();
      geom.dispose();
      materials.forEach((m) => m.dispose());
      attached.forEach((a) => { a.geom.dispose(); a.materials.forEach((m) => m.dispose()); });
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
const EAR_GROUP = 7;
const BALD_SCALP = 1;   // geoset 1: the scalp cap worn when no hairstyle is drawn

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
    // Ears are the one group whose default is variant 2, not 1: 701 is the EARLESS head
    // used when a helmet covers them, so defaulting to it leaves a night elf with holes
    // in the sides of her head. Every other group's variant 1 is its bare state.
    const want = group === EAR_GROUP && present.has(group * 100 + 2) ? 2 : 1;
    if (present.has(group * 100 + want)) out.add(group * 100 + want);
  }
  if (hairGeoset) out.add(hairGeoset);
  // A hairstyle carries its own scalp piece under its own geoset id (the texType 1
  // submesh alongside the texType 6 hair). BALD has no such piece: CharHairGeosets gives
  // geoset 0, i.e. no hair mesh at all, and geoset 1 is the cap that closes the top of
  // the skull. Without it the body mesh simply stops below the crown -- a human went
  // scalpless and a troll looked headless, because their bodies end at z 1.93 and 2.12
  // while the head reaches 1.99 and 2.20.
  else if (present.has(BALD_SCALP)) out.add(BALD_SCALP);
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
  // Armor textures ship as a male+female pair OR one unisex file; try this character's
  // sex first, then _u.
  const compUrls = (region, base) => [
    `${MODELS_BASE}comp/${region}/${String(base).toLowerCase()}_${sex}.webp`,
    `${MODELS_BASE}comp/${region}/${String(base).toLowerCase()}_u.webp`,
  ];
  const push = (row, regions) => {
    if (!row) return;
    // A hole in the list is a texture the client does not ship; skip it WITHOUT shifting
    // the ones after it, since the slot index is what decides the rectangle.
    row[2].forEach((tex, i) => {
      if (tex && regions[i]) layers.push({ url: charTexUrl(tex), region: regions[i] });
    });
  };
  push(faceRow, SECTION_REGIONS.face);
  // Push the ROW, never gate on the variation being non-zero: variation 0 is only "none"
  // on the races where it happens to be (human/troll bald). For a gnome or a goblin it is
  // a real hairstyle, and skipping its scalp left the hairline unpainted -- bare skin
  // meeting the hair mesh at a hard edge. A row that paints nothing already carries an
  // empty texture list, so the bald case needs no special case at all.
  push(hairRow, SECTION_REGIONS.hair);                  // scalp/hairline over the face
  push(underRow, SECTION_REGIONS.underwear);
  push(facialRow, SECTION_REGIONS.facial);

  // Worn gear paints over the skin, in the order the pieces overlap in life: a glove
  // covers its bracer, a boot covers the trouser leg, a belt sits over both.
  const worn = inPaintOrder(opts.items || []);
  for (const item of worn) {
    for (const [col, region] of COMPONENT_REGIONS) {
      if (item[col]) layers.push({ urls: compUrls(region, item[col]), region });
    }
  }

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
  // A cloak is the one piece of "armor" that is neither a texture on the body nor a
  // model: it is the character's own cape geoset (15xx), textured from the ITEM. That is
  // what texture-unit type 2 (object skin) means on a character, so binding the body
  // atlas there painted the cape with skin and belt.
  const backItem = worn.find((it) => it.inv === 16 && it.tex_l);
  const capeTex = backItem ? await loadTexture(textureUrl(backItem.tex_l)) : null;

  const slotTex = model.textures.map((t) => {
    if (t.type === TEX_HAIR) return hairTex || body;
    if (t.type === TEX_OBJECT_SKIN) return capeTex || body;
    if (t.name) return null;                       // named; loaded below
    return body;                                   // 1 = character skin
  });
  await Promise.all(model.textures.map(async (t, i) => {
    if (t.type !== TEX_HAIR && t.name) slotTex[i] = await loadTexture(embeddedUrl(t.name));
  }));

  // Fall back to variation 0 when the requested one does not exist for this race. That
  // is not cosmetic tidying: a geoset in groups 1-3 is only "facial hair" on the races
  // that have some. On Turtle's goblins, facial variation 0 maps to geoset 102, which is
  // part of the HEAD -- so a URL naming a variation the goblin does not have (they offer
  // 0-4) added nothing and left the character headless, with its hair floating above an
  // empty neck.
  const hairRows = data.hair[`${race}-${sex}`] || [];
  const facialRows = data.facial[`${race}-${sex}`] || [];
  const hairGeoset = (hairRows.find((h) => h[0] === hairStyle) || hairRows.find((h) => h[0] === 0))?.[1] || 0;
  const facialGeosets = (facialRows.find((f) => f[0] === facialStyle)
    || facialRows.find((f) => f[0] === 0))?.slice(1) || [];

  // Helms, shoulder pairs and held weapons are MODELS, loaded alongside the body. A
  // per-race variant that this race simply does not have is skipped rather than failing
  // the whole character.
  const attached = [];
  await Promise.all(attachedModels(worn, { race, sex }).map(async (a) => {
    try {
      const m = await fetchModel(a.model);
      const st = await Promise.all(m.textures.map((t) => (
        t.type === 0 && t.name
          ? loadTexture(embeddedUrl(t.name))
          : (a.texture ? loadTexture(textureUrl(a.texture)) : Promise.resolve(null))
      )));
      attached.push({ model: m, slotTex: st, attach: a.attach, label: a.model });
    } catch { /* this race has no such variant, or the file was never exported */ }
  }));

  const present = new Set(model.submeshes.map((sm) => sm.geoset));
  if (cancelled(el, opts)) throw new Error("cancelled");
  return register(buildViewer(el, model, slotTex, {
    attached,
    label: `${race}-${sex}`,
    cape: backItem ? { item: backItem.entry, texture: backItem.tex_l, loaded: !!capeTex } : null,
    geosets: applyGear(baseGeosets(model, { hairGeoset, facial: facialGeosets }), worn, present),
    skipEmbedded: true,
    // Straight on: a character model faces WoW +Y, which is -Z after the Y-up swap.
    // The distance is not a taste choice -- `radius` is half the LARGEST dimension, and
    // for an upright figure that is its height, so at a 35 degree FOV anything closer
    // than ~3.2 radii crops the head.
    front: [0, 0.2, -3.6],
  }));
}
