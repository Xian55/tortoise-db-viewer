"""Shared reading of the vanilla game client's 3D data: MPQ access, DBC rows, the
MD20 v256/257 model format, bone posing, and BLP decoding.

Factored out of scripts/render-model-thumbs.py, which was the first consumer and is
still the reference for "does this parse correctly?" -- it renders 300x300 creature
thumbnails from these same functions, so a regression there is visible immediately.
The second consumer is scripts/export-models.py, which converts models for the
in-browser viewer (src/modelviewer.js).

Everything here is LOCAL-only: it needs a game client and StormLib.dll. CI has
neither, which is why the outputs are committed or R2-hosted rather than rebuilt.

Offsets were derived from the client (and cross-checked against wow.export's
M2LegacyLoader), not from memory. Vanilla-specific traps that shaped this file:

  * the vanilla-only `texture_flipbooks` array at 0x6C shifts every M2Array after it,
    so materials sit at 0x84 and texture_combos at 0x94 -- NOT where a WotLK+ header
    layout would put them;
  * views/skin data are EMBEDDED (there is no .skin file until WotLK);
  * an M2Track is 28 bytes {u16 interp, u16 global_seq, M2Array x3}, which makes the
    attachment record 48 bytes (4 + 4 + 12 + 28) -- read it as 40 and every attachment
    after the first is garbage.
"""
import os
import sys
import struct
import math
import ctypes as C
from io import BytesIO

STREAM_FLAG_READ_ONLY = 0x00000100

# LOWEST precedence first: readers try the last-opened archive first, so patches win.
VANILLA_ARCHIVES = [
    "base.MPQ", "dbc.MPQ", "misc.MPQ", "model.MPQ", "texture.MPQ",
    "interface.MPQ", "fonts.MPQ", "backup.MPQ",
    "patch.MPQ", "patch-2.MPQ", "patch-3.mpq", "patch-4.mpq", "patch-5.mpq",
    "patch-6.mpq", "patch-7.mpq", "patch-8.mpq", "patch-9.mpq", "patch-Y.mpq", "_Patch-W.mpq",
]


class _FindData(C.Structure):
    _fields_ = [
        ("cFileName", C.c_char * 1024), ("szPlainName", C.c_char_p),
        ("dwHashIndex", C.c_uint32), ("dwBlockIndex", C.c_uint32),
        ("dwFileSize", C.c_uint32), ("dwFileFlags", C.c_uint32),
        ("dwCompSize", C.c_uint32), ("dwFileTimeLo", C.c_uint32),
        ("dwFileTimeHi", C.c_uint32), ("lcLocale", C.c_uint32),
    ]


