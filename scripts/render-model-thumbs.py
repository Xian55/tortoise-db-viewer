#!/usr/bin/env python
"""LOCAL: render static creature preview thumbnails for the display_ids Wowhead
lacks (Turtle-custom models). Reads the client MPQs (StormLib), resolves each
display_id -> vanilla M2 (v256) model + skin textures, renders it headlessly with
moderngl to a transparent 300x300 webp.

  build-db  ->  probe-wowhead-thumbs.mjs (worklist)  ->  THIS  ->  build-atlas? no
  output: public/model-thumbs/<displayId>.webp  (committed like maps; R2-synced)

Usage:
  python scripts/render-model-thumbs.py --inspect 21258     # parse + print, no render
  python scripts/render-model-thumbs.py --only 21258         # render one
  python scripts/render-model-thumbs.py                      # render the whole worklist
  python scripts/render-model-thumbs.py --limit 20 --force

Env: TW_CLIENT (F:/Game/Turtle WoW), STORMLIB (StormLib.dll path).
Deps: pip install moderngl numpy pillow
"""
import os, sys, struct, json, math, ctypes as C
from io import BytesIO

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
DATA = os.path.join(CLIENT, "Data")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
OUT_DIR = os.path.join(ROOT, "public", "model-thumbs")
WORKLIST = os.path.join(ROOT, "scripts", "data", "model-thumb-missing.json")
SIZE = 300

ARCHIVE_ORDER = [
    "base.MPQ", "dbc.MPQ", "misc.MPQ", "model.MPQ", "texture.MPQ",
    "interface.MPQ", "fonts.MPQ", "backup.MPQ",
    "patch.MPQ", "patch-2.MPQ", "patch-3.mpq", "patch-4.mpq", "patch-5.mpq",
    "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]

# ---------------------------------------------------------------------------
class Storm:
    def __init__(self, dll):
        if not os.path.exists(dll):
            sys.exit(f"StormLib.dll not found: {dll}\nSet STORMLIB env var.")
        d = C.WinDLL(dll)
        d.SFileOpenArchive.argtypes = [C.c_wchar_p, C.c_uint32, C.c_uint32, C.POINTER(C.c_void_p)]; d.SFileOpenArchive.restype = C.c_int
        d.SFileOpenFileEx.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32, C.POINTER(C.c_void_p)]; d.SFileOpenFileEx.restype = C.c_int
        d.SFileGetFileSize.argtypes = [C.c_void_p, C.POINTER(C.c_uint32)]; d.SFileGetFileSize.restype = C.c_uint32
        d.SFileReadFile.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.POINTER(C.c_uint32), C.c_void_p]; d.SFileReadFile.restype = C.c_int
        d.SFileCloseFile.argtypes = [C.c_void_p]
        self.d = d
        self.handles = []
        for arc in ARCHIVE_ORDER:
            p = os.path.join(DATA, arc)
            if os.path.exists(p):
                h = C.c_void_p()
                if d.SFileOpenArchive(p, 0, 0x100, C.byref(h)):
                    self.handles.append(h)
        if not self.handles:
            sys.exit(f"no MPQs opened under {DATA}")

    def read(self, name):
        b = name.encode("latin1")
        for h in reversed(self.handles):
            hf = C.c_void_p()
            if not self.d.SFileOpenFileEx(h, b, 0, C.byref(hf)):
                continue
            sz = self.d.SFileGetFileSize(hf, None)
            if sz in (0, 0xFFFFFFFF):
                self.d.SFileCloseFile(hf); continue
            buf = (C.c_char * sz)(); rd = C.c_uint32()
            self.d.SFileReadFile(hf, buf, sz, C.byref(rd), None)
            self.d.SFileCloseFile(hf)
            return bytes(buf[: rd.value])
        return None


def load_dbc(data):
    magic, rec, fields, recsize, strsize = struct.unpack_from("<4sIIII", data, 0)
    if magic != b"WDBC":
        sys.exit("bad DBC magic")
    base = 20; strbase = base + rec * recsize
    def s(off):
        if not off or strbase + off >= len(data):
            return ""
        end = data.index(b"\0", strbase + off)
        return data[strbase + off:end].decode("latin1")
    rows = [[struct.unpack_from("<I", data, base + r * recsize + 4 * i)[0] for i in range(fields)] for r in range(rec)]
    return rows, s

# ---------------------------------------------------------------------------
# Vanilla M2 (MD20 v256/257): views + skin data are EMBEDDED (no .skin file).
def arr(data, off):
    n, o = struct.unpack_from("<II", data, off)
    return n, o

