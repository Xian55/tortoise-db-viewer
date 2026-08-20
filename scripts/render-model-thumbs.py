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
import os, sys, json, math

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from m2 import Storm, load_dbc, parse_m2, blp_to_rgba, skin  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.environ.get("TW_CLIENT", r"F:/Game/Turtle WoW")
DATA = os.path.join(CLIENT, "Data")
STORMLIB = os.environ.get("STORMLIB", os.path.join(ROOT, "..", "StormLib", "bin", "StormLib_dll", "x64", "Release", "StormLib.dll"))
OUT_DIR = os.path.join(ROOT, "public", "model-thumbs")
WORKLIST = os.path.join(ROOT, "scripts", "data", "model-thumb-missing.json")
SIZE = 300


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


def _skin(m2):
    """Pose on the idle/Stand animation. ANIM overrides the sequence index; TIME is
    the normalized frame (0 = first frame, small values ~ "second frame")."""
    anim = int(os.environ.get("ANIM", m2.get("stand_idx", 0)))
    tfrac = float(os.environ.get("TIME", 0.0))
    return skin(m2, anim, tfrac)


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

    storm = Storm(STORMLIB, DATA)
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
