"""Convert Articraft USDZ exports to app-ready GLB + JSON sidecars.

Usage (from the repo root):

    uv run --project /tmp/articraft-src/Articraft python assets/models/usdz_to_glb.py [name ...]

For every ``assets/models/build/<name>/`` (or only the given names) this reads the
USDZ referenced by ``model.json`` plus the authoring ``meta.json`` and writes

    apps/sim/public/models/<name>.glb
    apps/sim/public/models/<name>.json

GLB layout
  * Articraft is Z-up, glTF is Y-up: everything is rotated -90 deg about X
    ((x, y, z) -> (x, z, -y)); units stay meters.
  * One glTF node per rigid body, named exactly like the Articraft body. Node
    origin = the body's joint frame to its parent (root: the body origin), so a
    rotation applied to the node in Babylon rotates about the joint. Node
    hierarchy follows the articulation tree.
  * Geometry is grouped per colour: one primitive per colour, one shared PBR
    material per colour (metallic 0, roughness 0.8). Normals are kept.
  * Bodies listed in meta ``uvPlanar`` get TEXCOORD_0 from a planar projection
    (used for the monitor ``screen`` dynamic texture).

Sidecar joint axes/limits are normalised so that the useful range is positive:
a joint authored with limits [lo, 0] (lo < 0) is written with the axis negated
and limits [0, -lo]; pose values are negated to match.
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from pxr import Usd, UsdGeom

ROOT = Path(__file__).resolve().parents[2]
BUILD_DIR = ROOT / "assets" / "models" / "build"
OUT_DIR = ROOT / "apps" / "sim" / "public" / "models"

# Z-up -> Y-up: rotate -90 degrees about X.
R3 = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
R4 = np.eye(4)
R4[:3, :3] = R3

ROUGHNESS = 0.8
AXIS_VEC = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}


# ---------------------------------------------------------------------------
# math helpers
# ---------------------------------------------------------------------------
def rpy_matrix(xyz, rpy) -> np.ndarray:
    """Articraft JointFrame -> 4x4 (extrinsic XYZ roll/pitch/yaw => Rz @ Ry @ Rx)."""
    r, p, y = rpy
    cr, sr, cp, sp, cy, sy = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(y), math.sin(y)
    rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
    ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    m = np.eye(4)
    m[:3, :3] = rz @ ry @ rx
    m[:3, 3] = xyz
    return m


def gf_to_np(m) -> np.ndarray:
    # USD matrices are row-vector (translation in the last row); transpose to column form.
    return np.array(m, dtype=float).T


def to_yup(m: np.ndarray) -> np.ndarray:
    return R4 @ m @ R4.T


def quat_from_matrix(m: np.ndarray) -> list[float]:
    """Rotation matrix -> glTF quaternion [x, y, z, w]."""
    r = m[:3, :3]
    t = np.trace(r)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        w = 0.25 * s
        x = (r[2, 1] - r[1, 2]) / s
        y = (r[0, 2] - r[2, 0]) / s
        z = (r[1, 0] - r[0, 1]) / s
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
        w = (r[2, 1] - r[1, 2]) / s
        x = 0.25 * s
        y = (r[0, 1] + r[1, 0]) / s
        z = (r[0, 2] + r[2, 0]) / s
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
        w = (r[0, 2] - r[2, 0]) / s
        x = (r[0, 1] + r[1, 0]) / s
        y = 0.25 * s
        z = (r[1, 2] + r[2, 1]) / s
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
        w = (r[1, 0] - r[0, 1]) / s
        x = (r[0, 2] + r[2, 0]) / s
        y = (r[1, 2] + r[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w])
    q /= np.linalg.norm(q)
    if q[3] < 0:
        q = -q
    return [float(v) for v in q]


def clean(v, nd: int = 6):
    if isinstance(v, (list, tuple, np.ndarray)):
        return [clean(x, nd) for x in v]
    f = round(float(v), nd)
    return 0.0 if f == 0 else f


# ---------------------------------------------------------------------------
# USD reading
# ---------------------------------------------------------------------------
def read_stage(usdz: Path):
    stage = Usd.Stage.Open(str(usdz))
    if UsdGeom.GetStageUpAxis(stage) != "Z":
        raise SystemExit(f"{usdz}: expected a Z-up stage")
    asm = None
    for prim in stage.GetPseudoRoot().GetChild("World").GetChildren():
        if prim.GetChild("rigid_bodies"):
            asm = prim
            break
    if asm is None:
        raise SystemExit(f"{usdz}: no Articraft assembly found")
    xcache = UsdGeom.XformCache(Usd.TimeCode.Default())

    bodies: dict[str, dict] = {}
    for body_prim in asm.GetChild("rigid_bodies").GetChildren():
        name = body_prim.GetName()
        world = gf_to_np(xcache.GetLocalToWorldTransform(body_prim))
        is_root = "PhysicsArticulationRootAPI" in body_prim.GetAppliedSchemas()
        shapes = []
        for shape_prim in Usd.PrimRange(body_prim):
            if shape_prim.GetTypeName() != "Mesh":
                continue
            mesh = UsdGeom.Mesh(shape_prim)
            pts = np.array(mesh.GetPointsAttr().Get(), dtype=float)
            counts = np.array(mesh.GetFaceVertexCountsAttr().Get(), dtype=int)
            idx = np.array(mesh.GetFaceVertexIndicesAttr().Get(), dtype=int)
            if not np.all(counts == 3):
                raise SystemExit(f"{shape_prim.GetPath()}: non-triangle faces are not supported")
            normals_attr = mesh.GetNormalsAttr()
            normals = normals_attr.Get()
            interp = mesh.GetNormalsInterpolation()
            shape_world = gf_to_np(xcache.GetLocalToWorldTransform(shape_prim))
            color = None
            base = shape_prim.GetAttribute("articraft:material:baseColor")
            if base and base.HasAuthoredValue():
                color = list(base.Get())
            else:
                dc = UsdGeom.PrimvarsAPI(shape_prim).GetPrimvar("displayColor")
                if dc and dc.Get():
                    color = list(dc.Get()[0])
            if color is None:
                color = [0.8, 0.8, 0.8]
            # expand to face-corner arrays
            corner_pos = pts[idx]
            if normals is not None and len(normals) > 0:
                n = np.array(normals, dtype=float)
                if interp == UsdGeom.Tokens.faceVarying:
                    corner_nrm = n
                elif interp in (UsdGeom.Tokens.vertex, UsdGeom.Tokens.varying):
                    corner_nrm = n[idx]
                elif interp == UsdGeom.Tokens.uniform:
                    corner_nrm = np.repeat(n, 3, axis=0)
                else:
                    corner_nrm = None
            else:
                corner_nrm = None
            if corner_nrm is None:
                tri = corner_pos.reshape(-1, 3, 3)
                fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
                fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
                corner_nrm = np.repeat(fn, 3, axis=0)
            shapes.append(
                {
                    "name": shape_prim.GetName(),
                    "to_body": np.linalg.inv(world) @ shape_world,
                    "pos": corner_pos,
                    "nrm": corner_nrm,
                    "color": [float(c) for c in color[:3]],
                }
            )
        bodies[name] = {"name": name, "world": world, "is_root": is_root, "shapes": shapes}

    joints = []
    jscope = asm.GetChild("joints")
    if jscope:
        for jp in jscope.GetChildren():
            get = lambda n: jp.GetAttribute(n).Get() if jp.GetAttribute(n) else None  # noqa: E731
            b0, b1 = get("articraft:body0"), get("articraft:body1")
            dofs = json.loads(get("articraft:dofs") or "[]")
            joints.append(
                {
                    "name": get("articraft:name") or jp.GetName(),
                    "body0": b0,
                    "body1": b1,
                    "frame0": rpy_matrix(tuple(get("articraft:frame0:xyz")), tuple(get("articraft:frame0:rpy"))),
                    "frame1": rpy_matrix(tuple(get("articraft:frame1:xyz")), tuple(get("articraft:frame1:rpy"))),
                    "dofs": dofs,
                    "type": get("articraft:jointType") or "fixed",
                    "excluded": bool(get("articraft:excludeFromArticulation")),
                }
            )
    return asm.GetName(), bodies, joints


# ---------------------------------------------------------------------------
# tree + node frames
# ---------------------------------------------------------------------------
def build_tree(bodies: dict, joints: list):
    roots = [n for n, b in bodies.items() if b["is_root"]] or [next(iter(bodies))]
    parent: dict[str, tuple[str, dict, np.ndarray]] = {}
    seen = set(roots)
    queue = list(roots)
    usable = [j for j in joints if not j["excluded"] and j["body0"] in bodies and j["body1"] in bodies]
    while queue:
        cur = queue.pop(0)
        for j in usable:
            if j["body0"] == cur and j["body1"] not in seen:
                child, child_frame = j["body1"], j["frame1"]
            elif j["body1"] == cur and j["body0"] not in seen:
                child, child_frame = j["body0"], j["frame0"]
            else:
                continue
            parent[child] = (cur, j, child_frame)
            seen.add(child)
            queue.append(child)
    for n in bodies:  # disconnected leftovers become extra roots
        if n not in seen:
            roots.append(n)
    # node frame (world, Z-up) for each body
    node_world = {}
    for n, b in bodies.items():
        if n in parent:
            node_world[n] = b["world"] @ parent[n][2]
        else:
            node_world[n] = b["world"].copy()
    return roots, parent, node_world


# ---------------------------------------------------------------------------
# GLB writer
# ---------------------------------------------------------------------------
class GlbBuilder:
    def __init__(self) -> None:
        self.bin = bytearray()
        self.gltf: dict = {
            "asset": {"version": "2.0", "generator": "medical-uowa-sim usdz_to_glb.py (Articraft)"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "materials": [],
            "accessors": [],
            "bufferViews": [],
            "buffers": [],
        }
        self.material_index: dict[tuple, int] = {}

    def _view(self, data: bytes, target: int | None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin.extend(data)
        view = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            view["target"] = target
        self.gltf["bufferViews"].append(view)
        return len(self.gltf["bufferViews"]) - 1

    def accessor(self, arr: np.ndarray, kind: str, *, index: bool = False, minmax: bool = False) -> int:
        if index:
            ctype = 5123 if arr.max() < 65535 else 5125
            data = arr.astype(np.uint16 if ctype == 5123 else np.uint32).tobytes()
            view = self._view(data, 34963)
        else:
            ctype = 5126
            data = arr.astype(np.float32).tobytes()
            view = self._view(data, 34962)
        acc = {"bufferView": view, "componentType": ctype, "count": int(arr.shape[0]), "type": kind}
        if minmax:
            acc["min"] = [float(v) for v in arr.min(axis=0)]
            acc["max"] = [float(v) for v in arr.max(axis=0)]
        self.gltf["accessors"].append(acc)
        return len(self.gltf["accessors"]) - 1

    def material(self, color, name_hint: str | None = None) -> int:
        key = (tuple(round(c, 4) for c in color), name_hint)
        if key not in self.material_index:
            hexname = "".join(f"{int(round(c * 255)):02x}" for c in color)
            self.gltf["materials"].append(
                {
                    "name": name_hint or f"mat_{hexname}",
                    "pbrMetallicRoughness": {
                        "baseColorFactor": [float(c) for c in color] + [1.0],
                        "metallicFactor": 0.0,
                        "roughnessFactor": ROUGHNESS,
                    },
                }
            )
            self.material_index[key] = len(self.gltf["materials"]) - 1
        return self.material_index[key]

    def write(self, path: Path) -> None:
        self.gltf["buffers"] = [{"byteLength": len(self.bin)}]
        if not self.gltf["meshes"]:
            del self.gltf["meshes"]
        js = json.dumps(self.gltf, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        binb = bytes(self.bin) + b"\0" * ((4 - len(self.bin) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(binb)
        with open(path, "wb") as f:
            f.write(struct.pack("<4sII", b"glTF", 2, total))
            f.write(struct.pack("<I4s", len(js), b"JSON"))
            f.write(js)
            f.write(struct.pack("<I4s", len(binb), b"BIN\0"))
            f.write(binb)


def weld(pos: np.ndarray, nrm: np.ndarray, uv: np.ndarray | None):
    cols = [np.round(pos, 6), np.round(nrm, 4)]
    if uv is not None:
        cols.append(np.round(uv, 5))
    key = np.concatenate(cols, axis=1)
    _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    return pos[first], nrm[first], (uv[first] if uv is not None else None), inverse


# ---------------------------------------------------------------------------
# conversion
# ---------------------------------------------------------------------------
def convert(build: Path) -> dict:
    manifest = json.loads((build / "model.json").read_text())
    usdz = build / manifest.get("usdz", "")
    if not usdz.is_file():
        candidates = sorted((build / "usdz").glob("*.usdz"))
        if not candidates:
            raise SystemExit(f"{build}: no USDZ found")
        usdz = candidates[-1]
    meta_path = build / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    name, bodies, joints = read_stage(usdz)
    roots, parent, node_world = build_tree(bodies, joints)

    glb = GlbBuilder()
    node_index: dict[str, int] = {}
    order = []  # BFS order so parents get indices first
    queue = list(roots)
    children: dict[str, list[str]] = {n: [] for n in bodies}
    for c, (p, _j, _f) in parent.items():
        children[p].append(c)
    while queue:
        n = queue.pop(0)
        order.append(n)
        queue.extend(sorted(children[n]))

    uv_planar = meta.get("uvPlanar", {})
    tri_total = 0
    body_tris = {}
    for n in order:
        b = bodies[n]
        nw = node_world[n]
        to_node = np.linalg.inv(nw) @ b["world"]  # body local -> node local (Z-up)
        groups: dict[tuple, list] = {}
        for s in b["shapes"]:
            m = R4 @ to_node @ s["to_body"]  # shape -> node local (Y-up)
            p = s["pos"] @ m[:3, :3].T + m[:3, 3]
            nr = s["nrm"] @ m[:3, :3].T
            nr /= np.maximum(np.linalg.norm(nr, axis=1, keepdims=True), 1e-12)
            key = tuple(round(c, 4) for c in s["color"])
            groups.setdefault(key, []).append((p, nr))
        prims = []
        for color, parts in groups.items():
            pos = np.concatenate([p for p, _ in parts])
            nrm = np.concatenate([q for _, q in parts])
            uv = None
            if n in uv_planar:
                cfg = uv_planar[n]
                # axes are authored in body-local Z-up; express them in node Y-up
                rot = (R4 @ to_node)[:3, :3]
                ua = rot @ np.array(cfg["u"], dtype=float)
                va = rot @ np.array(cfg["v"], dtype=float)
                pu = pos @ ua
                pv = pos @ va
                uv = np.stack(
                    [(pu - pu.min()) / max(np.ptp(pu), 1e-9), 1.0 - (pv - pv.min()) / max(np.ptp(pv), 1e-9)],
                    axis=1,
                )
            vp, vn, vu, inv = weld(pos, nrm, uv)
            attrs = {
                "POSITION": glb.accessor(vp, "VEC3", minmax=True),
                "NORMAL": glb.accessor(vn, "VEC3"),
            }
            if vu is not None:
                attrs["TEXCOORD_0"] = glb.accessor(vu, "VEC2")
            prim = {
                "attributes": attrs,
                "indices": glb.accessor(inv, "SCALAR", index=True),
                "material": glb.material(list(color), name_hint=n if n in uv_planar else None),
                "mode": 4,
            }
            prims.append(prim)
            tri_total += len(inv) // 3
        body_tris[n] = sum(len(np.concatenate([p for p, _ in parts])) // 3 for parts in groups.values())
        node = {"name": n}
        if prims:
            glb.gltf["meshes"].append({"name": n, "primitives": prims})
            node["mesh"] = len(glb.gltf["meshes"]) - 1
        if n in parent:
            pn = parent[n][0]
            local = to_yup(np.linalg.inv(node_world[pn]) @ nw)
        else:
            local = to_yup(nw)
        t = local[:3, 3]
        q = quat_from_matrix(local)
        if np.linalg.norm(t) > 1e-9:
            node["translation"] = clean(t)
        if abs(q[3] - 1.0) > 1e-9:
            node["rotation"] = clean(q, 8)
        glb.gltf["nodes"].append(node)
        node_index[n] = len(glb.gltf["nodes"]) - 1
    for n in order:
        kids = [node_index[c] for c in sorted(children[n])]
        if kids:
            glb.gltf["nodes"][node_index[n]]["children"] = kids
    glb.gltf["scenes"][0]["nodes"] = [node_index[r] for r in roots]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    glb_path = OUT_DIR / f"{name}.glb"
    glb.write(glb_path)

    # ---------------- sidecar ----------------
    flips: dict[str, bool] = {}
    jout = []
    for c, (p, j, _f) in parent.items():
        # find the moving dof
        jtype = j["type"]
        entry = {"name": j["name"], "parent": p, "child": c, "type": jtype}
        if j["dofs"]:
            dof = j["dofs"][0]
            ax = dof["axis"]  # rotX / transZ ...
            vec = np.array(AXIS_VEC[ax[-1].lower()])
            # axis is expressed in the joint frame == child node frame (Z-up) -> Y-up
            vec_y = R3 @ vec
            lo, hi = dof.get("limits") or [-math.pi, math.pi]
            flip = hi <= 0.0 < -lo
            if flip:
                vec_y, lo, hi = -vec_y, -hi, -lo
            flips[j["name"]] = flip
            entry["type"] = "revolute" if ax.startswith("rot") else "prismatic"
            entry["axis"] = clean(vec_y)
            entry["limits"] = clean([lo, hi])
            if len(j["dofs"]) > 1:
                entry["extraDofs"] = j["dofs"][1:]
        else:
            entry["type"] = "fixed"
            entry["axis"] = [0.0, 0.0, 0.0]
            entry["limits"] = [0.0, 0.0]
        jout.append(entry)
    jout.sort(key=lambda e: order.index(e["child"]))

    anchors = {}
    for aid, a in meta.get("anchors", {}).items():
        body = bodies[a["body"]]
        to_node = np.linalg.inv(node_world[a["body"]]) @ body["world"]
        m = R4 @ to_node
        pos = m[:3, :3] @ np.array(a["position"]) + m[:3, 3]
        out = {"body": a["body"], "position": clean(pos)}
        if a.get("normal") is not None:
            out["normal"] = clean(m[:3, :3] @ np.array(a["normal"]))
        anchors[aid] = out

    poses = {}
    for pname, values in meta.get("poses", {}).items():
        poses[pname] = {k: (-v if flips.get(k) else v) for k, v in values.items()}
        poses[pname] = {k: (0.0 if v == 0 else v) for k, v in poses[pname].items()}

    sidecar = {
        "name": name,
        "source": f"assets/models/build/{name}/{usdz.relative_to(build)}",
        "units": "meters",
        "upAxis": "Y",
        "bodies": order,
        "joints": jout,
        "anchors": anchors,
    }
    if poses:
        sidecar["poses"] = poses
    zup_vecs = set(meta.get("zupVectors", []))
    for k, v in meta.get("extra", {}).items():
        if k in zup_vecs:
            v = clean(R3 @ np.array(v, dtype=float))
        sidecar[k] = v
    sidecar["triangles"] = int(tri_total)
    (OUT_DIR / f"{name}.json").write_text(json.dumps(sidecar, indent=2) + "\n")
    return {
        "name": name,
        "glb": glb_path,
        "triangles": tri_total,
        "bytes": glb_path.stat().st_size,
        "bodies": order,
        "body_triangles": body_tris,
    }


def main(argv: list[str]) -> None:
    names = argv or sorted(p.name for p in BUILD_DIR.iterdir() if (p / "model.json").exists())
    for n in names:
        info = convert(BUILD_DIR / n)
        print(
            f"{info['name']:<22} {info['triangles']:>7} tris  {info['bytes'] / 1024:8.1f} KiB  "
            f"{len(info['bodies'])} nodes -> {info['glb'].relative_to(ROOT)}"
        )


if __name__ == "__main__":
    main(sys.argv[1:])
