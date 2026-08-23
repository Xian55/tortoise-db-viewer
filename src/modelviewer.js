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
import { parseM2B, parseAnimPack, bounds, TEX_HAIR, TEX_OBJECT_SKIN } from "./m2b.js";
import { compositeBody, SECTION_REGIONS } from "./charcomposite.js";
import { componentLayers, applyGear, inPaintOrder, attachedModels, helmetHidden,
  structuralGeosets } from "./chargear.js";
import { MODELS_BASE, MODELS_V } from "./config.js";

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

const modelUrl = (name) => `${MODELS_BASE}item/${String(name).toLowerCase()}.m2b${MODELS_V}`;
const textureUrl = (name) => `${MODELS_BASE}itemtex/${String(name).toLowerCase()}.webp${MODELS_V}`;

async function fetchModel(name) {
  const res = await fetch(modelUrl(name));
  if (!res.ok) throw new Error(`model ${name} unavailable (${res.status})`);
  return parseM2B(await res.arrayBuffer());
}

// A texture named INSIDE the model keeps its client path (`SPELLS\ZAP1.BLP` ->
// `tex/spells/zap1.webp`), matching what export-models.py wrote.
const embeddedUrl = (name) =>
  `${MODELS_BASE}tex/${String(name).toLowerCase().replace(/\\/g, "/").replace(/\.blp$/, "")}.webp${MODELS_V}`;

