// Reader for the `.m2b` models scripts/export-models.py writes (see its header for why
// the format is ours and not glTF). Deliberately free of any three.js import: this is a
// pure ArrayBuffer -> plain-object decode, so it can be unit-tested under `bun test`
// without a WebGL context, and so the heavy viewer chunk is the only thing that pulls in
// three.
//
// Every array is a VIEW over the caller's buffer, not a copy -- the whole point of the
// binary format. Do not mutate them in place.

export const MAGIC = 0x3142324d; // "M2B1" little-endian
const HEADER = 80;               // 4+2+2+4+4+2*4+24+8*4, 4-byte aligned
const SECTIONS = ["pos", "nrm", "uv", "idx", "sub", "tex", "att", "str"];

/** Texture-unit types. The reason this format exists: which texture a submesh gets is
 *  decided at RUNTIME (per item / race / skin), so the mesh only carries the slot kind. */
export const TEX_EMBEDDED = 0;   // the name in the file is the texture
export const TEX_CHAR_SKIN = 1;  // the composited character body atlas
export const TEX_OBJECT_SKIN = 2; // an item's own texture (ItemDisplayInfo.ModelTexture)
export const TEX_HAIR = 6;

/** Attachment ids, read off the posed body rather than recited: 11 sits centre at 94% of
 *  the model's height, 5/6 are a mirrored pair at 80%, 1/2 another at 42%. */
export const ATTACH = { shield: 0, handRight: 1, handLeft: 2, shoulderRight: 5, shoulderLeft: 6, head: 11 };

/** Tracks bound to a GLOBAL SEQUENCE: they belong to no animation, loop on a clock of
 *  their own, and apply whatever is playing. Blinking is one of these -- a track scaling
 *  the closed-eye mesh up for ~100ms, three times in 6633ms -- so reading them as part of
 *  the played clip blinks at the clip's rate and jumps at its loop. */
function readGlobals(dv, start) {
  const count = dv.getUint16(start, true);
  let b = start + 4;
  const out = [];
  for (let i = 0; i < count; i++) {
    const bone = dv.getUint16(b, true);
    const kind = dv.getUint8(b + 2);                 // 0 trans, 1 rot, 2 scale
    const duration = dv.getUint32(b + 4, true);
    const n = dv.getUint16(b + 8, true);
    b += 12;
    const comps = kind === 1 ? 4 : 3;
    const times = new Uint32Array(n);
    const vals = new Float32Array(n * comps);
    for (let k = 0; k < n; k++) {
      times[k] = dv.getUint32(b, true);
      for (let c = 0; c < comps; c++) vals[k * comps + c] = dv.getFloat32(b + 4 + c * 4, true);
      b += 4 + comps * 4;
    }
    out.push({ bone, kind, duration, track: { times, vals, comps } });
  }
  return out;
}

/** One animation's per-bone tracks. Shared by the model's own section and the sidecar,
 *  which is why the encoding is identical in both. */
function readTracks(dv, start, nBone) {
  let b = start;
  const tracks = [];
  for (let i = 0; i < nBone; i++) {
    const nT = dv.getUint16(b, true);
    const nR = dv.getUint16(b + 2, true);
    const nS = dv.getUint16(b + 4, true);
    b += 8;
    const read = (n, comps) => {
      if (!n) return null;
      const times = new Uint32Array(n);
      const vals = new Float32Array(n * comps);
      for (let k = 0; k < n; k++) {
        times[k] = dv.getUint32(b, true);
        for (let c = 0; c < comps; c++) vals[k * comps + c] = dv.getFloat32(b + 4 + c * 4, true);
        b += 4 + comps * 4;
      }
      return { times, vals, comps };
    };
    tracks.push({ trans: read(nT, 3), rot: read(nR, 4), scale: read(nS, 3) });
  }
  return { tracks, next: b };
}

/** The animation sidecar: every animation a character has, fetched only when someone
 *  asks for one. Sixteen of them inline took a character from 245 KB to 560 KB, paid by
 *  every visitor who only wanted to look at a tabard. */