# header M2Array offsets (verified against the Turtle 1.12 client; see --inspect)
# Vanilla v256 header M2Array offsets (sequential layout, verified vs wow.export's
# M2LegacyLoader). Note the vanilla-only texture_flipbooks field at 0x6C shifts
# everything after it: materials land at 0x84, texture_combos at 0x94.
H_VERTICES  = 0x44
H_VIEWS     = 0x4C
H_TEXTURES  = 0x5C
H_MATERIALS = 0x84   # materials/render-flags: {uint16 flags, uint16 blendingMode}
H_TEXLOOK   = 0x94   # texture_combos (uint16 -> textures[])

H_BONES = 0x34

def _track(data, toff):
    """Parse a vanilla M2Track header: interpolation type, per-animation key
    ranges, and the timestamps/values M2Arrays (offsets kept for lazy sampling)."""
    interp = struct.unpack_from("<H", data, toff)[0]
    n_r, o_r = arr(data, toff + 4)      # interpolation ranges (one M2Range per anim)
    n_t, o_t = arr(data, toff + 12)     # timestamps (uint32)
    n_v, o_v = arr(data, toff + 20)     # values
    ranges = [struct.unpack_from("<II", data, o_r + i * 8) for i in range(n_r)]
    return dict(ranges=ranges, n_t=n_t, o_t=o_t, n_v=n_v, o_v=o_v)


def sample_track(data, tr, comps, anim, tfrac, default):
    """Value of a track for animation index `anim` at normalized time `tfrac`
    (0..1). Uses the per-animation key range; linear-interpolates between keys.
    Returns `default` if the track has no keys."""
    nv = tr["n_v"]
    if nv == 0:
        return default
    s, e = 0, nv - 1
    if anim < len(tr["ranges"]):
        s, e = tr["ranges"][anim]
    e = min(e, nv - 1); s = min(max(s, 0), e)

    def val(i):
        return struct.unpack_from("<%df" % comps, data, tr["o_v"] + i * comps * 4)
    if s == e or tr["n_t"] == 0:
        return val(s)

    def ts(i):
        return struct.unpack_from("<I", data, tr["o_t"] + i * 4)[0]
    t0, t1 = ts(s), ts(e)
    if t1 <= t0:
        return val(s)
    t = t0 + tfrac * (t1 - t0)
    lo = s
    for i in range(s, e):
        if ts(i) <= t <= ts(i + 1):
            lo = i; break
    else:
        return val(e)
    a0, a1 = ts(lo), ts(lo + 1)
    al = (t - a0) / (a1 - a0) if a1 > a0 else 0.0
    v0, v1 = val(lo), val(lo + 1)
    return tuple(v0[k] + (v1[k] - v0[k]) * al for k in range(comps))


