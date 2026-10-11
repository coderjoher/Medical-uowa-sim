"""Shared helpers for the clinical-sim asset authoring scripts.

Every object script builds an Articraft ``RigidBodyAssembly`` and then calls
:func:`finalize`, which

1. validates the assembly,
2. runs a ``TestContext`` with the baseline physical checks (mesh health,
   isolation, overlap, articulation separation) plus any object specific checks,
3. asserts that the report passes,
4. exports USDZ + manifest to ``assets/models/build/<name>/`` and
5. writes ``meta.json`` next to it (anchors, named poses, extra sidecar fields)
   which ``assets/models/usdz_to_glb.py`` folds into the app sidecar.

Conventions (Articraft authoring frame): meters, Z up, right handed. Anchors are
authored in the *body local* Articraft frame; the converter re-expresses them in
the glTF node frame (Y up, origin at the body's joint to its parent).
"""

from __future__ import annotations

import json
import math
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Sequence

import numpy as np

from articraft.sdk import (
    JointAxis,
    JointDOF,
    MeshGeometry,
    ModelView,
    RigidBody,
    RigidBodyAssembly,
    TestContext,
    render_view,
)

ASSETS_DIR = Path(__file__).resolve().parents[1]
BUILD_DIR = ASSETS_DIR / "build"
PREVIEW_DIR = ASSETS_DIR / "previews"

Vec3 = tuple[float, float, float]

# ---------------------------------------------------------------------------
# Palette: flat, soft, "clean clinic" colours (linear-ish sRGB 0..1)
# ---------------------------------------------------------------------------
PALETTE: dict[str, tuple[float, float, float]] = {
    "white": (0.95, 0.96, 0.97),
    "off_white": (0.90, 0.91, 0.92),
    "warm_white": (0.94, 0.93, 0.90),
    "blue_grey": (0.70, 0.77, 0.82),
    "light_blue_grey": (0.82, 0.86, 0.89),
    "mid_grey": (0.55, 0.59, 0.63),
    "dark_grey": (0.24, 0.27, 0.30),
    "charcoal": (0.13, 0.15, 0.17),
    "screen": (0.05, 0.07, 0.09),
    "teal": (0.16, 0.58, 0.60),
    "teal_dark": (0.10, 0.42, 0.45),
    "teal_light": (0.55, 0.80, 0.80),
    "steel": (0.72, 0.75, 0.78),
    "rubber": (0.20, 0.22, 0.24),
    "wood": (0.78, 0.68, 0.55),
    "floor": (0.80, 0.82, 0.80),
    "wall": (0.92, 0.93, 0.92),
    "wall_accent": (0.74, 0.84, 0.84),
    "coral": (0.86, 0.45, 0.40),
    "amber": (0.95, 0.75, 0.35),
    "lens": (0.98, 0.95, 0.75),
    "gown": (0.64, 0.79, 0.86),
    "gown_dark": (0.50, 0.66, 0.76),
    "gown_pink": (0.86, 0.72, 0.78),
    "eye_white": (0.97, 0.97, 0.96),
    "lip": (0.72, 0.42, 0.42),
}


def rgb(name: str) -> tuple[float, float, float]:
    return PALETTE[name]


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------
def moved(mesh: MeshGeometry, xyz: Sequence[float]) -> MeshGeometry:
    """Return a translated copy (the SDK mutates in place)."""
    return mesh.copy().translate(float(xyz[0]), float(xyz[1]), float(xyz[2]))


def segment_capsule(
    a: Sequence[float],
    b: Sequence[float],
    radius: float,
    *,
    radial_segments: int = 14,
    height_segments: int = 4,
    radius_scale: Sequence[float] = (1.0, 1.0),
) -> MeshGeometry:
    """Capsule whose hemisphere centres are ``a`` and ``b`` (world/local coords).

    ``radius_scale`` scales the cross-section on the two axes perpendicular to
    the segment (first: perpendicular axis closest to world Y, second: the other)
    so limbs can be slightly flattened.
    """
    pa = np.asarray(a, dtype=float)
    pb = np.asarray(b, dtype=float)
    d = pb - pa
    length = float(np.linalg.norm(d))
    mesh = CapsuleGeometry_(radius, length, radial_segments, height_segments)
    sx, sy = float(radius_scale[0]), float(radius_scale[1])
    if sx != 1.0 or sy != 1.0:
        mesh.scale(sy, sx, 1.0)  # local X <- second axis, local Y <- first axis
    return _orient_z_to(mesh, d).translate(*((pa + pb) / 2.0))