class Storm:
    """Read-only view of a stack of MPQ archives, later ones overriding earlier."""

    def __init__(self, dll_path, data_dir, archives=None):
        if not os.path.exists(dll_path):
            sys.exit(f"StormLib.dll not found: {dll_path}\nSet STORMLIB env var.")
        d = C.WinDLL(dll_path)
        d.SFileOpenArchive.argtypes = [C.c_wchar_p, C.c_uint32, C.c_uint32, C.POINTER(C.c_void_p)]; d.SFileOpenArchive.restype = C.c_int
        d.SFileHasFile.argtypes = [C.c_void_p, C.c_char_p]; d.SFileHasFile.restype = C.c_int
        d.SFileOpenFileEx.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32, C.POINTER(C.c_void_p)]; d.SFileOpenFileEx.restype = C.c_int
        d.SFileGetFileSize.argtypes = [C.c_void_p, C.POINTER(C.c_uint32)]; d.SFileGetFileSize.restype = C.c_uint32
        d.SFileReadFile.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.POINTER(C.c_uint32), C.c_void_p]; d.SFileReadFile.restype = C.c_int
        d.SFileCloseFile.argtypes = [C.c_void_p]
        d.SFileFindFirstFile.argtypes = [C.c_void_p, C.c_char_p, C.POINTER(_FindData), C.c_char_p]; d.SFileFindFirstFile.restype = C.c_void_p
        d.SFileFindNextFile.argtypes = [C.c_void_p, C.POINTER(_FindData)]; d.SFileFindNextFile.restype = C.c_int
        d.SFileFindClose.argtypes = [C.c_void_p]
        self.d = d
        self.data_dir = data_dir
        self.handles = []
        for arc in (archives or VANILLA_ARCHIVES):
            p = os.path.join(data_dir, arc)
            if os.path.exists(p):
                h = C.c_void_p()
                if d.SFileOpenArchive(p, 0, STREAM_FLAG_READ_ONLY, C.byref(h)):
                    self.handles.append(h)
        if not self.handles:
            sys.exit(f"no MPQs opened under {data_dir}")

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

    def has(self, name):
        """Does this file exist in any archive? An OPEN, deliberately, not
        SFileHasFile: measured against this client stack, SFileHasFile returns TRUE for
        every name it is handed -- including invented ones -- so using it as an
        existence test silently reports every model as living in whichever directory
        happens to be probed first. Opening is a hash lookup, so the cost is trivial.

        Like read(), this finds files a patch archive's listfile omits, which plain
        enumeration does not (see extract-icons.py)."""
        b = name.encode("latin1")
        for h in self.handles:
            hf = C.c_void_p()
            if self.d.SFileOpenFileEx(h, b, 0, C.byref(hf)):
                sz = self.d.SFileGetFileSize(hf, None)
                self.d.SFileCloseFile(hf)
                if sz not in (0, 0xFFFFFFFF):
                    return True
        return False

    def listing(self, mask="*"):
        """Every filename matching `mask`, lowercased. One flat set across archives:
        the override order does not matter for "does this name exist anywhere"."""
        out = set()
        for h in self.handles:
            fd = _FindData()
            hf = self.d.SFileFindFirstFile(h, mask.encode("latin1"), C.byref(fd), None)
            if not hf:
                continue
            while True:
                out.add(fd.cFileName.decode("latin1").lower())
                if not self.d.SFileFindNextFile(hf, C.byref(fd)):
                    break
            self.d.SFileFindClose(hf)
        return out


def load_dbc(data):
    """(rows, string_accessor) for a WDBC blob. Every field is read as uint32; a
    string field is that value used as an offset into the trailing string block."""
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


def read_dbc(storm, name):
    """load_dbc over a DBFilesClient entry. Returns (rows, s), or (None, None)."""
    data = storm.read("DBFilesClient\\" + name)
    if not data:
        return None, None
    return load_dbc(data)


# ---------------------------------------------------------------------------
# Vanilla M2 (MD20 v256/257): views + skin data are EMBEDDED (no .skin file).
def arr(data, off):
    n, o = struct.unpack_from("<II", data, off)
    return n, o


# header M2Array offsets (verified against the Turtle 1.12 client; see --inspect)
H_GLOBALS   = 0x14   # global-sequence durations; name@0x08, global flags@0x10
H_ANIMS     = 0x1C
H_BONES     = 0x34
H_VERTICES  = 0x44
H_VIEWS     = 0x4C
H_COLORS    = 0x54   # M2Color[]: {M2Track color (vec3), M2Track alpha (fixed16)} = 56 B
H_TEXTURES  = 0x5C
H_MATERIALS = 0x84   # materials/render-flags: {uint16 flags, uint16 blendingMode}
H_TEXLOOK   = 0x94   # texture_combos (uint16 -> textures[])
H_ATTACH    = 0x104  # attachments: {u32 id, u32 bone, vec3 pos, M2Track(28)} = 48 bytes


def _track(data, toff):
    """Parse a vanilla M2Track header: interpolation type, per-animation key
    ranges, and the timestamps/values M2Arrays (offsets kept for lazy sampling)."""
    interp, gseq = struct.unpack_from("<hh", data, toff)
    n_r, o_r = arr(data, toff + 4)      # interpolation ranges (one M2Range per anim)
    n_t, o_t = arr(data, toff + 12)     # timestamps (uint32)
    n_v, o_v = arr(data, toff + 20)     # values
    ranges = [struct.unpack_from("<II", data, o_r + i * 8) for i in range(n_r)]
    # `gseq` >= 0 binds the track to a GLOBAL SEQUENCE: it runs on its own looping clock
    # and applies whatever animation is playing. That is how a character blinks -- one
    # track scaling the closed-eye mesh up for ~100ms three times in 6633ms -- so a reader
    # that files those keys under the played animation blinks at the animation's rate.
    return dict(ranges=ranges, n_t=n_t, o_t=o_t, n_v=n_v, o_v=o_v, interp=interp, gseq=gseq)


