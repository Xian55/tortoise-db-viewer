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

export function parseM2B(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < HEADER || dv.getUint32(0, true) !== MAGIC) {
    throw new Error("not an m2b file");
  }
  const version = dv.getUint16(4, true);
  if (version !== 1) throw new Error(`m2b version ${version} is newer than this reader`);
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
  SECTIONS.forEach((name, i) => { off[name] = dv.getUint32(48 + i * 4, true); });

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
  const attachments = [];
  for (let i = 0; i < nAtt; i++) {
    const b = off.att + i * 16;
    attachments.push({
      id: dv.getUint16(b, true), bone: dv.getUint16(b + 2, true),
      pos: [dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true), dv.getFloat32(b + 12, true)],
    });
  }

  return {
    version, posed: !!(flags & 1), nBone, bbox,
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