def parse_m2(data):
    if data[:4] != b"MD20":
        raise ValueError("not MD20")
    ver = struct.unpack_from("<I", data, 4)[0]
    nAnim, oAnim = arr(data, 0x1C)
    nBone, oBone = arr(data, H_BONES)
    nVert, oVert = arr(data, H_VERTICES)
    nView, oView = arr(data, H_VIEWS)
    nTex, oTex = arr(data, H_TEXTURES)
    nTexLook, oTexLook = arr(data, H_TEXLOOK)

    # animations (vanilla AnimationSequence, 68 bytes): [0] uint16 animationID
    # (0 = Stand/idle), [1] uint16 subId. Find the first Stand sequence index so
    # we can pose on the idle animation regardless of its position in the list.
    stand_idx = 0
    for i in range(nAnim):
        aid = struct.unpack_from("<H", data, oAnim + i * 68)[0]
        if aid == 0:
            stand_idx = i
            break

    # bones (vanilla M2CompBone, 108 bytes): keyBoneId(4) flags(4) parent(i16,@8)
    # unk(2) trans-track(@12) rot-track(@40) scale-track(@68) pivot(3f,@96).
    bones = []
    for i in range(nBone):
        o = oBone + i * 108
        parent = struct.unpack_from("<h", data, o + 8)[0]
        pivot = struct.unpack_from("<3f", data, o + 96)
        bones.append(dict(parent=parent, pivot=pivot,
                          ttrans=_track(data, o + 12), trot=_track(data, o + 40),
                          tscale=_track(data, o + 68)))

    # vertices: 48 bytes -> pos(3f) boneWeights(4B,@12) boneIndices(4B,@16)
    # normal(3f,@20) uv(2f,@32) [2f]
    verts = []
    weights = []
    boneidx = []
    for i in range(nVert):
        o = oVert + i * 48
        px, py, pz = struct.unpack_from("<3f", data, o)
        w = struct.unpack_from("<4B", data, o + 12)
        bi = struct.unpack_from("<4B", data, o + 16)
        nx, ny, nz = struct.unpack_from("<3f", data, o + 20)
        u, v = struct.unpack_from("<2f", data, o + 32)
        verts.append((px, py, pz, nx, ny, nz, u, v))
        weights.append(w)
        boneidx.append(bi)

    # view[0]
    vb = oView
    nIndex, oIndex = arr(data, vb + 0)
    nTris, oTris = arr(data, vb + 8)
    nSub, oSub = arr(data, vb + 24)
    nTU, oTU = arr(data, vb + 32)
    indices = list(struct.unpack_from("<%dH" % nIndex, data, oIndex))
    tris = list(struct.unpack_from("<%dH" % nTris, data, oTris))

    # submeshes (vanilla SkinSection, 32 bytes): [meshPartId, pad, startVertex,
    # nVertex, startTriangle, nTriangle, nBone, startBone, ...]. start/nTriangle
    # index the view's `tris` array (3 entries per triangle).
    subs = []
    for i in range(nSub):
        o = oSub + i * 32
        f = struct.unpack_from("<6H", data, o)
        subs.append(dict(part=f[0], triStart=f[4], triCount=f[5]))

    # texture units (vanilla ModelTextureUnit, 24 bytes): [0]flags [1]shaderId
    # [2]skinSectionIndex(submesh) [3]geosetIndex [4]colorIndex [5]materialIndex
    # [6]materialLayer [7]textureCount [8]textureComboIndex [9..] lookups.
    texunits = []
    for i in range(nTU):
        o = oTU + i * 24
        f = struct.unpack_from("<12H", data, o)
        texunits.append(dict(submesh=f[2], material=f[5], texCount=f[7], texCombo=f[8]))

    # materials (render flags): {uint16 flags, uint16 blendingMode}. blend 0/1 =
    # opaque/1-bit-alpha; 2 = alpha-blend; 3+ = additive/mod (glow planes).
    nMat, oMat = arr(data, H_MATERIALS)
    materials = [dict(flags=f, blend=b) for f, b in
                 (struct.unpack_from("<2H", data, oMat + i * 4) for i in range(nMat))]

    texlook = list(struct.unpack_from("<%dH" % nTexLook, data, oTexLook)) if nTexLook else []

    # textures: {type(u32), flags(u32), lenName(u32), ofsName(u32)}
    textures = []
    for i in range(nTex):
        o = oTex + i * 16
        ttype, tflags, lenName, ofsName = struct.unpack_from("<4I", data, o)
        name = ""
        if lenName and ofsName:
            end = ofsName + lenName
            name = data[ofsName:end].split(b"\0", 1)[0].decode("latin1")
        textures.append(dict(type=ttype, name=name))

    return dict(ver=ver, verts=verts, weights=weights, boneidx=boneidx, bones=bones,
                stand_idx=stand_idx, data=data,
                indices=indices, tris=tris, subs=subs,
                texunits=texunits, texlook=texlook, textures=textures, materials=materials)

# ---------------------------------------------------------------------------
def build_display_index(storm):
    cdi, cdi_s = load_dbc(storm.read("DBFilesClient\\CreatureDisplayInfo.dbc"))
    cmd, cms = load_dbc(storm.read("DBFilesClient\\CreatureModelData.dbc"))
    # CreatureDisplayInfo: [0]=id [1]=modelId [6..8]=TextureVariation string offsets
    # (basenames, live in the model's dir).
    # CreatureModelData: [0]=id [1]=flags [2]=ModelName (string). Field 2 is the
    # path — do NOT scan for a ".mdx"-looking field: later numeric fields can be
    # small values that alias mid-string offsets, giving TRUNCATED paths (e.g.
    # "ature\Basilisk\Basilisk.mdx"), which then fail to load (empty render).
    model_path = {}
    for r in cmd:
        v = cms(r[2]) if len(r) > 2 else ""
        if v and (v.lower().endswith(".mdx") or v.lower().endswith(".m2")):
            model_path[r[0]] = v
    # CreatureDisplayInfoExtra (character NPCs): ExtendedDisplayInfoID -> a PRE-BAKED
    # NPC body texture (field 18, e.g. "Filius.blp"). Turtle ships these baked
    # composites under Textures\BakedNpcTextures\, so we can texture character models
    # from the bake (skin+face+equipment already combined) without the full
    # character-compositing pipeline. build the ext -> bake-path map.
    bake_of = {}
    extra = storm.read("DBFilesClient\\CreatureDisplayInfoExtra.dbc")
    if extra:
        erows, es = load_dbc(extra)
        for r in erows:
            bn = es(r[18]) if len(r) > 18 else ""
            if bn:
                bake_of[r[0]] = "Textures\\BakedNpcTextures\\" + bn

    disp = {}
    for r in cdi:
        did, model = r[0], r[1]
        skins = [cdi_s(r[6]), cdi_s(r[7]), cdi_s(r[8])] if len(r) > 8 else []
        skins = [s for s in skins if s]
        # ExtendedDisplayInfoID (field 3) != 0 => a CHARACTER model (humanoid NPC).
        # Render it from its baked texture if present; else it needs the unbuilt
        # char-compositing pipeline -> skip (no bake => untextured).
        ext = r[3] if len(r) > 3 else 0
        disp[did] = dict(model=model, skins=skins, path=model_path.get(model),
                         ext=ext, bake=bake_of.get(ext) if ext else None)
    return disp