def track_keys(data, tr, comps, anim, t0=0):
    """The raw keys of one track for one animation: [(ms, (v...)), ...], with the
    sequence's own start subtracted so a player can work in 0..duration. Returns []
    when the track says nothing for this animation, which most bones do."""
    if tr["n_v"] == 0:
        return []
    if anim >= len(tr["ranges"]):
        # A track with no range for this animation is a GLOBAL one -- the client applies
        # its values whatever is playing, which is how a blood elf's shoulder carries a
        # 0.574 scale that appears in no sequence. sample_track() already falls back this
        # way; returning nothing here silently dropped it from the exported rig, and the
        # pauldrons came back out at human size.
        s0, e0 = 0, tr["n_v"] - 1
    else:
        s0, e0 = tr["ranges"][anim]
    e0 = min(e0, tr["n_v"] - 1)
    if e0 < s0:
        return []
    out = []
    for i in range(s0, e0 + 1):
        ts = struct.unpack_from("<I", data, tr["o_t"] + i * 4)[0] if tr["n_t"] else 0
        val = struct.unpack_from("<%df" % comps, data, tr["o_v"] + i * comps * 4)
        out.append((max(0, ts - t0), val))
    return out


def alpha_max(data, tr, anim):
    """The largest value an ALPHA track reaches during one animation. Alpha is stored as
    fixed16 (int16 / 32767), not float, so it needs its own reader -- and it is how the
    client hides a mesh it is not using: a character carries two eyelids, one shown while
    blinking and one for sleeping, and the spare is held at alpha 0 for the whole
    animation rather than being scaled away. Drawing it puts a closed eyelid on a face
    that is wide awake."""
    if tr["n_v"] == 0:
        return 1.0
    if anim < len(tr["ranges"]):
        s0, e0 = tr["ranges"][anim]
    else:
        s0, e0 = 0, tr["n_v"] - 1          # a global track applies whatever is playing
    e0 = min(e0, tr["n_v"] - 1)
    if e0 < s0:
        return 1.0
    return max(struct.unpack_from("<h", data, tr["o_v"] + k * 2)[0]
               for k in range(s0, e0 + 1)) / 32767.0


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
    nGlobal, oGlobal = arr(data, H_GLOBALS)
    gseq_dur = [struct.unpack_from("<I", data, oGlobal + i * 4)[0] for i in range(nGlobal)]
    nAnim, oAnim = arr(data, H_ANIMS)
    nBone, oBone = arr(data, H_BONES)
    nColor, oColor = arr(data, H_COLORS)
    colors = [dict(color=_track(data, oColor + i * 56), alpha=_track(data, oColor + i * 56 + 28))
              for i in range(nColor)]
    nVert, oVert = arr(data, H_VERTICES)
    nView, oView = arr(data, H_VIEWS)
    nTex, oTex = arr(data, H_TEXTURES)
    nTexLook, oTexLook = arr(data, H_TEXLOOK)

    # animations (vanilla AnimationSequence, 68 bytes): [0] uint16 animationID
    # (0 = Stand/idle), [1] uint16 subId. Find the first Stand sequence index so
    # we can pose on the idle animation regardless of its position in the list.
    stand_idx = 0
    anims = []
    for i in range(nAnim):
        aid, sub, a_start, a_end = struct.unpack_from("<2H2I", data, oAnim + i * 68)
        anims.append(dict(id=aid, sub=sub, start=a_start, end=a_end))
    for i, a in enumerate(anims):
        if a["id"] == 0:
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
        subs.append(dict(part=f[0], vStart=f[2], vCount=f[3], triStart=f[4], triCount=f[5]))

    # texture units (vanilla ModelTextureUnit, 24 bytes): [0]flags [1]shaderId
    # [2]skinSectionIndex(submesh) [3]geosetIndex [4]colorIndex [5]materialIndex
    # [6]materialLayer [7]textureCount [8]textureComboIndex [9..] lookups.
    texunits = []
    for i in range(nTU):
        o = oTU + i * 24
        f = struct.unpack_from("<12H", data, o)
        texunits.append(dict(submesh=f[2], color=f[4], material=f[5], layer=f[6],
                             texCount=f[7], texCombo=f[8]))

    # materials (render flags): {uint16 flags, uint16 blendingMode}. blend 0/1 =
    # opaque/1-bit-alpha; 2 = alpha-blend; 3+ = additive/mod (glow planes).
    nMat, oMat = arr(data, H_MATERIALS)
    materials = [dict(flags=f, blend=b) for f, b in
                 (struct.unpack_from("<2H", data, oMat + i * 4) for i in range(nMat))]

    texlook = list(struct.unpack_from("<%dH" % nTexLook, data, oTexLook)) if nTexLook else []

    # textures: {type(u32), flags(u32), lenName(u32), ofsName(u32)}. `flags` is the
    # wrap mode (1 = wrap X, 2 = wrap Y); `type` 0 means the embedded path IS the
    # texture, anything else is a runtime substitution slot (1 char skin, 2 object
    # skin, 6 hair, 11-13 the creature's texture variations).
    textures = []
    for i in range(nTex):
        o = oTex + i * 16
        ttype, tflags, lenName, ofsName = struct.unpack_from("<4I", data, o)
        name = ""
        if lenName and ofsName:
            end = ofsName + lenName
            name = data[ofsName:end].split(b"\0", 1)[0].decode("latin1")
        textures.append(dict(type=ttype, flags=tflags, name=name))

    # attachments: where an equipped item hangs off the skeleton. 48 bytes, NOT 40 --
    # the trailing M2Track is 28. Ids are the client attachment enum (0 shield,
    # 1 right hand, 2 left hand, 5/6 shoulders, 11 head, ...).
    nAtt, oAtt = arr(data, H_ATTACH)
    attach = []
    for i in range(nAtt):
        o = oAtt + i * 48
        aid, bone = struct.unpack_from("<II", data, o)
        pos = struct.unpack_from("<3f", data, o + 8)
        attach.append(dict(id=aid, bone=bone, pos=pos))

    return dict(ver=ver, verts=verts, weights=weights, boneidx=boneidx, bones=bones,
                stand_idx=stand_idx, anims=anims, data=data, gseq_dur=gseq_dur, colors=colors,
                indices=indices, tris=tris, subs=subs, attach=attach,
                texunits=texunits, texlook=texlook, textures=textures, materials=materials)


