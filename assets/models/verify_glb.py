"""Sanity checks for the generated GLBs + sidecars.

    uv run --project /tmp/articraft-src/Articraft python assets/models/verify_glb.py

For every apps/sim/public/models/<name>.glb this
  * loads the GLB with trimesh and lists node names / triangle counts / size,
  * checks that every Articraft body is a glTF node and the sidecar bodies,
    joints and anchors reference existing nodes,
  * compares each node's world-space bounds with the Articraft reference pose
    (converted to Y-up) to catch frame/handedness mistakes,
  * measures each anchor's distance to the surface of its own body
    (exact point-triangle distance) and flags anchors > 3 cm off the surface.
Exits non-zero on any failure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "apps" / "sim" / "public" / "models"
BUILD_DIR = ROOT / "assets" / "models" / "build"
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

R3 = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
SURFACE_TOL = 0.03


def point_triangle_distance(p: np.ndarray, tris: np.ndarray) -> float:
    """Exact min distance from point p to a set of triangles (Ericson, vectorised)."""
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    ab, ac, ap = b - a, c - a, p - a
    d1 = np.einsum("ij,ij->i", ab, ap)
    d2 = np.einsum("ij,ij->i", ac, ap)
    bp = p - b
    d3 = np.einsum("ij,ij->i", ab, bp)
    d4 = np.einsum("ij,ij->i", ac, bp)
    cp = p - c
    d5 = np.einsum("ij,ij->i", ab, cp)
    d6 = np.einsum("ij,ij->i", ac, cp)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2
    denom = va + vb + vc
    denom = np.where(np.abs(denom) < 1e-20, 1e-20, denom)
    v = vb / denom
    w = vc / denom
    closest = a + ab * v[:, None] + ac * w[:, None]
    # vertex / edge regions
    m = (d1 <= 0) & (d2 <= 0)
    closest[m] = a[m]
    m = (d3 >= 0) & (d4 <= d3)
    closest[m] = b[m]
    m = (d6 >= 0) & (d5 <= d6)
    closest[m] = c[m]
    m = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
    t = d1 / np.where(np.abs(d1 - d3) < 1e-20, 1e-20, d1 - d3)
    closest[m] = (a + ab * t[:, None])[m]
    m = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
    t = d2 / np.where(np.abs(d2 - d6) < 1e-20, 1e-20, d2 - d6)
    closest[m] = (a + ac * t[:, None])[m]
    m = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
    t = (d4 - d3) / np.where(np.abs((d4 - d3) + (d5 - d6)) < 1e-20, 1e-20, (d4 - d3) + (d5 - d6))
    closest[m] = (b + (c - b) * t[:, None])[m]
    return float(np.min(np.linalg.norm(closest - p, axis=1)))


def winding_number(p: np.ndarray, tris: np.ndarray) -> float:
    """Generalised winding number of point p w.r.t. triangles (~1 inside, ~0 outside)."""
    a, b, c = tris[:, 0] - p, tris[:, 1] - p, tris[:, 2] - p
    la, lb, lc = (np.linalg.norm(v, axis=1) for v in (a, b, c))
    det = np.einsum("ij,ij->i", a, np.cross(b, c))
    den = la * lb * lc + np.einsum("ij,ij->i", a, b) * lc + np.einsum("ij,ij->i", b, c) * la + np.einsum("ij,ij->i", c, a) * lb
    return float(np.sum(2.0 * np.arctan2(det, den)) / (4.0 * np.pi))


def glb_json(path: Path) -> str:
    data = path.read_bytes()
    length = int.from_bytes(data[12:16], "little")
    return data[20 : 20 + length].decode()


def reference_bounds(name: str) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """World bounds of each body at the Articraft reference pose, Y-up."""
    from articraft.sdk import TestContext  # noqa: PLC0415
    import importlib  # noqa: PLC0415

    mod = importlib.import_module(name)
    if hasattr(mod, "PARAMS"):
        from patient import build_patient  # noqa: PLC0415

        model, _ = build_patient(mod.PARAMS)
    else:
        model, _ = mod.build()
    ctx = TestContext(model)
    out = {}
    for b in model.rigid_bodies:
        lo, hi = ctx.part_world_bounds(b.name)
        corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]) @ R3.T
        out[b.name] = (corners.min(axis=0), corners.max(axis=0))
    return out


def main() -> int:
    failures = 0
    rows = []
    for glb in sorted(OUT_DIR.glob("*.glb")):
        name = glb.stem
        side = json.loads((OUT_DIR / f"{name}.json").read_text())
        scene = trimesh.load(glb, force="scene")
        graph = scene.graph
        node_names = [n for n in graph.nodes if n != graph.base_frame and n in side["bodies"]]
        # body name -> node (trimesh keeps glTF node names)
        tri_total = 0
        body_tris: dict[str, np.ndarray] = {}
        world_bounds = {}
        bodies = set(side["bodies"])
        parents = graph.transforms.parents
        # trimesh splits multi-primitive glTF meshes into helper child nodes; fold
        # them back onto their body node.  The raw GLB node list is checked below.
        owner = lambda n: n if n in bodies else parents.get(n)  # noqa: E731
        raw_nodes = [n["name"] for n in json.loads(glb_json(glb))["nodes"]]
        if sorted(raw_nodes) != sorted(bodies):
            print(f"FAIL {name}: GLB nodes {raw_nodes} != bodies {sorted(bodies)}")
            failures += 1
        for gnode in graph.nodes_geometry:
            node = owner(gnode)
            tf, geom_name = graph[gnode]
            tf_body = graph[node][0]
            geom = scene.geometry[geom_name].copy()
            # express helper-node geometry in the body node frame
            geom.apply_transform(np.linalg.inv(tf_body) @ tf)
            tf = tf_body
            tri_total += len(geom.faces)
            local = geom.triangles  # node-local
            body_tris.setdefault(node, []).append(local)
            wv = trimesh.transform_points(geom.vertices, tf)
            lo, hi = wv.min(axis=0), wv.max(axis=0)
            if node in world_bounds:
                lo = np.minimum(lo, world_bounds[node][0])
                hi = np.maximum(hi, world_bounds[node][1])
            world_bounds[node] = (lo, hi)
        body_tris = {k: np.concatenate(v) for k, v in body_tris.items()}

        missing = [b for b in side["bodies"] if b not in node_names]
        if missing:
            print(f"FAIL {name}: bodies missing as glTF nodes: {missing}")
            failures += 1
        for j in side["joints"]:
            if j["parent"] not in node_names or j["child"] not in node_names:
                print(f"FAIL {name}: joint {j['name']} references unknown node")
                failures += 1
            # parent/child relation must match the glTF hierarchy
            parent_of_child = graph.transforms.parents.get(j["child"])
            if parent_of_child != j["parent"]:
                print(f"FAIL {name}: node {j['child']} parent is {parent_of_child}, sidecar says {j['parent']}")
                failures += 1

        # reference-pose comparison
        ref = reference_bounds(name)
        worst = 0.0
        for body, (rlo, rhi) in ref.items():
            if body not in world_bounds:
                continue
            glo, ghi = world_bounds[body]
            worst = max(worst, float(np.max(np.abs(glo - rlo))), float(np.max(np.abs(ghi - rhi))))
        if worst > 0.004:
            print(f"FAIL {name}: GLB world bounds differ from the Articraft pose by {worst * 1000:.1f} mm")
            failures += 1

        # anchors on surface
        anchor_report = []
        for aid, a in side["anchors"].items():
            if a["body"] not in body_tris:
                print(f"FAIL {name}: anchor {aid} body {a['body']} has no mesh")
                failures += 1
                continue
            d = point_triangle_distance(np.array(a["position"]), body_tris[a["body"]])
            # is the anchor buried inside another body's volume (in world space)?
            tfa = graph[a["body"]][0]
            pw = trimesh.transform_points(np.array([a["position"]]), tfa)[0]
            buried = []
            for other, tris in body_tris.items():
                if other == a["body"]:
                    continue
                tfo = graph[other][0]
                tw = trimesh.transform_points(tris.reshape(-1, 3), tfo).reshape(-1, 3, 3)
                if winding_number(pw, tw) > 0.5:
                    buried.append(other)
            if buried and name.startswith("patient_"):
                print(f"FAIL {name}: anchor {aid} is buried inside {buried}")
                failures += 1
            anchor_report.append((aid, a["body"], d))
            if name.startswith("patient_") and d > SURFACE_TOL:
                print(f"FAIL {name}: anchor {aid} is {d * 100:.1f} cm from the {a['body']} surface")
                failures += 1
        rows.append((name, tri_total, glb.stat().st_size, node_names, anchor_report, worst))

    print(f"\n{'object':<22} {'tris':>6} {'KiB':>7}  max-bounds-err  nodes")
    for name, tris, size, nodes, _, worst in rows:
        print(f"{name:<22} {tris:>6} {size / 1024:>7.1f}  {worst * 1000:9.2f} mm   {', '.join(nodes)}")
    print("\nanchor distance to own body surface (mm):")
    for name, _, _, _, anchors, _ in rows:
        if not anchors:
            continue
        worst = max(anchors, key=lambda t: t[2])
        print(f"  {name:<22} {len(anchors):>2} anchors, max {worst[2] * 1000:6.2f} mm ({worst[0]})")
        if name.startswith("patient_"):
            for aid, body, d in anchors:
                print(f"      {aid:<26} {body:<12} {d * 1000:6.2f}")
    print("\nOK" if failures == 0 else f"\n{failures} FAILURE(S)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