// fetch rather than TextureLoader, for the same reason the composite layers use it: a
// miss here is expected (an item whose texture the client never shipped, a race variant
// that does not exist) and a failed image request is logged by the browser as a console
// error. A 404 from fetch is an ordinary response.
async function loadTexture(url) {
  let bitmap;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;            // a missing texture is a grey model, not a crash
    bitmap = await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
  const t = new THREE.Texture(bitmap);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.flipY = false;                       // M2 UVs are top-left origin, like the client
  t.needsUpdate = true;
  return t;
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
// ---------------------------------------------------------------------------
// The rig (v4 models only)
//
// An M2 bone rotates about its PIVOT, and its animation is stored as a delta from the
// bind pose -- which in a vanilla character is the pose the mesh itself is authored in.
// That maps onto three's scene graph exactly: give each bone a rest position of
// `pivot - parentPivot` and its world matrix at rest is a translation to its pivot, so
// the bind inverse is simply a translation back. No inverse-bind matrices to bake, and
// the animation keys drop straight onto bone.position / .quaternion / .scale.
function buildSkeleton(model) {
  const bones = model.bones.map(() => new THREE.Bone());
  const roots = [];
  model.bones.forEach((info, i) => {
    const parent = info.parent;
    const pp = parent >= 0 && parent < model.bones.length ? model.bones[parent].pivot : [0, 0, 0];
    bones[i].position.set(info.pivot[0] - pp[0], info.pivot[1] - pp[1], info.pivot[2] - pp[2]);
    if (parent >= 0 && parent < bones.length) bones[parent].add(bones[i]);
    else roots.push(bones[i]);
  });
  const inverses = model.bones.map((info) =>
    new THREE.Matrix4().makeTranslation(-info.pivot[0], -info.pivot[1], -info.pivot[2]));
  return { skeleton: new THREE.Skeleton(bones, inverses), bones, roots };
}

/** Index of the last key at or before `t`. Linear from a remembered cursor: playback
 *  walks forward, so this is O(1) per bone per frame in practice and needs no search. */
function keyAt(track, t, from) {
  const times = track.times;
  let i = from < times.length && times[from] <= t ? from : 0;
  while (i + 1 < times.length && times[i + 1] <= t) i++;
  return i;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/** Pose one rigged model at `t` milliseconds into its animation. */
/** The tracks that answer to no animation, at wall-clock time `ms`. Applied AFTER the
 *  clip, because poseAt resets a bone with no key of its own to identity -- and these are
 *  exactly the bones the clip says nothing about: the eye-blink scale, and the fixed
 *  rotations a few models express as a degenerate 33ms loop. */
function poseGlobals(model, bones, ms) {          // ms === null -> each track's rest phase
  const g = model.globals;
  for (let i = 0; i < g.length; i++) {
    const { bone, kind, duration, track } = g[i];
    const b = bones[bone];
    if (!b || !track.times.length) continue;
    const t = ms === null ? g[i].rest : duration > 0 ? ms % duration : 0;
    const k = keyAt(track, t, 0);
    const v = track.vals;
    const a = k * track.comps;
    if (kind === 1) {
      _qa.set(v[a], v[a + 1], v[a + 2], v[a + 3]);
      if (k + 1 < track.times.length) {
        const t0 = track.times[k], t1 = track.times[k + 1];
        _qb.set(v[a + 4], v[a + 5], v[a + 6], v[a + 7]);
        _qa.slerp(_qb, t1 > t0 ? (t - t0) / (t1 - t0) : 0);
      }
      b.quaternion.copy(_qa);
    } else if (kind === 2) {
      b.scale.set(v[a], v[a + 1], v[a + 2]);
    } else {
      b.position.x += v[a]; b.position.y += v[a + 1]; b.position.z += v[a + 2];
    }
  }
}

const fin = (v) => (Number.isFinite(v) ? v : 1);   // a missing value, not a zero one

function poseAt(model, bones, cursors, tracks, t) {
  for (let i = 0; i < bones.length; i++) {
    const tr = tracks[i];
    const info = model.bones[i];
    const parent = info.parent;
    const pp = parent >= 0 && parent < model.bones.length ? model.bones[parent].pivot : [0, 0, 0];
    const bone = bones[i];
    // translation: the rest offset plus whatever the track adds
    let tx = info.pivot[0] - pp[0], ty = info.pivot[1] - pp[1], tz = info.pivot[2] - pp[2];
    if (tr.trans) {
      const k = keyAt(tr.trans, t, cursors[i * 3]);
      cursors[i * 3] = k;
      const v = tr.trans.vals;
      const a = k * 3;
      if (k + 1 < tr.trans.times.length) {
        const t0 = tr.trans.times[k], t1 = tr.trans.times[k + 1];
        const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        tx += v[a] + (v[a + 3] - v[a]) * f;
        ty += v[a + 1] + (v[a + 4] - v[a + 1]) * f;
        tz += v[a + 2] + (v[a + 5] - v[a + 2]) * f;
      } else { tx += v[a]; ty += v[a + 1]; tz += v[a + 2]; }
    }
    bone.position.set(tx, ty, tz);
    if (tr.rot) {
      const k = keyAt(tr.rot, t, cursors[i * 3 + 1]);
      cursors[i * 3 + 1] = k;
      const v = tr.rot.vals;
      const a = k * 4;
      _qa.set(v[a], v[a + 1], v[a + 2], v[a + 3]);
      if (k + 1 < tr.rot.times.length) {
        const t0 = tr.rot.times[k], t1 = tr.rot.times[k + 1];
        const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        _qb.set(v[a + 4], v[a + 5], v[a + 6], v[a + 7]);
        _qa.slerp(_qb, f);
      }
      bone.quaternion.copy(_qa);
    } else {
      bone.quaternion.identity();
    }
    if (tr.scale) {
      const k = keyAt(tr.scale, t, cursors[i * 3 + 2]);
      cursors[i * 3 + 2] = k;
      const v = tr.scale.vals;
      const a = k * 3;
      // NOT `v[a] || 1`. A scale of exactly ZERO is how the client hides a mesh it is
      // not using -- a character carries two eyelids, one for blinking and one for
      // sleeping, and holds the spare at scale 0 for the whole animation -- and 0 is
      // falsy, so that guard turned every hidden mesh back to full size. A blood elf
      // male wore a flat quad over his eyes for exactly this reason.
      bone.scale.set(fin(v[a]), fin(v[a + 1]), fin(v[a + 2]));
    } else {
      bone.scale.set(1, 1, 1);
    }
  }
}

function meshFor(model, slotTex, { geosets = null, skipEmbedded = false } = {}) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(model.pos, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(model.nrm, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
  geom.setIndex(new THREE.BufferAttribute(model.idx, 1));
  if (model.skin) {
    // The M2 stores weights as bytes; three wants them normalised, and they must SUM to
    // one or the mesh inflates where the rounding lands.
    const w = new Float32Array(model.skin.weight.length);
    for (let i = 0; i < w.length; i += 4) {
      const sum = (model.skin.weight[i] + model.skin.weight[i + 1]
        + model.skin.weight[i + 2] + model.skin.weight[i + 3]) || 255;
      for (let k = 0; k < 4; k++) w[i + k] = model.skin.weight[i + k] / sum;
    }
    geom.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(model.skin.index), 4));
    geom.setAttribute("skinWeight", new THREE.BufferAttribute(w, 4));
  }
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
  if (model.skin && model.bones) {
    const rig = buildSkeleton(model);
    const mesh = new THREE.SkinnedMesh(geom, materials);
    mesh.add(rig.roots[0] || new THREE.Bone());
    for (const r of rig.roots.slice(1)) mesh.add(r);
    mesh.bind(rig.skeleton);
    return { mesh, geom, materials, drawn, rig };
  }
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
  // updateStyle: FALSE. Left on, three writes the size onto the canvas as an inline
  // width/height in pixels, and an inline style outranks the stylesheet that sizes the
  // canvas to its pane -- so coming back from fullscreen the canvas kept the screen's
  // height, overflowed the room and pushed the page layout apart. The drawing buffer is
  // JS's business; the box on screen is CSS's.
  renderer.setSize(width(), height(), false);
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
  // A rigged model arrives in its BIND pose and is posed here: frame 0 of Stand, which is
  // what a rigid model has baked into its vertices. So "not animating" looks exactly like
  // every model did before the rig existed, and animating simply advances the clock.
  const rig = built.rig || null;
  const cursors = rig ? new Uint16Array(model.bones.length * 3) : null;
  // Which animation is playing. The model ships only the idle; a whole pack arrives from
  // the sidecar the first time someone opens the picker, and swapping is then just a
  // different track list over the same skeleton.
  let clip = model.anim || null;
  let clips = model.anims && model.anims.length ? model.anims : (clip ? [clip] : []);
  // The cursors remember where in each track the last frame landed, so a frame costs a
  // step rather than a search. They are only wrong when time goes BACKWARDS -- the loop
  // wrapping, or a different animation being picked -- so that, and only that, resets them.
  let poseAtMs = -1;
  // Global tracks keep their OWN clock: blinking is 6633ms of eye whatever is playing,
  // which is the whole point of the client binding it to a global sequence rather than to
  // an animation. It only advances while something is being drawn, so a still model does
  // not blink -- the same bargain as the rest of the viewer's idle discipline.
  let globalClock = 0;
  // Animation is OFF unless asked for: the viewer's whole idle discipline is that a
  // preview nobody is looking at costs nothing, and a looping skeleton is the one thing
  // that would draw forever. Declared here rather than beside the loop, because
  // poseTime() reads them and runs during the build, before the loop exists.
  let animating = !!opts.animate;
  let animClock = 0;
  let forcedPhase = null;                // debug only: see globalClock() on the API
  const poseTime = (ms) => {
    if (!rig || !clip) return;
    const t = clip.duration ? ((ms % clip.duration) + clip.duration) % clip.duration : 0;
    if (t < poseAtMs) cursors.fill(0);
    poseAtMs = t;
    poseAt(model, rig.skeleton.bones, cursors, clip.tracks, t);
    // A still model sits at each global track's RESTING value rather than at t=0 -- it is
    // not playing, so it should look like the thing it looks like most of the time.
    if (model.globals?.length) {
      poseGlobals(model, rig.skeleton.bones,
        forcedPhase !== null ? forcedPhase : animating ? globalClock : null);
    }
  };
  poseTime(0);
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
    // The attachment bone's own scale, which the client applies: it is 1.00 on a human
    // male but 0.574 on a blood elf female and 1.600 on a tauren, and that is exactly why
    // one pair of pauldrons looks tiny on a gnome and enormous on a tauren in game.
    // Without it a blood elf wore human-sized shoulders -- reported as "two shoulders",
    // the huge one being ours and the right-sized one the character's own silhouette.
    if (point.scale && point.scale !== 1) sub.mesh.scale.setScalar(point.scale);
    // On a rigged model the item hangs off the BONE, so it follows the animation: the
    // exported position is the offset from that bone's pivot and the bone supplies the
    // rotation and the scale. A rigid model has no skeleton to hang from, so its
    // attachments keep the world placement baked at export time.
    const bone = built.rig?.skeleton.bones[point.bone];
    if (bone) bone.add(sub.mesh); else root.add(sub.mesh);
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
  // NEVER below the body's own radius: attachedRadius measures only what is ATTACHED, so
  // a shield or a helm -- small, and close to the centre -- reported a fraction of the
  // body and pulled the camera right into the character's chest. It can only ever WIDEN
  // the frame, and only by a tenth, past which a weapon overflows instead of the
  // character shrinking.
  const radius = Math.max(body.radius,
    Math.min(attachedRadius(center, attached), body.radius * 1.1));
  const camera = new THREE.PerspectiveCamera(35, width() / height(), radius / 100, radius * 100);
  const target = new THREE.Vector3(center[0], center[2], -center[1]);  // same swap as root
  const homeTarget = target.clone();          // the model's centre, before any restore
  let homeOffset = null;                     // and the camera's opening offset from it
  // A weapon reads best from a three-quarter angle; a character has a front, and showing
  // it in profile makes the face -- the thing the pickers change -- invisible.
  const dir = opts.front || [2.2, 1.1, 2.6];
  camera.position.set(target.x + radius * dir[0], target.y + radius * dir[1], target.z + radius * dir[2]);

  // A saved view from the PREVIOUS viewer, if the caller kept one. Every equip and every
  // appearance change builds a new viewer, and without this the model snapped back to
  // three-quarters-front each time -- so comparing two hair colours from behind meant
  // dragging the character round again after every click.
  //
  // Stored in units of the model's own radius and relative to its centre, never as raw
  // world coordinates: the next model is a different size (a gnome after a tauren), and
  // absolute numbers would put the camera inside its head.
  if (opts.view) {
    const v = opts.view;
    target.add(new THREE.Vector3(...v.tgt).multiplyScalar(radius));
    camera.position.copy(target).add(new THREE.Vector3(...v.off).multiplyScalar(radius));
    root.rotation.z = v.spin;
  }
  homeOffset = camera.position.clone().sub(homeTarget);
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
  controls.saveState();                  // the opening view, for reset()

  // Idles gently until the visitor takes over -- EXCEPT where the caller says not to.
  // A dressing room opens on a character facing the visitor and holding still: the whole
  // page is about what the outfit looks like from the front, and a model that turns away
  // on its own has to be caught and dragged back.
  let spin = opts.spin !== false;
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
  const render = () => {
    // The key light RIDES THE CAMERA. With it fixed in world space the model is lit from
    // one side only, so turning a character around to look at the back of a cloak showed
    // it in shadow -- the exact thing you rotated to see. Offset up-and-left of the eye
    // so the lighting still has direction rather than going flat.
    key.position.copy(camera.position);
    key.position.y += radius * 1.5;
    key.position.x -= radius * 0.8;
    renderer.render(scene, camera);
    frames++;
  };
  const draw = () => { const changed = controls.update(); render(); return changed; };

  // Rotation is per SECOND, not per frame: the draw rate is throttled below, and a
  // frame-based step silently turns "one revolution" into two different durations on a
  // 30 fps and a 60 fps machine (measured: a 17s turn became 35s once throttled).
  const SPIN_RATE = (Math.PI * 2) / 17;  // rad/s -> one full turn in 17 seconds
  // A frame that shows the same pose as the last one is pure cost, and a mover that
  // advances on some frames and not others is what judder IS. So the frame budget is the
  // step: every frame drawn advances the movers, and every step is drawn.
  //
  // The two movers want different budgets. A turntable at 17s per revolution is 0.37 deg
  // per 30fps frame -- no eye can see the difference at 60 -- so it halves its own cost.
  // A dance is motion the eye tracks, where 30fps reads as a stutter, so it takes the
  // display's own rate and pays for it with the pose maths, which is the cheap half.
  const SPIN_MS = 1000 / 30;
  const ANIM_MS = 1000 / 60;
  // Vsync does not land on exact multiples, so a frame arriving a hair early must count as
  // due -- without the slack a 60Hz display alternates 2 and 3 vsyncs per step, which is
  // the very judder this is here to remove.
  const SLACK = 3;
  // What the machine can actually HOLD, measured as the gap between frames that were
  // drawn -- not as the cost of the render call, which on any real driver returns long
  // before the GPU has finished and so reports a fast machine on a slow one. A machine
  // that misses the 60fps budget produces random frame times, which reads as worse stutter
  // than an honest steady 30, so it is stepped down to 30 and the pacing stays even.
  // Recovery is a periodic retry rather than a second threshold: at 30fps nothing can be
  // observed about whether 60 would hold now, and the thing that made it slow (another
  // tab, a thermal dip) does go away.
  let gapEma = 0;
  let retryAt = 0;
  let animMs = ANIM_MS;

  const tick = (now) => {
    if (!alive) { running = false; return; }
    if (!visible || document.hidden) { running = false; return; }   // sleep until woken
    // The idle spin exists to show the model from every side, so it stops after one full
    // revolution instead of turning forever: a preview nobody is looking at should end
    // up costing exactly nothing, and any interaction wakes it again anyway.
    // ONE clock for both movers. Each used to take `last` for itself, so with the
    // animation running it claimed the elapsed time first and the turntable's dt came out
    // as zero on every frame -- Rotate lit up and the model did not turn.
    let step = false;
    // Damping and a live drag must stay responsive whatever the movers are doing, so the
    // camera is updated first and a frame it changed is always drawn.
    const moved = controls.update();
    const due = !last || now - last >= (animating ? animMs : SPIN_MS) - SLACK;
    if (!due && !moved) { raf = requestAnimationFrame(tick); return; }   // nothing new
    const dt = due && last ? Math.min((now - last) / 1000, 0.25) : 0;  // clamp: a
    if (due && last && animating) {                 // backgrounded tab returns a huge dt
      const gap = Math.min(now - last, 250);
      gapEma = gapEma ? gapEma * 0.9 + gap * 0.1 : gap;
      if (animMs === ANIM_MS && gapEma > 24) { animMs = SPIN_MS; gapEma = 0; retryAt = now + 5000; }
      else if (animMs === SPIN_MS && now >= retryAt) { animMs = ANIM_MS; gapEma = 0; }
    }
    if (due) last = now;
    if (animating && rig && due) {
      // Wall-clock, not a frame counter: the draw rate depends on the display and the
      // budget above, and a per-frame step would run the loop at a different speed on a
      // 30 and a 60 fps machine.
      animClock += dt * 1000;
      globalClock += dt * 1000;
      poseTime(animClock);
      step = true;
    }
    if (spin && due) {
      root.rotation.z += SPIN_RATE * dt;
      spun += SPIN_RATE * dt;
      // One revolution and stop -- unless the caller asked for a turntable, in which
      // case it keeps going until it is switched off.
      if (spun >= Math.PI * 2 && !opts.keepSpinning) spin = false;
      step = true;
    }
    render();
    if (spin || animating || moved || step) raf = requestAnimationFrame(tick);
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
    renderer.setSize(width(), height(), false);
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
      rigged: !!rig, animating, animMs: clip ? clip.duration : 0,
      globals: model.globals?.length || 0,
      frameGap: Math.round(gapEma * 10) / 10, fpsTarget: Math.round(1000 / animMs),
      clip: clip ? clip.name : null, clipCount: clips.length,
      running, visible, onScreen: onScreen(),   // false/false = costing nothing right now
      geosets: opts.geosets ? [...opts.geosets].sort((a, b) => a - b) : null,
      cape: opts.cape || null,
      attached: attached.map((sub, i) => ({
        attach: (opts.attached || [])[i]?.attach,
        model: (opts.attached || [])[i]?.label || null,
        // The scale actually APPLIED, not the one in the file: on a rigid model that is
        // the baked attachment scale, on a rigged one it comes from the bone the item
        // hangs off. Either way it is what decides whether a tauren's pauldrons dwarf a
        // gnome's, so that is what the state reports.
        scale: +sub.mesh.getWorldScale(new THREE.Vector3()).x.toFixed(3),
      })),
      // [geoset, texType, blend, hasTexture] per drawn submesh -- what actually
      // reached the GPU, which is the only way to tell "filtered out" from
      // "drawn but invisible".
      drawn: drawnSubs,
    }),
    /** Render and read back in ONE tick. A WebGL canvas is blank to toDataURL() unless
     *  it is read in the same frame as the draw, and paying preserveDrawingBuffer
     *  forever to avoid that would cost every visitor for one smoke test. */
    /** A PNG of the current frame. The canvas itself is ALWAYS transparent (the clear
     *  alpha is 0 and the pane's backdrop is CSS), so a transparent shot is the raw
     *  canvas and an opaque one has to be composited -- not the other way round. */
    snapshot: (opts2 = {}) => {
      renderer.render(scene, camera);
      const src = renderer.domElement;
      if (!opts2.background) return src.toDataURL("image/png");
      const out = document.createElement("canvas");
      out.width = src.width; out.height = src.height;
      const ctx = out.getContext("2d");
      // The same vertical gradient the pane paints, so a saved shot looks like what was
      // on screen rather than like a different page.
      const g = ctx.createLinearGradient(0, 0, 0, out.height);
      g.addColorStop(0, "#181b23");
      g.addColorStop(1, "#0b0c10");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, 0, 0);
      return out.toDataURL("image/png");
    },
    /** The camera as the NEXT viewer can restore it: an offset from the target and a
     *  target offset from the model's centre, both in units of this model's radius, plus
     *  how far the model has been turned. Sizes and centres differ between models, so
     *  nothing here may be an absolute world coordinate. */
    view: () => {
      // SETTLE FIRST. Damping means the camera is still coasting for about a second after
      // a drag, so reading it mid-decay hands the next viewer a position the old one was
      // never going to rest at -- the model shifted a little on every equip, and CI (a
      // slower machine, sampled sooner) saw ~0.4 radii of it. With damping off, update()
      // applies what is left and zeroes it; this viewer is being replaced anyway.
      const damped = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damped;
      return {
        off: camera.position.clone().sub(controls.target).divideScalar(radius).toArray(),
        tgt: controls.target.clone().sub(homeTarget).divideScalar(radius).toArray(),
        spin: root.rotation.z,
      };
    },
    /** Put the camera and the model back where they started -- the straight-on view the
     *  room opens with. Cheaper and less surprising than re-mounting the whole viewer,
     *  which would refetch every texture to achieve the same thing. */
    reset: () => {
      // controls.reset() rather than writing camera.position: OrbitControls keeps its own
      // spherical state, and moving the camera behind its back leaves that state holding
      // the old rotation. And damping OFF across the call, because it also keeps the
      // leftover delta from the drag and applies a decaying fraction of it for about a
      // second -- measured: the view landed home and then slid 0.4 radii off it. Order
      // matters: update() must run BEFORE reset(), because with damping off it applies
      // the leftover delta in full and then zeroes it, and applying it AFTER the restore
      // just moves the camera off the view it had restored (measured 6 degrees off).
      const damped = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();          // consume the leftover delta -- with damping off,
      controls.reset();           // update() zeroes it instead of decaying it
      controls.enableDamping = damped;
      root.rotation.z = 0;
      wake();
    },
    resize: onResize,
    /** Every animation this model can play, in the order the exporter picked them. */
    clips: () => clips.map((c, i) => ({ i, id: c.id, name: c.name, ms: c.duration })),
    /** Which one is playing. */
    clipIndex: () => Math.max(0, clips.indexOf(clip)),
    /** Hand the viewer the sidecar's animations (see parseAnimPack). Keeps whatever is
     *  playing selected by NAME, so loading the pack mid-idle does not jump the pose. */
    setClips: (list) => {
      if (!list?.length) return;
      const wanted = clip?.name;
      clips = list;
      clip = clips.find((c) => c.name === wanted) || clips[0];
      cursors?.fill(0); poseAtMs = -1;
      animClock = 0;
      poseTime(0);
      if (!animating) draw();
    },
    /** Switch animation. Playing continues; paused re-poses on the new clip's frame 0. */
    setClip: (i) => {
      const next = clips[i];
      if (!next) return false;
      clip = next;
      cursors?.fill(0); poseAtMs = -1;
      animClock = 0;
      poseTime(0);
      if (animating) wake(); else draw();
      return true;
    },
    /** Debug: drive the global-sequence clock by hand (blinking is one of these), so a
     *  test can look at a phase instead of waiting 6.6s to catch a 100ms event. */
    globalClock: (ms) => {
      forcedPhase = ms;                  // overrides the resting phase a still model uses
      globalClock = ms;
      poseTime(animClock);
      draw();
    },
    /** Play or pause the idle animation. Returns the new state. */
    animate: (on) => {
      animating = !!on && !!rig;
      gapEma = 0; animMs = ANIM_MS; retryAt = 0;
      if (!animating) { animClock = 0; poseTime(0); draw(); }
      else wake();
      return animating;
    },
    /** Whether this model can be animated at all -- a weapon cannot. */
    get rigged() { return !!rig; },
    /** Turn the turntable on or off. Returns the new state, so a caller can drive a
     *  toggle button from it without keeping its own copy. */
    spin: (on) => {
      spin = !!on;
      spun = 0;
      opts.keepSpinning = !!on;
      if (on) wake();
      return spin;
    },
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
  hook.view = viewer.view;               // so a test can read the camera, like snapshot
  hook.reset = viewer.reset;
  hook.animate = viewer.animate;
  hook.clips = viewer.clips;
  hook.setClip = viewer.setClip;
  hook.setClips = viewer.setClips;
  hook.globalClock = viewer.globalClock;
  hook.bodyAtlas = () => (lastBodyAtlas ? lastBodyAtlas.toDataURL("image/png") : null);
  hook.clipIndex = viewer.clipIndex;
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
// The last body atlas composited, for debugging what a mesh is actually sampling. A
// character's skin is painted from ten rectangles and the client ships none of the result,
// so "is that a closed eyelid or the face texture" is otherwise unanswerable from outside.
let lastBodyAtlas = null;