def quat_to_mat(q):
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


def bone_matrices(m2, anim=None, tfrac=0.0):
    """Global (model-space) matrix per bone for one animation frame. Also what an
    attachment point needs: its position is in the attach bone's local space."""
    import numpy as np
    bones = m2["bones"]
    if not bones:
        return np.zeros((0, 4, 4))
    if anim is None:
        anim = m2.get("stand_idx", 0)
    data = m2["data"]

    def T(v):
        m = np.eye(4, dtype="f8"); m[0:3, 3] = v; return m

    def S(v):
        m = np.eye(4, dtype="f8"); m[0, 0], m[1, 1], m[2, 2] = v; return m
    local = []
    for b in bones:
        piv = np.array(b["pivot"], dtype="f8")
        trans = sample_track(data, b["ttrans"], 3, anim, tfrac, (0.0, 0.0, 0.0))
        rot = sample_track(data, b["trot"], 4, anim, tfrac, (0.0, 0.0, 0.0, 1.0))
        rn = math.sqrt(sum(c * c for c in rot)) or 1.0
        rot = tuple(c / rn for c in rot)
        scale = sample_track(data, b["tscale"], 3, anim, tfrac, (1.0, 1.0, 1.0))
        m = T(piv) @ T(np.array(trans, "f8")) @ quat_to_mat(rot) @ S(np.array(scale, "f8")) @ T(-piv)
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
    return np.array(glob)  # (nB,4,4)