def segment_cylinder(
    a: Sequence[float], b: Sequence[float], radius: float, *, radial_segments: int = 16
) -> MeshGeometry:
    from articraft.sdk import CylinderGeometry

    pa = np.asarray(a, dtype=float)
    pb = np.asarray(b, dtype=float)
    d = pb - pa
    mesh = CylinderGeometry(radius, float(np.linalg.norm(d)), radial_segments=radial_segments)
    return _orient_z_to(mesh, d).translate(*((pa + pb) / 2.0))


def CapsuleGeometry_(radius: float, length: float, radial: int, height: int) -> MeshGeometry:
    from articraft.sdk import CapsuleGeometry

    return CapsuleGeometry(radius, length, radial_segments=radial, height_segments=height)


def _orient_z_to(mesh: MeshGeometry, direction: np.ndarray) -> MeshGeometry:
    """Rotate a Z-aligned mesh so +Z points along ``direction`` (minimal rotation,
    keeping the mesh's local X roughly on the world X/Y plane)."""
    d = direction / np.linalg.norm(direction)
    z = np.array([0.0, 0.0, 1.0])
    axis = np.cross(z, d)
    s = float(np.linalg.norm(axis))
    c = float(np.dot(z, d))
    if s < 1e-9:
        if c < 0:
            mesh.rotate((1.0, 0.0, 0.0), math.pi)
        return mesh
    mesh.rotate(tuple(axis / s), math.atan2(s, c))
    return mesh


def ellipsoid(
    center: Sequence[float],
    radii: Sequence[float],
    *,
    exponents: tuple[float, float] = (1.0, 1.0),
    segments: tuple[int, int] = (20, 10),
) -> MeshGeometry:
    from articraft.sdk import SuperellipsoidGeometry

    mesh = SuperellipsoidGeometry(
        tuple(float(r) for r in radii),
        latitude_exponent=exponents[0],
        longitude_exponent=exponents[1],
        radial_segments=max(8, segments[0]),
        height_segments=max(4, segments[1]),
    )
    return mesh.translate(*[float(v) for v in center])


def box(center: Sequence[float], size: Sequence[float]) -> MeshGeometry:
    from articraft.sdk import BoxGeometry

    return BoxGeometry(tuple(float(s) for s in size)).translate(*[float(v) for v in center])


def rounded_box(
    center: Sequence[float], size: Sequence[float], radius: float, *, tol: float = 0.004
) -> MeshGeometry:
    from articraft.sdk import RoundedBoxGeometry

    return RoundedBoxGeometry(
        tuple(float(s) for s in size), radius, tolerance=tol, angular_tolerance=0.5
    ).translate(*[float(v) for v in center])