def blp_to_rgba(storm, path):
    from PIL import Image
    data = storm.read(path)
    if not data:
        return None
    try:
        return Image.open(BytesIO(data)).convert("RGBA")
    except Exception:
        return None


def resolve_submesh_textures(storm, m2, info):
    """submesh index -> {img, blend, flags}. Resolves each texture unit's texture
    (type 0 = embedded path; type 11/12/13 = creature skin variation) and its
    material blend mode. Falls back to any loadable texture so a bad combo index
    doesn't leave a submesh untextured (grey)."""
    import numpy as np  # noqa (ensures numpy importable before render)
    modeldir = os.path.dirname(info["path"]) if info.get("path") else ""
    TYPE_TO_VAR = {11: 0, 12: 1, 13: 2}   # monster skins 1/2/3 -> TextureVariation
    dyn_order = [i for i, t in enumerate(m2["textures"]) if t["type"] != 0]
    # Character model: the baked NPC texture stands in for the character-skin (type 1)
    # and object-skin (type 2) texture units. Hair (type 6) uses a separate hair
    # texture we don't have, so those geosets are skipped (NPC renders without 3D hair;
    # the baked head already carries the hairline/face).
    bake_img = blp_to_rgba(storm, info["bake"]) if info.get("bake") else None
    # Character-model geoset selection: a character model bundles every variant of
    # every geoset group (ears, hands/gloves, sleeves, robe, cloak, ...), and drawing
    # them all overlaps (double ears, double hands). Geoset id = group*100 + variant;
    # for each group render only the LOWEST variant = the base/default character
    # state. (Hair variants are type 6 and skipped separately.) Creatures: keep all.
    keep_sub = None
    if bake_img is not None:
        import collections
        bygroup = collections.defaultdict(list)
        for si, sub in enumerate(m2["subs"]):
            bygroup[sub["part"] // 100].append((sub["part"] % 100, si))
        keep_sub = set()
        for _g, lst in bygroup.items():
            mn = min(v for v, _ in lst)
            keep_sub.update(si for v, si in lst if v == mn)
    cache = {}

    def load_tex(ti):
        if ti in cache:
            return cache[ti]
        t = m2["textures"][ti]
        img = None
        if bake_img is not None:
            # character model: baked texture for body/object skin; hair skipped
            img = bake_img if t["type"] in (1, 2) else None
        elif t["type"] == 0 and t["name"]:
            img = blp_to_rgba(storm, t["name"])
        else:
            vi = TYPE_TO_VAR.get(t["type"])
            if vi is None and ti in dyn_order:
                vi = dyn_order.index(ti)
            sk = info["skins"][vi] if vi is not None and vi < len(info["skins"]) else None
            if sk:
                img = blp_to_rgba(storm, os.path.join(modeldir, sk + ".blp").replace("/", "\\"))
        cache[ti] = img
        return img

    # first loadable texture, used when a submesh's own combo doesn't resolve
    fallback = None
    for ti in range(len(m2["textures"])):
        fallback = load_tex(ti)
        if fallback is not None:
            break

    # Effect/particle textures (spell glows, orb reflects, ribbons) belong to the
    # particle system, not the static mesh — their placeholder quads render as opaque
    # black squares in a still. Skip any submesh whose texture is one of these.
    def is_effect(ti):
        if ti is None or ti >= len(m2["textures"]):
            return False
        n = m2["textures"][ti]["name"].upper().replace("/", "\\")
        if n.startswith("SPELLS\\") or "\\SPELLS\\" in n:
            return True
        base = n.rsplit("\\", 1)[-1]
        return any(k in base for k in ("GLOW", "REFLECT", "RIBBON", "BLOB", "CLOUD", "FLARE", "PARTICLE"))

    mats = m2["materials"]
    out = {}
    for tu in m2["texunits"]:
        si = tu["submesh"]
        if si in out and not out[si].get("skip"):
            continue
        if keep_sub is not None and si not in keep_sub:   # char geoset not selected
            out[si] = {"skip": True}
            continue
        tc = tu["texCombo"]
        ti = m2["texlook"][tc] if tc < len(m2["texlook"]) else (0 if m2["textures"] else None)
        if is_effect(ti):
            out[si] = {"skip": True}
            continue
        img = load_tex(ti) if (ti is not None and ti < len(m2["textures"])) else None
        if img is None:
            # character model: a non-body/hair geoset with no baked texture -> skip
            # (don't paint it with the fallback). creature: use the fallback texture.
            if bake_img is not None:
                out[si] = {"skip": True}
                continue
            img = fallback
        mi = tu["material"]
        mat = mats[mi] if mi < len(mats) else {"blend": 0, "flags": 0}
        out[si] = {"img": img, "blend": mat["blend"], "flags": mat["flags"]}
    return out

# ---------------------------------------------------------------------------
VERT_SHADER = """
#version 330
uniform mat4 mvp;
in vec3 in_pos; in vec3 in_norm; in vec2 in_uv;
out vec3 v_norm; out vec2 v_uv;
void main() { gl_Position = mvp * vec4(in_pos, 1.0); v_norm = in_norm; v_uv = in_uv; }
"""
FRAG_SHADER = """
#version 330
uniform sampler2D tex; uniform int has_tex; uniform float discard_a; uniform float amb; uniform float key_i; uniform int opaque_pass;
in vec3 v_norm; in vec2 v_uv; out vec4 f;
void main() {
    vec3 n = normalize(v_norm); if (!gl_FrontFacing) n = -n;
    vec3 L = normalize(vec3(0.35, 0.5, 0.8));   // key light (front-left-above)
    float key = max(dot(n, L), 0.0);
    float fill = max(dot(n, -L), 0.0) * 0.15;
    float d = amb + key_i * key + fill;
    vec4 base = has_tex == 1 ? texture(tex, v_uv) : vec4(0.72, 0.72, 0.74, 1.0);
    if (base.a < discard_a) discard;          // alpha cutout (capes, fur cards)
    // opaque pass writes solid alpha (so bodies aren't see-through in the webp);
    // transparent pass keeps texture alpha so blending works.
    f = vec4(base.rgb * d, opaque_pass == 1 ? 1.0 : base.a);
}
"""

def _mat_lookat(eye, tgt, up):
    import numpy as np
    f = tgt - eye; f = f / np.linalg.norm(f)
    s = np.cross(f, up); s = s / np.linalg.norm(s)
    u = np.cross(s, f)
    m = np.eye(4, dtype="f4")
    m[0, :3] = s; m[1, :3] = u; m[2, :3] = -f
    m[0, 3] = -np.dot(s, eye); m[1, 3] = -np.dot(u, eye); m[2, 3] = np.dot(f, eye)
    return m

def _mat_ortho(r, t, n, fa):
    import numpy as np
    m = np.zeros((4, 4), dtype="f4")
    m[0, 0] = 1.0 / r; m[1, 1] = 1.0 / t; m[2, 2] = -2.0 / (fa - n)
    m[2, 3] = -(fa + n) / (fa - n); m[3, 3] = 1.0
    return m

def _quat_to_mat(q):
    import numpy as np
    x, y, z, w = q
    n = x * x + y * y + z * z + w * w
    m = np.eye(4, dtype="f8")
    if n < 1e-8:
        return m
    s = 2.0 / n
    xx, yy, zz = x * x * s, y * y * s, z * z * s
    xy, xz, yz = x * y * s, x * z * s, y * z * s
    wx, wy, wz = w * x * s, w * y * s, w * z * s
    m[0, 0] = 1 - (yy + zz); m[0, 1] = xy - wz; m[0, 2] = xz + wy
    m[1, 0] = xy + wz; m[1, 1] = 1 - (xx + zz); m[1, 2] = yz - wx
    m[2, 0] = xz - wy; m[2, 1] = yz + wx; m[2, 2] = 1 - (xx + yy)
    return m


def _skin(m2):
    """Transform vertices into the Stand frame-0 pose via bone matrices. Returns
    (positions, normals) numpy arrays; bind pose if the model has no bones."""
    import numpy as np
    bones = m2["bones"]
    V = np.array(m2["verts"], dtype="f8")
    pos = V[:, 0:3]; nrm = V[:, 3:6]
    if not bones:
        return pos.astype("f4"), nrm.astype("f4")

    def T(v):
        m = np.eye(4, dtype="f8"); m[0:3, 3] = v; return m

    def S(v):
        m = np.eye(4, dtype="f8"); m[0, 0], m[1, 1], m[2, 2] = v; return m

    # Pose on the idle/Stand animation. ANIM overrides the sequence index; TIME is
    # the normalized frame (0 = first frame, small values ~ "second frame").
    data = m2["data"]
    anim = int(os.environ.get("ANIM", m2.get("stand_idx", 0)))
    tfrac = float(os.environ.get("TIME", 0.0))
    local = []
    for b in bones:
        piv = np.array(b["pivot"], dtype="f8")
        trans = sample_track(data, b["ttrans"], 3, anim, tfrac, (0.0, 0.0, 0.0))
        rot = sample_track(data, b["trot"], 4, anim, tfrac, (0.0, 0.0, 0.0, 1.0))
        rn = math.sqrt(sum(c * c for c in rot)) or 1.0
        rot = tuple(c / rn for c in rot)
        scale = sample_track(data, b["tscale"], 3, anim, tfrac, (1.0, 1.0, 1.0))
        m = T(piv) @ T(np.array(trans, "f8")) @ _quat_to_mat(rot) @ S(np.array(scale, "f8")) @ T(-piv)
        local.append(m)
    glob = [None] * len(bones)

    def g(i):
        if glob[i] is not None:
            return glob[i]
        p = bones[i]["parent"]
        glob[i] = (g(p) @ local[i]) if 0 <= p < len(bones) and p != i else local[i]
        return glob[i]
    for i in range(len(bones)):
        g(i)
    G = np.array(glob)  # (nB,4,4)

    W = np.array(m2["weights"], dtype="f8") / 255.0   # (nV,4)
    I = np.array(m2["boneidx"], dtype="i4")
    I = np.clip(I, 0, len(bones) - 1)
    pos4 = np.column_stack([pos, np.ones(len(pos))])
    out_p = np.zeros((len(pos), 3)); out_n = np.zeros((len(pos), 3))
    total = W.sum(axis=1, keepdims=True)
    total[total == 0] = 1.0
    for k in range(4):
        mats = G[I[:, k]]                                    # (nV,4,4)
        out_p += (W[:, k:k + 1] / total) * np.einsum("nij,nj->ni", mats, pos4)[:, :3]
        out_n += (W[:, k:k + 1] / total) * np.einsum("nij,nj->ni", mats[:, :3, :3], nrm)
    # vertices with zero total weight keep their bind position
    zero = (W.sum(axis=1) == 0)
    out_p[zero] = pos[zero]; out_n[zero] = nrm[zero]
    return out_p.astype("f4"), out_n.astype("f4")


def render_model(ctx, m2, tex_by_sub, size=SIZE):
    import numpy as np
    from PIL import Image
    sp, sn = _skin(m2)
    V = np.array(m2["verts"], dtype="f4")  # (n,8): pos3 norm3 uv2
    V[:, 0:3] = sp; V[:, 3:6] = sn
    idx = m2["indices"]; tris = m2["tris"]
    pos_all = V[:, 0:3]
    # Frame on the visible OPAQUE body: skipped effect planes (aura runes, glows) and
    # additive/particle submeshes otherwise inflate the bounding box and shrink or
    # stretch the model. Prefer opaque submeshes; else any DRAWN (non-skipped)
    # submesh; else all verts. NEVER include skipped submeshes in the frame.
    def verts_of(pred):
        s = set()
        for si, sub in enumerate(m2["subs"]):
            spec = tex_by_sub.get(si, {})
            if spec.get("skip") or not pred(spec):
                continue
            for k in range(sub["triStart"], sub["triStart"] + sub["triCount"]):
                s.add(idx[tris[k]])
        return s
    body_vi = verts_of(lambda s: s.get("blend", 0) in (0, 1)) or verts_of(lambda s: True)
    frame_pos = pos_all[sorted(body_vi)] if body_vi else pos_all
    lo = frame_pos.min(axis=0); hi = frame_pos.max(axis=0)
    center = (lo + hi) * 0.5
    radius = float(np.linalg.norm(hi - lo)) * 0.5 or 1.0

    prog = ctx.program(vertex_shader=VERT_SHADER, fragment_shader=FRAG_SHADER)
    # camera: 3/4 front view. WoW model space: +X forward, +Y left, +Z up.
    # Wowhead frames creatures from the front, turned ~30 deg toward the viewer's
    # left, slightly above. AZ/EL/EXT env overrides for tuning.
    az = math.radians(float(os.environ.get("AZ", 25)))
    el = math.radians(float(os.environ.get("EL", 12)))
    margin = float(os.environ.get("EXT", 1.12))
    d = radius * 3.0
    eye = center + np.array([math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)], "f4") * d
    view = _mat_lookat(eye.astype("f4"), center.astype("f4"), np.array([0, 0, 1], "f4"))
    # Tight framing: project every vertex to view space and fit the ortho box to the
    # actual 2D screen extent (the 3D diagonal over-pads tall/thin models). Square
    # box (max of x/y) keeps aspect; small margin so nothing clips.
    vp = (view @ np.column_stack([frame_pos, np.ones(len(frame_pos))]).T).T[:, :3]
    ext = float(max(np.abs(vp[:, 0]).max(), np.abs(vp[:, 1]).max())) * margin
    proj = _mat_ortho(ext, ext, 0.01, d * 2 + radius * 4)
    mvp = (proj @ view).T.astype("f4")  # column-major for GL
    prog["mvp"].write(mvp.tobytes())
    prog["discard_a"].value = float(os.environ.get("DISCARD", 0.12))
    prog["amb"].value = float(os.environ.get("AMB", 0.6))
    prog["key_i"].value = float(os.environ.get("KEY", 0.5))

    color = ctx.texture((size, size), 4, samples=0)
    depth = ctx.depth_texture((size, size))
    fbo = ctx.framebuffer(color_attachments=[color], depth_attachment=depth)
    fbo.use()
    ctx.clear(0.0, 0.0, 0.0, 0.0)
    ctx.disable(ctx.CULL_FACE)

    trash = []  # GL resources to free after the render (batch would leak otherwise)

    def draw(vert_np, spec, discard_a, opaque):
        vbo = ctx.buffer(vert_np.tobytes())
        vao = ctx.vertex_array(prog, [(vbo, "3f 3f 2f", "in_pos", "in_norm", "in_uv")])
        trash.extend([vbo, vao])
        tex_img = spec.get("img") if spec else None
        if tex_img is not None:
            # WoW UV origin is top-left and moderngl uploads row 0 as the first
            # texel row, so NO vertical flip is needed (verified against the client).
            ti = tex_img.transpose(Image.FLIP_TOP_BOTTOM) if os.environ.get("FLIP") else tex_img
            t = ctx.texture(ti.size, 4, ti.tobytes())
            t.build_mipmaps(); t.use(0); prog["tex"] = 0; prog["has_tex"].value = 1
            trash.append(t)
        else:
            prog["has_tex"].value = 0
        prog["discard_a"].value = discard_a
        prog["opaque_pass"].value = 1 if opaque else 0
        vao.render()

    def verts_for(sub):
        buf = []
        ts, tc = sub["triStart"], sub["triCount"]
        for k in range(ts, ts + tc):
            buf.append(V[idx[tris[k]]])
        return np.array(buf, dtype="f4") if buf else None

    # Two passes (like wow.export's legacy renderer): opaque/1-bit-alpha first with
    # depth write, then blended (alpha-blend/additive) with depth test but no write,
    # sorted after. blend 0=opaque 1=alpha-key 2=alpha-blend 3=additive 4=mod ...
    order = sorted(range(len(m2["subs"])),
                   key=lambda si: 0 if (tex_by_sub.get(si, {}).get("blend", 0) in (0, 1)) else 1)
    for si in order:
        spec = tex_by_sub.get(si, {})
        if spec.get("skip"):                      # effect/particle plane -> omit
            continue
        v = verts_for(m2["subs"][si])
        if v is None:
            continue
        blend = spec.get("blend", 0)
        if blend in (0, 1):                       # opaque / 1-bit alpha
            ctx.enable(ctx.DEPTH_TEST); ctx.depth_func = "<"
            ctx.disable(ctx.BLEND)
            # alpha-key (1): softer cutoff so hair/fur cards aren't fully discarded
            draw(v, spec, 0.3 if blend == 1 else 0.02, True)
        else:                                     # transparent: alpha-blend / additive
            ctx.enable(ctx.DEPTH_TEST)
            ctx.enable(ctx.BLEND)
            if blend >= 3:                        # additive (glow planes) -> src*a + dst
                ctx.blend_func = (ctx.SRC_ALPHA, ctx.ONE)
            else:                                 # alpha-blend (capes, hair)
                ctx.blend_func = (ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA)
            draw(v, spec, 0.02, False)
    ctx.disable(ctx.BLEND)

    raw = fbo.read(components=4, alignment=1)
    img = Image.frombytes("RGBA", (size, size), raw).transpose(Image.FLIP_TOP_BOTTOM)
    for r in trash + [fbo, color, depth, prog]:
        try:
            r.release()
        except Exception:
            pass
    return img