def skin(m2, anim=None, tfrac=0.0):
    """Transform vertices into a posed frame via bone matrices. Returns
    (positions, normals) numpy arrays; bind pose if the model has no bones."""
    import numpy as np
    bones = m2["bones"]
    V = np.array(m2["verts"], dtype="f8")
    pos = V[:, 0:3]; nrm = V[:, 3:6]
    if not bones:
        return pos.astype("f4"), nrm.astype("f4")
    G = bone_matrices(m2, anim, tfrac)

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


def _decode_blp2_raw(data):
    """BLP2, encoding 1 (palettized) -> a Pillow RGBA image, or None if not that shape.

    Pillow is used for everything else, but NOT for this case: it returns alpha 0 for
    every pixel of a palettized BLP that carries a separate alpha section, because it
    takes alpha from the palette entry (which is 0) instead of from that section. The
    result is a texture that is entirely transparent -- and since these are exactly the
    CUTOUT textures (hair, capes, fur, foliage), the mesh vanishes at the alpha test
    rather than looking wrong, which makes it read as a geometry bug. Every hairstyle on
    every character was invisible until this was written.

    Layout: header (magic, type, encoding, alphaDepth, alphaEncoding, hasMips, w, h),
    16 mip offsets, 16 mip sizes, a 256-entry BGRA palette, then the mip data: one index
    byte per pixel, followed by the alpha section at alphaDepth bits per pixel.
    """
    from PIL import Image
    if len(data) < 148 + 1024 or data[:4] != b"BLP2":
        return None
    encoding, alpha_depth = data[8], data[9]
    if encoding != 1:                       # 2 = DXT; Pillow handles those correctly
        return None
    w, h = struct.unpack_from("<2I", data, 12)
    mip_off = struct.unpack_from("<I", data, 20)[0]
    palette = data[148:148 + 1024]
    npx = w * h
    if not npx or mip_off + npx > len(data):
        return None
    # numpy, not a per-pixel loop: this runs over ~7,000 textures, and the loop version
    # spent minutes of CPU on the palette lookup alone before it was replaced.
    import numpy as np
    pal = np.frombuffer(palette, dtype=np.uint8).reshape(256, 4)[:, [2, 1, 0]]  # BGRA -> RGB
    idx = np.frombuffer(data, dtype=np.uint8, count=npx, offset=mip_off)
    rgba = np.empty((npx, 4), dtype=np.uint8)
    rgba[:, :3] = pal[idx]
    rgba[:, 3] = 255

    ao = mip_off + npx
    if alpha_depth == 8 and ao + npx <= len(data):
        rgba[:, 3] = np.frombuffer(data, dtype=np.uint8, count=npx, offset=ao)
    elif alpha_depth == 1 and ao + (npx + 7) // 8 <= len(data):
        packed = np.frombuffer(data, dtype=np.uint8, count=(npx + 7) // 8, offset=ao)
        # bit-packed, least significant bit first -- hence bitorder="little"
        rgba[:, 3] = np.unpackbits(packed, bitorder="little")[:npx] * 255
    elif alpha_depth == 4 and ao + (npx + 1) // 2 <= len(data):
        packed = np.frombuffer(data, dtype=np.uint8, count=(npx + 1) // 2, offset=ao)
        nib = np.empty(len(packed) * 2, dtype=np.uint8)
        nib[0::2] = packed & 0x0F
        nib[1::2] = packed >> 4
        rgba[:, 3] = nib[:npx] * 17
    # any other depth (or a truncated section) leaves alpha at 255: opaque beats invisible
    return Image.frombytes("RGBA", (w, h), rgba.tobytes())


def blp_to_rgba(storm, path):
    """Decode a client BLP to a Pillow RGBA image, or None. Palettized BLP2 is decoded
    here (see _decode_blp2_raw); BLP1 and the DXT-compressed BLP2s go through Pillow."""
    from PIL import Image
    data = storm.read(path)
    if not data:
        return None
    try:
        own = _decode_blp2_raw(data)
        if own is not None:
            return own
    except Exception:
        pass
    try:
        return Image.open(BytesIO(data)).convert("RGBA")
    except Exception:
        return None