export function parseAnimPack(buffer) {
  const dv = new DataView(buffer);
  // M2A1 and M2A2 differ in what they LEAVE OUT (global tracks moved into the model),
   // not in layout, and both are on the CDN during a rollout.
  const magic = dv.getUint32(0, true);
  if (magic !== 0x3141324d && magic !== 0x3241324d) throw new Error("not an m2b animation pack");
  const count = dv.getUint16(4, true);
  const nBone = dv.getUint16(6, true);
  const strLen = dv.getUint32(8, true);
  const strAt = 12;
  const name = (o) => {
    let end = strAt + o;
    while (end < strAt + strLen && dv.getUint8(end) !== 0) end++;
    return new TextDecoder("latin1").decode(new Uint8Array(buffer, strAt + o, end - strAt - o));
  };
  let b = strAt + strLen;
  const out = [];
  for (let a = 0; a < count; a++) {
    const id = dv.getUint16(b, true);
    const nameOff = dv.getUint16(b + 2, true);
    const duration = dv.getUint32(b + 4, true);
    b += 8;
    const { tracks, next } = readTracks(dv, b, nBone);
    b = next;
    out.push({ id, name: name(nameOff), duration, tracks });
  }
  return out;
}

export function parseM2B(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < HEADER || dv.getUint32(0, true) !== MAGIC) {
    throw new Error("not an m2b file");
  }
  const version = dv.getUint16(4, true);
  // v2 added the attachment rotation. Refusing v1 outright is deliberate: a stale cached
  // file would otherwise be read with a 32-byte stride over 16-byte records and hang
  // every item off nonsense coordinates, which is far harder to recognise than an error.
  // v2 and v3 differ only in the attachment stride (v3 carries the bone's scale), so both
  // are readable -- which is what lets the character models be re-exported without
  // reshipping every weapon.
  // v2/v3 are RIGID models: vertices baked into Stand frame 0, eight sections. v4 is a
  // RIGGED one -- bind-pose vertices plus a skeleton, per-vertex weights and the Stand
  // animation's keys -- and carries three more sections. The count is implied by the
  // version, so the table is never guessed at.
  // v5 replaced the single inline animation with a LIST -- in the model that list holds
  // only the idle, the rest arriving from the sidecar (parseAnimPack). v6 adds `glb`, the
  // tracks that belong to no animation and run on their own clock (blinking).
  if (version < 2 || version > 6) {
    throw new Error(`m2b version ${version} is not readable (want 2-6)`);
  }
  const flags = dv.getUint16(6, true);
  const nVert = dv.getUint32(8, true);
  const nIdx = dv.getUint32(12, true);
  const nSub = dv.getUint16(16, true);
  const nTex = dv.getUint16(18, true);
  const nAtt = dv.getUint16(20, true);
  const nBone = dv.getUint16(22, true);
  const bbox = [];
  for (let i = 0; i < 6; i++) bbox.push(dv.getFloat32(24 + i * 4, true));
  const off = {};
  const sections = version >= 6 ? [...SECTIONS, "bon", "skn", "anm", "glb"]
    : version >= 4 ? [...SECTIONS, "bon", "skn", "anm"] : SECTIONS;
  sections.forEach((name, i) => { off[name] = dv.getUint32(48 + i * 4, true); });

  const str = (o) => {
    let end = off.str + o;
    while (end < buffer.byteLength && dv.getUint8(end) !== 0) end++;
    return new TextDecoder("latin1").decode(new Uint8Array(buffer, off.str + o, end - off.str - o));
  };

  const textures = [];
  for (let i = 0; i < nTex; i++) {
    const b = off.tex + i * 4;
    textures.push({ type: dv.getUint8(b), wrap: dv.getUint8(b + 1), name: str(dv.getUint16(b + 2, true)) });
  }
  const submeshes = [];
  for (let i = 0; i < nSub; i++) {
    const b = off.sub + i * 16;
    submeshes.push({
      geoset: dv.getUint16(b, true),
      texType: dv.getUint16(b + 2, true),
      first: dv.getUint32(b + 4, true),
      count: dv.getUint32(b + 8, true),
      blend: dv.getUint8(b + 12),
      matFlags: dv.getUint8(b + 13),
      texSlot: dv.getUint8(b + 14),      // 0xFF = the submesh resolved no texture
    });
  }
  // v2 attachments are 32 bytes (id, bone, pos, quat); v3 adds the bone's SCALE, which
  // the client applies -- the shoulder bone is scaled per race, so without it a blood elf
  // wears human-sized pauldrons. Both strides are read so a v2 file still loads.
  const attStride = version >= 3 ? 36 : 32;
  const attachments = [];
  for (let i = 0; i < nAtt; i++) {
    const b = off.att + i * attStride;
    // `pos` is in the model's own space, in the SAME baked pose as the vertices -- not
    // bone-local as the M2 stores it. A helm hung at the bind-pose head is not at the head.
    attachments.push({
      id: dv.getUint16(b, true), bone: dv.getUint16(b + 2, true),
      pos: [dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true), dv.getFloat32(b + 12, true)],
      // Orientation matters as much as position: without it a weapon hangs horizontally
      // beside the hand instead of being gripped by it.
      quat: [dv.getFloat32(b + 16, true), dv.getFloat32(b + 20, true),
        dv.getFloat32(b + 24, true), dv.getFloat32(b + 28, true)],
      scale: version >= 3 ? dv.getFloat32(b + 32, true) || 1 : 1,
    });
  }

  // A rigged model (v4) carries what the browser needs to pose it: the skeleton, the
  // per-vertex weights, and one animation's keys. Everything is optional -- a rigid model
  // simply has none of it, and the viewer renders it exactly as before.
  let bones = null;
  let skin = null;
  let anim = null;
  let anims = [];
  let globals = [];
  if (version >= 4 && nBone) {
    bones = [];
    for (let i = 0; i < nBone; i++) {
      const b = off.bon + i * 16;
      bones.push({
        parent: dv.getInt16(b, true),
        // The pivot is where this bone rotates, which is also its rest position.
        pivot: [dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true), dv.getFloat32(b + 12, true)],
      });
    }
    skin = {
      index: new Uint8Array(buffer, off.skn, nVert * 4 * 2).filter((_, i) => i % 8 < 4),
      weight: new Uint8Array(buffer, off.skn, nVert * 4 * 2).filter((_, i) => i % 8 >= 4),
    };
    // v5 carries a LIST (in practice the idle alone -- the rest arrive from the sidecar,
    // see parseAnimPack). v4 wrote one animation with no count, so the two are read
    // differently: a reader that assumes v5 on a v4 file takes the duration for a count
    // and produces garbage, and both versions are live on the CDN during any rollout.
    const count = version >= 5 ? dv.getUint16(off.anm, true) : 1;
    let b = off.anm + (version >= 5 ? 4 : 0);
    const list = [];
    for (let a = 0; a < count; a++) {
      let id = 0, name = "Stand", duration;
      if (version >= 5) {
        id = dv.getUint16(b, true);
        name = str(dv.getUint16(b + 2, true));
        duration = dv.getUint32(b + 4, true);
        b += 8;
      } else {
        duration = dv.getUint32(b, true);          // v4: duration, bone count, then keys
        b += 8;
      }
      const { tracks, next } = readTracks(dv, b, nBone);
      b = next;
      list.push({ id, name, duration, tracks });
    }
    anim = list[0] || null;
    anims = list;
    if (version >= 6 && off.glb) globals = readGlobals(dv, off.glb, buffer);
  }

  return {
    version, posed: !!(flags & 1), nBone, bbox, bones, skin, anim, anims, globals,
    pos: new Float32Array(buffer, off.pos, nVert * 3),
    nrm: new Float32Array(buffer, off.nrm, nVert * 3),
    uv: new Float32Array(buffer, off.uv, nVert * 2),
    idx: new Uint16Array(buffer, off.idx, nIdx),
    submeshes, textures, attachments,
  };
}

/** Centre + radius of the model, for framing a camera on it. */
export function bounds(model) {
  const [x0, y0, z0, x1, y1, z1] = model.bbox;
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const r = Math.max(x1 - x0, y1 - y0, z1 - z0) / 2 || 1;
  return { center: c, radius: r };
}