# ---------------------------------------------------------------------------
def main():
    args = sys.argv[1:]
    def flag(name):
        return name in args
    def val(name, d=None):
        return args[args.index(name) + 1] if name in args else d

    storm = Storm(STORMLIB)
    disp = build_display_index(storm)

    if flag("--inspect"):
        did = int(val("--inspect"))
        info = disp.get(did)
        print(f"display {did}: {info}")
        if not info or not info.get("path"):
            return
        m2b = storm.read(info["path"].rsplit(".", 1)[0] + ".m2") or storm.read(info["path"])
        m2 = parse_m2(m2b)
        print(f"  M2 v{m2['ver']}  verts={len(m2['verts'])} indices={len(m2['indices'])} tris={len(m2['tris'])//3}"
              f" subs={len(m2['subs'])} texunits={len(m2['texunits'])} textures={len(m2['textures'])}")
        for i, t in enumerate(m2["textures"]):
            print(f"    tex[{i}] type={t['type']} name='{t['name']}'")
        print(f"    texlook={m2['texlook']}")
        print(f"    subs={[(s['triStart'], s['triCount']) for s in m2['subs']]}")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    size = int(val("--size", os.environ.get("SIZE", SIZE)))
    import moderngl
    ctx = moderngl.create_standalone_context()
    print(f"rendering at {size}x{size}")

    if flag("--only"):
        ids = [int(val("--only"))]
    else:
        ids = json.load(open(WORKLIST))
        if flag("--limit"):
            ids = ids[: int(val("--limit"))]

    ok = fail = skip = chars = 0
    for did in ids:
        out = os.path.join(OUT_DIR, f"{did}.webp")
        if os.path.exists(out) and not flag("--force"):
            skip += 1; continue
        info = disp.get(did)
        if not info or not info.get("path"):
            fail += 1; continue
        # character-model NPCs render from their baked texture; skip only the ones
        # with no bake (would be untextured -> need the full char-compositing pipeline).
        if info.get("ext") and not info.get("bake"):
            chars += 1; continue
        try:
            m2b = storm.read(info["path"].rsplit(".", 1)[0] + ".m2") or storm.read(info["path"])
            if not m2b:
                fail += 1; continue
            m2 = parse_m2(m2b)
            if not m2["verts"] or not m2["subs"]:
                fail += 1; continue
            tex = resolve_submesh_textures(storm, m2, info)
            img = render_model(ctx, m2, tex, size)
            img.save(out, "WEBP", quality=88, method=6)
            ok += 1
            if ok % 50 == 0:
                print(f"  rendered {ok} (fail {fail}, skip {skip})")
        except Exception as e:
            fail += 1
            if flag("--verbose"):
                import traceback; traceback.print_exc()
            print(f"  {did}: {e}")
    print(f"DONE: rendered {ok} | failed {fail} | char-skipped {chars} | skipped {skip} -> {OUT_DIR}")

    # QC + manifest: drop near-empty renders (models that failed to resolve -> blank
    # or a lone floating part) so they fall back to Wowhead/no-thumb instead of
    # shipping broken. Keep the rest as the manifest the frontend serves.
    from PIL import Image
    import numpy as np
    MIN_OPAQUE = 1000
    have, dropped = [], 0
    for f in sorted(os.listdir(OUT_DIR)):
        if not f.endswith(".webp"):
            continue
        p = os.path.join(OUT_DIR, f)
        try:
            n = int((np.array(Image.open(p).convert("RGBA"))[:, :, 3] > 30).sum())
        except Exception:
            n = 0
        if n >= MIN_OPAQUE:
            have.append(int(f[:-5]))
        else:
            os.remove(p); dropped += 1
    have.sort()
    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
        json.dump(have, fh)
    print(f"  manifest: {len(have)} local model thumbs (QC dropped {dropped} near-empty) -> {os.path.join(OUT_DIR, 'manifest.json')}")


if __name__ == "__main__":
    main()