const animPacks = new Map();

/** Every animation for one character model, fetched once and shared. Kept out of the
 *  model file on purpose: sixteen animations inline more than doubled a character's
 *  download, and most visitors never press play. */
export function characterAnimations(race, sex) {
  const key = `${race}-${sex}`;
  if (!animPacks.has(key)) {
    animPacks.set(key, fetch(`${MODELS_BASE}char/${key}.anm${MODELS_V}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`no animations (${r.status})`))))
      .then(parseAnimPack)
      .catch((e) => { animPacks.delete(key); throw e; }));
  }
  return animPacks.get(key);
}

export function charAppearance() {
  if (!charDataPromise) {
    charDataPromise = fetch(`${MODELS_BASE}char-appearance.json${MODELS_V}`)
      .then((r) => { if (!r.ok) throw new Error(`char-appearance.json (${r.status})`); return r.json(); })
      .catch((e) => { charDataPromise = null; throw e; });
  }
  return charDataPromise;
}

const charTexUrl = (name) =>
  `${MODELS_BASE}chartex/${String(name).toLowerCase().replace(/\\/g, "/").replace(/\.blp$/, "")}.webp${MODELS_V}`;

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
// Groups 1-3 belong to the FACIAL selection, not to the naked body: whatever the chosen
// style names is what shows, and a style that names nothing means nothing. Left in the
// default pass they got a variant-1 piece as well, so two were drawn at once and the
// picker looked broken -- a troll wore tusk variant 1 whatever you chose, and a human male
// could not shave.
const NOT_BODY_GROUPS = new Set([1, 2, 3]);
// CharacterFacialHairStyles' three geoset columns, in the groups they actually address.
const FACIAL_GROUP_ORDER = [1, 3, 2];
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
/** Which group 1-3 geosets on this race are actual facial HAIR: the ones whose variation
 *  paints a texture. Everything else in those groups is head geometry that a helm's beard
 *  mask must leave alone -- goblin head shapes, troll tusks. */
function beardedGeosets(data, race, sex, model) {
  const painted = new Set((data.sections[`${race}-${sex}-facial`] || [])
    .filter((r) => r[2].length).map((r) => r[0]));
  const out = new Set();
  for (const row of data.facial[`${race}-${sex}`] || []) {
    if (!painted.has(row[0])) continue;
    row.slice(1).forEach((v, i) => { if (v) out.add(FACIAL_GROUP_ORDER[i] * 100 + v); });
  }
  // ...minus the ones that are the head itself. A goblin's head shape paints a texture
  // exactly as a beard does, so it passes the art test and a hood deleted his face.
  for (const g of structuralGeosets(model)) out.delete(g);
  return out;
}

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
  // Facial hair lives in groups 1/2/3, but the THREE COLUMNS OF CharacterFacialHairStyles
  // ARE NOT IN GROUP ORDER: they are groups 1, 3, 2. Read in order, a troll's tusks
  // (column 1) became geoset 2xx -- which no troll model contains, so trolls had no tusks
  // at all while the picker cheerfully offered fourteen styles of nothing. Scored the six
  // possible orders against every model's actual geosets: this one resolves 240 of 286
  // references, the next best 165, and in-order only 146. The remainder are styles naming
  // art their model does not ship (dwarf males reference 2xx and carry none); the client
  // skips those too, and so does `out` -- only geosets the mesh has are ever drawn.
  facial.forEach((v, i) => {
    if (v && FACIAL_GROUP_ORDER[i]) out.add(FACIAL_GROUP_ORDER[i] * 100 + v);
  });
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

  const res = await fetch(`${MODELS_BASE}char/${race}-${sex}.m2b${MODELS_V}`);
  if (!res.ok) throw new Error(`character ${race}-${sex} unavailable (${res.status})`);
  const model = parseM2B(await res.arrayBuffer());

  // The body atlas, painted in the client's own order: skin, then the face, then
  // underwear over it.
  const skinRow = section(data, race, sex, "skin", 0, skin);
  const faceRow = section(data, race, sex, "face", face, skin);
  const underRow = section(data, race, sex, "underwear", 0, skin);
  // The paint is chosen INDEPENDENTLY of the geoset where a race allows it (see
  // main.js FACIAL_SPLIT): a troll picks a tusk shape and a war paint separately, and one
  // index cannot express that. Callers that do not split pass the same value for both.
  const paintStyle = opts.facePaint ?? facialStyle;
  const facialRow = section(data, race, sex, "facial", paintStyle, hairColor);
  const hairRow = section(data, race, sex, "hair", hairStyle, hairColor);

  const layers = [];
  // Armor textures ship as a male+female pair OR one unisex file; try this character's
  // sex first, then _u.
  const compUrls = (region, base) => [
    `${MODELS_BASE}comp/${region}/${String(base).toLowerCase()}_${sex}.webp${MODELS_V}`,
    `${MODELS_BASE}comp/${region}/${String(base).toLowerCase()}_u.webp${MODELS_V}`,
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
    // Only the regions this slot actually paints -- see componentLayers(): a tier row
    // carries the whole set's textures, and a glove that painted a torso was the result.
    for (const [col, region] of componentLayers(item)) {
      if (item[col]) layers.push({ urls: compUrls(region, item[col]), region });
    }
  }

  const canvas = await compositeBody({
    base: skinRow?.[2]?.[0] ? charTexUrl(skinRow[2][0]) : null,
    layers,
  });
  lastBodyAtlas = canvas;                // debug: __mv.bodyAtlas() dumps what was painted
  const body = new THREE.CanvasTexture(canvas);
  body.colorSpace = THREE.SRGBColorSpace;
  body.flipY = false;

  // The hairstyle's own texture is a separate slot (texType 6) -- it is not part of the
  // body atlas, which is why a hairless mannequin is what you get if it is skipped.
  // A tauren names the SAME mane texture for every hairstyle and leaves the slot empty on
  // some of them, so fall back to whatever the race does name rather than dropping the
  // mane's texture on those variations. For a human the chosen row always carries its own.
  const maneName = hairRow?.[2]?.[0]
    || (data.sections[`${race}-${sex}-hair`] || []).map((r) => r[2]?.[0]).find(Boolean);
  const hairTex = maneName ? await loadTexture(charTexUrl(maneName)) : null;

  // A tauren's unnamed type-8 unit is a SECOND FULL ATLAS: its meshes carry atlas UVs
  // spanning the whole sheet (the mane samples the torso/leg columns), which is why the
  // body atlas painted a face onto them and why handing them the mane sheet stretched one
  // 128x64 piece flat across the horns. The client ships that atlas per skin colour as
  // `<skin>_Extra.blp` -- 17 files, and tauren are the only race that has any, exactly the
  // race that has the unnamed unit.
  //
  // Only every third skin index carries one (male 0,3,6..., female 0,2,4...), so a colour
  // without its own takes the nearest one BELOW it, which is the group it belongs to. The
  // probe is a load attempt rather than a HEAD request: the dev server answers a missing
  // file with index.html at 200, so only an actual decode failure tells the truth.
  const extraFor = async (skinPath) => {
    if (!skinPath) return null;
    const m = /^(.*?)(\d+)(\.blp)$/i.exec(skinPath);
    if (!m) return null;
    for (let i = Number(m[2]); i >= 0; i--) {
      const name = `${m[1]}${String(i).padStart(m[2].length, "0")}_Extra.blp`;
      const tex = await loadTexture(charTexUrl(name));
      if (tex) return tex;
    }
    return null;
  };
  const wantsExtra = model.textures.some((t) => !t.name && (t.type === 7 || t.type === 8));
  const maneTex = wantsExtra ? await extraFor(skinRow?.[2]?.[0]) : null;

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

  // A tauren has NO texType 6 unit at all: its mane and beards hang off an UNNAMED type 8
  // (measured -- it is the only race that does, everyone else's type 8 names its own file
  // for an eye glow). Falling through to the body atlas painted those meshes from the
  // atlas's face rectangle, so a tauren wore a second, smeared copy of its own face above
  // the horns. An unnamed 7/8 on a character is the hair texture.
  const isManeSlot = (t) => t.type === TEX_HAIR || (!t.name && (t.type === 7 || t.type === 8));
  const slotTex = model.textures.map((t) => {
    if (t.type === TEX_HAIR) return hairTex || body;
    if (isManeSlot(t)) return maneTex || body;     // the second atlas, or plain skin
    if (t.type === TEX_OBJECT_SKIN) return capeTex || body;
    if (t.name) return null;                       // named; loaded below
    return body;                                   // 1 = character skin
  });
  await Promise.all(model.textures.map(async (t, i) => {
    if (!isManeSlot(t) && t.name) slotTex[i] = await loadTexture(embeddedUrl(t.name));
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
    // Forwarded, not dropped: buildViewer gets a fresh options object, so anything the
    // CALLER set for the viewer has to be carried across by name. The turntable state
    // silently fell in this gap -- a room that asked for a still model still span.
    spin: opts.spin, keepSpinning: opts.keepSpinning, view: opts.view, animate: opts.animate,
    attached,
    label: `${race}-${sex}`,
    cape: backItem ? { item: backItem.entry, texture: backItem.tex_l, loaded: !!capeTex } : null,
    geosets: helmetHidden(worn.find((it) => it.inv === 1), sex, data.helmVis,
      applyGear(baseGeosets(model, { hairGeoset, facial: facialGeosets }), worn, present),
      beardedGeosets(data, race, sex, model)),
    skipEmbedded: true,
    // Straight on, and the axis was MEASURED rather than recalled: a character model is
    // symmetric across Y (the human male spans y -0.54..0.54 but x -0.49..0.33), so Y is
    // left-right and the figure faces along X -- toes and face both lie on +X. The camera
    // therefore sits on +X, which the Y-up swap leaves as +x. The old vector put it on
    // -Z, i.e. beside the character: every visitor got a profile view on load, which only
    // looked right while the idle spin happened to be carrying the model past the front.
    // The distance is not a taste choice -- `radius` is half the LARGEST dimension, and
    // for an upright figure that is its height, so at a 35 degree FOV anything closer
    // than ~3.2 radii crops the head.
    front: [3.6, 0.2, 0],
  }));
}