def spherical_patch_shell(
    center: Sequence[float],
    r_inner: float,
    r_outer: float,
    theta_range: tuple[float, float],
    psi_range: tuple[float, float],
    *,
    n_theta: int = 8,
    n_psi: int = 10,
) -> MeshGeometry:
    """Closed thin shell covering part of a sphere (used for eyelids).

    Direction d(theta, psi) = (sin t cos p, sin p, cos t cos p): theta sweeps in
    the X/Z plane from +Z towards +X, psi tilts towards +Y.
    """
    cx, cy, cz = (float(v) for v in center)
    t0, t1 = theta_range
    p0, p1 = psi_range
    mesh = MeshGeometry()

    def grid(radius: float) -> list[list[int]]:
        rows = []
        for i in range(n_theta + 1):
            t = t0 + (t1 - t0) * i / n_theta
            row = []
            for j in range(n_psi + 1):
                p = p0 + (p1 - p0) * j / n_psi
                row.append(
                    mesh.add_vertex(
                        cx + radius * math.sin(t) * math.cos(p),
                        cy + radius * math.sin(p),
                        cz + radius * math.cos(t) * math.cos(p),
                    )
                )
            rows.append(row)
        return rows

    outer = grid(r_outer)
    inner = grid(r_inner)
    for i in range(n_theta):
        for j in range(n_psi):
            a, b, c, d = outer[i][j], outer[i + 1][j], outer[i + 1][j + 1], outer[i][j + 1]
            mesh.add_face(a, c, b)
            mesh.add_face(a, d, c)
            a, b, c, d = inner[i][j], inner[i + 1][j], inner[i + 1][j + 1], inner[i][j + 1]
            mesh.add_face(a, b, c)
            mesh.add_face(a, c, d)
    # rims
    def rim(seq_o: list[int], seq_i: list[int], flip: bool) -> None:
        for k in range(len(seq_o) - 1):
            a, b, c, d = seq_o[k], seq_o[k + 1], seq_i[k + 1], seq_i[k]
            if flip:
                mesh.add_face(a, b, c)
                mesh.add_face(a, c, d)
            else:
                mesh.add_face(a, c, b)
                mesh.add_face(a, d, c)

    rim([outer[0][j] for j in range(n_psi + 1)], [inner[0][j] for j in range(n_psi + 1)], False)
    rim([outer[n_theta][j] for j in range(n_psi + 1)], [inner[n_theta][j] for j in range(n_psi + 1)], True)
    rim([outer[i][0] for i in range(n_theta + 1)], [inner[i][0] for i in range(n_theta + 1)], True)
    rim([outer[i][n_psi] for i in range(n_theta + 1)], [inner[i][n_psi] for i in range(n_theta + 1)], False)
    mesh.validate()
    # make sure the winding is outward
    tm = mesh.to_trimesh(process=False)
    if tm.volume < 0:
        mesh.faces[:] = [(a, c, b) for (a, b, c) in mesh.faces]
    return mesh


# ---------------------------------------------------------------------------
# Ray casting for surface anchors (Moller-Trumbore, numpy)
# ---------------------------------------------------------------------------
def _tri_arrays(meshes: Iterable[MeshGeometry]) -> np.ndarray:
    tris = []
    for m in meshes:
        v = np.asarray(m.vertices, dtype=float)
        f = np.asarray(m.faces, dtype=int)
        tris.append(v[f])
    return np.concatenate(tris, axis=0)


def ray_hit(
    meshes: Iterable[MeshGeometry], origin: Sequence[float], direction: Sequence[float]
) -> tuple[Vec3, Vec3]:
    """First intersection of a ray with the given meshes -> (point, outward normal)."""
    tris = _tri_arrays(meshes)
    o = np.asarray(origin, dtype=float)
    d = np.asarray(direction, dtype=float)
    d = d / np.linalg.norm(d)
    v0, v1, v2 = tris[:, 0], tris[:, 1], tris[:, 2]
    e1 = v1 - v0
    e2 = v2 - v0
    p = np.cross(d, e2)
    det = np.einsum("ij,ij->i", e1, p)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    t_vec = o - v0
    u = np.einsum("ij,ij->i", t_vec, p) * inv
    q = np.cross(t_vec, e1)
    v = (q @ d) * inv
    t = np.einsum("ij,ij->i", e2, q) * inv
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-9)
    if not hit.any():
        raise ValueError(f"ray from {tuple(o)} along {tuple(d)} missed the body")
    idx = np.where(hit)[0]
    k = idx[np.argmin(t[idx])]
    point = o + d * t[k]
    n = np.cross(e1[k], e2[k])
    n = n / np.linalg.norm(n)
    if np.dot(n, d) > 0:
        n = -n
    return tuple(float(x) for x in point), tuple(float(x) for x in n)


# ---------------------------------------------------------------------------
# Anchors / meta
# ---------------------------------------------------------------------------
@dataclass
class Anchor:
    body: str
    position: Vec3  # body-local, Articraft Z-up frame
    normal: Vec3 | None = None


@dataclass
class AssetMeta:
    anchors: dict[str, Anchor] = field(default_factory=dict)
    poses: dict[str, dict[str, float]] = field(default_factory=dict)
    # Extra sidecar fields; vectors listed in ``zup_vectors`` are converted to Y-up.
    extra: dict[str, object] = field(default_factory=dict)
    zup_vectors: list[str] = field(default_factory=list)
    # Planar UV projection for named bodies: {body: {"u": axis, "v": axis}} in body-local Z-up.
    uv_planar: dict[str, dict[str, list[float]]] = field(default_factory=dict)

    def anchor(self, anchor_id: str, body: str, position: Sequence[float], normal=None) -> None:
        self.anchors[anchor_id] = Anchor(
            body,
            tuple(float(v) for v in position),
            None if normal is None else tuple(float(v) for v in normal),
        )


def revolute(axis: str, lo: float, hi: float) -> tuple[JointDOF, ...]:
    return (JointDOF(getattr(JointAxis, f"ROT_{axis.upper()}"), limits=(lo, hi)),)


# ---------------------------------------------------------------------------
# Check + export
# ---------------------------------------------------------------------------
def _shape_names(body: RigidBody) -> list[str]:
    return [s.name for s in body._iter_shapes()]


def finalize(
    model: RigidBodyAssembly,
    meta: AssetMeta,
    *,
    extra_checks: Callable[[TestContext], None] | None = None,
    allow_joint_overlaps: bool = False,
    overlap_reason: str = "articulated neighbours share a soft joint volume",
    preview_views: Sequence[tuple[str, ModelView]] | None = None,
    preview_pose: dict[str, float] | None = None,
) -> None:
    name = model.name
    model.validate()

    ctx = TestContext(model, mesh_tolerance=0.002)
    ctx.check_model_valid()
    ctx.fail_if_mesh_unhealthy()

    if allow_joint_overlaps:
        # Mannequin limbs intentionally interpenetrate at their own joint (ball
        # and socket look).  Only parent/child pairs joined by a joint are ever
        # allowed; any other overlap still fails below.
        for joint in model.joints:
            a, b = joint.body0, joint.body1
            for sa in _shape_names(a):
                for sb in _shape_names(b):
                    if ctx.distance_between(a.name, b.name, shape_a=sa, shape_b=sb).collided:
                        ctx.allow_overlap(a.name, b.name, shape_a=sa, shape_b=sb, reason=overlap_reason)

    ctx.fail_if_isolated_parts(contact_tol=1e-4)
    ctx.warn_if_part_contains_disconnected_geometry_islands(contact_tol=1e-4)
    ctx.warn_if_absurd_dimensions()
    ctx.fail_if_parts_overlap_in_current_pose()
    ctx.fail_if_articulation_separates_child()

    # anchors must reference real bodies
    body_names = {b.name for b in model.rigid_bodies}
    for anchor_id, anchor in meta.anchors.items():
        ctx.check(f"anchor_body_exists({anchor_id})", anchor.body in body_names, anchor.body)

    if extra_checks is not None:
        extra_checks(ctx)

    report = ctx.report()
    for w in report.warnings:
        print(f"[{name}] warning: {w[:400]}")
    if not report.passed:
        for f in report.failures:
            print(f"[{name}] FAIL {f.name}: {f.details[:2000]}", file=sys.stderr)
    assert report.passed, f"{name}: TestContext report failed"
    print(f"[{name}] TestContext passed ({report.checks_run} checks)")

    out = BUILD_DIR / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    from articraft.sdk.export import export_assembly

    result = export_assembly(model, out)
    print(f"[{name}] exported {result.usdz} ({result.audit.triangle_count} triangles)")

    meta_json = {
        "name": name,
        "anchors": {
            k: {"body": a.body, "position": list(a.position), "normal": None if a.normal is None else list(a.normal)}
            for k, a in meta.anchors.items()
        },
        "poses": meta.poses,
        "extra": meta.extra,
        "zupVectors": meta.zup_vectors,
        "uvPlanar": meta.uv_planar,
    }
    (out / "meta.json").write_text(json.dumps(meta_json, indent=2))

    if preview_views is None:
        preview_views = [("", ModelView.three_quarter(width=640, height=480, color_by="material"))]
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    for suffix, view in preview_views:
        path = PREVIEW_DIR / f"{name}{('_' + suffix) if suffix else ''}.png"
        render_view(model, view, path, pose=preview_pose)
    print(f"[{name}] previews written")
