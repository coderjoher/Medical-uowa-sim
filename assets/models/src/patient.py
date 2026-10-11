"""Parametric stylised mannequin patient (shared by the four patient scripts).

Authoring frame (Articraft, Z up): the patient lies SUPINE with
  * the pelvis centre at the origin,
  * the head towards +X (headDirection),
  * the face / chest pointing up, +Z (facing),
  * the patient's LEFT side towards -Y, RIGHT side towards +Y,
  * the back resting on the support plane z = -supportDepth.
The converter rewrites these to glTF Y-up (headDirection +X, facing +Y,
patient left +Z).

Every body's origin is its joint to the parent; at rest all body frames are
axis-aligned with the pelvis, so rotating a glTF node rotates about its joint.

Body tree
  pelvis
   |- abdomen - chest - neck - head - eyelid_l, eyelid_r
   |                 |- upper_arm_l - forearm_l - hand_l   (and _r)
   |- thigh_l - shin_l - foot_l                            (and _r)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from articraft.sdk import ModelView, RigidBodyAssembly
from articraft.sdk.mesh import boolean_difference

from common import (
    AssetMeta,
    box,
    ellipsoid,
    finalize,
    moved,
    ray_hit,
    revolute,
    rgb,
    segment_capsule,
    spherical_patch_shell,
)


@dataclass
class PatientParams:
    name: str
    height: float
    # standing heights of landmarks as fractions of height
    s_pelvis: float = 0.526
    s_lumbar: float = 0.571
    s_thorax: float = 0.657
    s_neck_base: float = 0.811
    s_shoulder: float = 0.80
    s_elbow: float = 0.629
    s_wrist: float = 0.486
    s_hip: float = 0.497
    s_knee: float = 0.28
    s_ankle: float = 0.046
    hand_len: float = 0.18
    foot_len: float = 0.25
    # half sizes (m)
    pelvis_r: tuple[float, float, float] = (0.12, 0.17, 0.11)
    abdomen_r: tuple[float, float, float] = (0.105, 0.15, 0.105)
    chest_r: tuple[float, float, float] = (0.16, 0.165, 0.115)
    head_r: tuple[float, float, float] = (0.115, 0.085, 0.10)
    neck_r: float = 0.052
    shoulder_y: float = 0.20
    arm_y: float = 0.218
    hip_y: float = 0.09
    upper_arm_r: float = 0.045
    forearm_r: float = 0.037
    hand_half: tuple[float, float, float] = (0.0, 0.016, 0.042)  # (unused, thickness, width)
    thigh_r: float = 0.07
    shin_r: float = 0.05
    foot_r: tuple[float, float] = (0.04, 0.045)
    head_lift: float = 0.06  # back of the head above the support plane (pillow)
    chest_lift: float = 0.0  # rounds the upper back (stoop)
    shoulder_lift: float = 0.0
    eye_r: float = 0.0135
    eye_spacing: float = 0.033
    # appearance
    skin: tuple[float, float, float] = (0.80, 0.62, 0.50)
    hair: tuple[float, float, float] = (0.16, 0.12, 0.10)
    iris: tuple[float, float, float] = (0.30, 0.20, 0.12)
    gown: tuple[float, float, float] = (0.64, 0.79, 0.86)
    lip: tuple[float, float, float] = (0.66, 0.40, 0.38)
    hair_style: str = "short"  # short | long | balding | child
    breasts: bool = False
    description: str = ""
    extra: dict = field(default_factory=dict)


SIDES = (("l", -1.0), ("r", 1.0))  # patient's left is -Y


def build_patient(p: PatientParams):
    H = p.height
    x_of = lambda s: (s - p.s_pelvis) * H  # noqa: E731
    D = p.pelvis_r[2]  # support plane at z = -D
    model = RigidBodyAssembly(p.name)
    meta = AssetMeta()

    bodies = {}
    origins = {}
    world_meshes: dict[str, list] = {}

    def body(name, origin):
        bodies[name] = model.rigid_body(name)
        origins[name] = tuple(float(v) for v in origin)
        world_meshes[name] = []
        return bodies[name]

    def add(bname, mesh, shape, color):
        world_meshes[bname].append(mesh)
        o = origins[bname]
        bodies[bname].add(moved(mesh, (-o[0], -o[1], -o[2])), name=shape, color=color)

    def joint(name, parent, child, dofs):
        o = origins[child]
        po = origins[parent]
        model.joint(
            name,
            bodies[parent].at((o[0] - po[0], o[1] - po[1], o[2] - po[2])),
            bodies[child].at((0.0, 0.0, 0.0)),
            dofs=dofs,
        )

    # ---------------- landmarks ----------------
    x_lumbar = x_of(p.s_lumbar)
    x_thorax = x_of(p.s_thorax)
    x_neck = x_of(p.s_neck_base)
    x_sh = x_of(p.s_shoulder)
    x_el = x_of(p.s_elbow)
    x_wr = x_of(p.s_wrist)
    x_hip = x_of(p.s_hip)
    x_kn = x_of(p.s_knee)
    x_an = x_of(p.s_ankle)
    head_c = (H * (1 - p.s_pelvis) - p.head_r[0], 0.0, -D + p.head_lift + p.head_r[2])

    abd_c = ((x_lumbar + x_thorax) / 2 + 0.005, 0.0, -D + p.abdomen_r[2])
    chest_c = ((x_thorax + x_neck) / 2, 0.0, -D + p.chest_r[2] + p.chest_lift)

    # ---------------- trunk ----------------
    body("pelvis", (0.0, 0.0, 0.0))
    add("pelvis", ellipsoid((0, 0, 0), p.pelvis_r, exponents=(0.7, 0.45), segments=(20, 10)), "pelvis_gown", p.gown)

    body("abdomen", (x_lumbar, 0.0, 0.0))
    add("abdomen", ellipsoid(abd_c, p.abdomen_r, exponents=(0.75, 0.5), segments=(20, 10)), "abdomen_gown", p.gown)
    joint("spine_lower", "pelvis", "abdomen", revolute("y", -0.9, 0.0))

    body("chest", (x_thorax, 0.0, chest_c[2] * 0.5))
    add("chest", ellipsoid(chest_c, p.chest_r, exponents=(0.7, 0.45), segments=(24, 12)), "chest_gown", p.gown)
    # gown neckline trim
    add(
        "chest",
        ellipsoid((x_neck - 0.03, 0.0, chest_c[2] + p.chest_r[2] * 0.55), (0.03, p.chest_r[1] * 0.55, 0.03), segments=(14, 6)),
        "neckline",
        tuple(min(1.0, c * 0.85) for c in p.gown),
    )
    if p.breasts:
        for side, s in SIDES:
            bx = chest_c[0] - 0.03
            by = s * 0.075
            top = ray_hit(world_meshes["chest"][:1], (bx, by, 1.0), (0, 0, -1))[0]
            add("chest", ellipsoid((bx, by, top[2] - 0.02), (0.06, 0.062, 0.045), segments=(14, 8)), f"breast_{side}", p.gown)
    joint("spine_upper", "abdomen", "chest", revolute("y", -0.9, 0.0))

    # ---------------- neck / head ----------------
    neck_a = (x_neck - 0.04, 0.0, chest_c[2] + 0.01)
    neck_b = (head_c[0] - p.head_r[0] * 0.55, 0.0, head_c[2] - 0.02)
    body("neck", (x_neck, 0.0, (neck_a[2] + neck_b[2]) / 2))
    add("neck", segment_capsule(neck_a, neck_b, p.neck_r, radial_segments=14), "neck_skin", p.skin)
    joint("neck_flex", "chest", "neck", revolute("y", -0.8, 0.0))

    hx, hy, hz = head_c
    rx, ry, rz = p.head_r
    body("head", (neck_b[0] + 0.02, 0.0, hz))
    head_mesh = ellipsoid(head_c, p.head_r, segments=(24, 14))
    add("head", head_mesh, "skull", p.skin)
    joint("head_turn", "neck", "head", revolute("x", -1.0, 1.0))

    def face_z(x, y):
        return ray_hit([head_mesh], (x, y, 1.0), (0, 0, -1))[0][2]

    # eyes
    eye_x = hx - 0.004 * H / 1.75
    eyes = {}
    for side, s in SIDES:
        ey = s * p.eye_spacing
        ez = face_z(eye_x, ey) - p.eye_r * 0.62
        eyes[side] = (eye_x, ey, ez)
        add("head", ellipsoid((eye_x, ey, ez), (p.eye_r,) * 3, segments=(14, 8)), f"eye_{side}", rgb("eye_white"))
        add(
            "head",
            ellipsoid((eye_x, ey, ez + p.eye_r * 0.72), (p.eye_r * 0.52, p.eye_r * 0.52, p.eye_r * 0.36), segments=(12, 6)),
            f"iris_{side}",
            p.iris,
        )
        # eyebrow
        bx = eye_x + p.eye_r * 2.1
        bz = face_z(bx, ey)
        add(
            "head",
            segment_capsule((bx, ey - s * 0.013, bz - 0.001), (bx + 0.003, ey + s * 0.013, bz - 0.002), 0.0035, radial_segments=8, height_segments=2),
            f"eyebrow_{side}",
            p.hair,
        )
        # ear
        add("head", ellipsoid((hx - 0.008, s * (ry - 0.003), hz - 0.004), (0.028 * rx / 0.115, 0.011, 0.019), segments=(12, 6)), f"ear_{side}", tuple(c * 0.95 for c in p.skin))
    # nose, mouth, cheeks
    nx = hx - rx * 0.27
    add("head", ellipsoid((nx, 0.0, face_z(nx, 0.0) - 0.002), (rx * 0.21, 0.013, 0.016), segments=(12, 6)), "nose", tuple(c * 0.97 for c in p.skin))
    mx = hx - rx * 0.6
    mz = face_z(mx, 0.0)
    add("head", segment_capsule((mx, -0.016, mz - 0.003), (mx, 0.016, mz - 0.003), 0.0042, radial_segments=8, height_segments=2), "mouth", p.lip)
    for side, s in SIDES:
        cx_, cy_ = hx - rx * 0.4, s * ry * 0.55
        add("head", ellipsoid((cx_, cy_, face_z(cx_, cy_) - 0.006), (0.016, 0.014, 0.008), segments=(10, 6)), f"cheek_{side}", (min(1, p.skin[0] * 1.05), p.skin[1] * 0.9, p.skin[2] * 0.9))

    # hair
    big = ellipsoid((hx + 0.008, 0.0, hz - 0.004), (rx + 0.012, ry + 0.011, rz + 0.011), segments=(24, 14))
    hairline = {"short": 0.55, "long": 0.45, "balding": 0.6, "child": 0.3}[p.hair_style] * rx
    face_cut = box((hx + hairline - 0.5, 0.0, hz - 0.015 + 0.5), (1.0, 1.0, 1.0))
    nape_cut = box((hx - rx * 0.62 - 0.5, 0.0, hz), (1.0, 1.0, 1.0))
    hair = boolean_difference(boolean_difference(big, face_cut), nape_cut)
    if p.hair_style == "balding":
        hair = boolean_difference(hair, box((hx + rx * 0.62 + 0.5, 0.0, hz + 0.01 + 0.5), (1.0, 1.0, 1.0)))
    add("head", hair, "hair", p.hair)
    if p.hair_style == "long":
        add("head", ellipsoid((hx + rx * 0.55, 0.0, hz - rz * 0.5), (rx * 0.95, ry * 1.45, rz * 0.45), segments=(18, 8)), "hair_long", p.hair)
        for side, s in SIDES:
            add("head", ellipsoid((hx - rx * 0.35, s * (ry + 0.006), hz - rz * 0.3), (rx * 0.6, 0.016, rz * 0.5), segments=(12, 6)), f"hair_lock_{side}", p.hair)
    if p.hair_style == "child":
        fx = hx + hairline + 0.004
        add("head", ellipsoid((fx, 0.0, face_z(fx, 0.0) - 0.004), (0.022, ry * 0.75, 0.012), segments=(14, 6)), "fringe", p.hair)

    # eyelids (thin shells, open at 0, closed at about -1.35 rad about Y)
    for side, s in SIDES:
        ex, ey, ez = eyes[side]
        body(f"eyelid_{side}", (ex, ey, ez))
        lid = spherical_patch_shell((ex, ey, ez), p.eye_r * 1.07, p.eye_r * 1.22, (0.68, 2.5), (-1.0, 1.0), n_theta=7, n_psi=8)
        add(f"eyelid_{side}", lid, "lid", tuple(c * 0.93 for c in p.skin))
        joint(f"eyelid_{side}_blink", "head", f"eyelid_{side}", revolute("y", -1.45, 0.0))

    # ---------------- arms ----------------
    for side, s in SIDES:
        z_ua = -D + p.upper_arm_r + p.shoulder_lift
        z_fa = -D + p.forearm_r
        sh = (x_sh, s * p.shoulder_y, z_ua)
        el = (x_el, s * p.arm_y, (z_ua + z_fa) / 2 + 0.003)
        wr = (x_wr, s * (p.arm_y + 0.004), z_fa)
        body(f"upper_arm_{side}", sh)
        mid = ((sh[0] + el[0]) / 2, (sh[1] + el[1]) / 2, (sh[2] + el[2]) / 2)
        lift = p.upper_arm_r * 0.06
        add(f"upper_arm_{side}", segment_capsule((sh[0], sh[1], sh[2] + lift), (mid[0], mid[1], mid[2] + lift), p.upper_arm_r * 1.06, radial_segments=12), "sleeve", p.gown)
        dr = p.upper_arm_r * 1.12
        add(f"upper_arm_{side}", ellipsoid((sh[0] - 0.005, sh[1], -D + dr + p.shoulder_lift), (dr,) * 3, segments=(12, 8)), "deltoid", p.gown)
        # shoulder cap bridging into the chest along the joint axis (Y)
        add(f"upper_arm_{side}", ellipsoid((sh[0], sh[1] - s * p.upper_arm_r, sh[2] + 0.01 * p.upper_arm_r / 0.045), (p.upper_arm_r * 1.1, p.upper_arm_r * 1.33, p.upper_arm_r * 1.05), segments=(12, 8)), "shoulder_cap", p.gown)
        add(f"upper_arm_{side}", segment_capsule((mid[0] + 0.03, mid[1], mid[2]), el, p.upper_arm_r * 0.95, radial_segments=12), "arm_skin", p.skin)
        joint(f"shoulder_{side}", "chest", f"upper_arm_{side}", revolute("y", -0.2, 2.8))

        body(f"forearm_{side}", el)
        add(f"forearm_{side}", segment_capsule(el, wr, p.forearm_r, radial_segments=12), "forearm_skin", p.skin)
        joint(f"elbow_{side}", f"upper_arm_{side}", f"forearm_{side}", revolute("y", 0.0, 2.4))

        body(f"hand_{side}", wr)
        hl = p.hand_len
        th, hw = p.hand_half[1], p.hand_half[2]
        add(f"hand_{side}", ellipsoid((wr[0] - hl * 0.38, wr[1], max(wr[2] + 0.004, -D + hw)), (hl * 0.40, th, hw), exponents=(0.8, 0.8), segments=(14, 8)), "palm", p.skin)
        add(f"hand_{side}", ellipsoid((wr[0] - hl * 0.80, wr[1], max(wr[2] + 0.001, -D + hw * 0.85)), (hl * 0.22, th * 0.8, hw * 0.85), segments=(12, 6)), "fingers", p.skin)
        add(f"hand_{side}", segment_capsule((wr[0] - hl * 0.25, wr[1] - s * th * 0.2, wr[2] + hw * 0.8), (wr[0] - hl * 0.55, wr[1] - s * th * 0.6, wr[2] + hw * 1.25), th * 0.75, radial_segments=8), "thumb", p.skin)
        joint(f"wrist_{side}", f"forearm_{side}", f"hand_{side}", revolute("y", -1.0, 1.0))

    # ---------------- legs ----------------
    for side, s in SIDES:
        hip = (x_hip, s * p.hip_y, -D + p.thigh_r)
        kn = (x_kn, s * p.hip_y, -D + p.thigh_r * 0.86)
        an = (x_an, s * p.hip_y, -D + p.shin_r)
        body(f"thigh_{side}", hip)
        hem = (kn[0] + 0.13 * H / 1.75, kn[1], -D + p.thigh_r)
        add(f"thigh_{side}", segment_capsule(hip, hem, p.thigh_r, radial_segments=14), "thigh_gown", p.gown)
        add(f"thigh_{side}", segment_capsule((hem[0] + 0.03, hem[1], hem[2]), kn, p.thigh_r * 0.86, radial_segments=14), "knee_skin", p.skin)
        joint(f"hip_{side}", "pelvis", f"thigh_{side}", revolute("y", -0.2, 2.0))

        body(f"shin_{side}", kn)
        add(f"shin_{side}", segment_capsule(kn, an, p.shin_r, radial_segments=12), "shin_skin", p.skin)
        add(f"shin_{side}", ellipsoid(((kn[0] * 0.65 + an[0] * 0.35), kn[1], -D + p.shin_r * 1.05), (0.15 * H / 1.75, p.shin_r * 1.08, p.shin_r * 1.05), segments=(12, 8)), "calf", p.skin)
        joint(f"knee_{side}", f"thigh_{side}", f"shin_{side}", revolute("y", -2.3, 0.0))

        body(f"foot_{side}", an)
        fr = p.foot_r
        add(f"foot_{side}", ellipsoid((an[0] - 0.02, an[1] + s * 0.005, -D + p.foot_len / 2), (fr[0], fr[1], p.foot_len / 2), exponents=(0.85, 0.9), segments=(12, 10)), "foot_skin", p.skin)
        joint(f"ankle_{side}", f"shin_{side}", f"foot_{side}", revolute("y", -0.8, 0.5))

    model.articulation("body", root=bodies["pelvis"], joints=[j.name for j in model.joints])

    # ---------------- exam anchors (surface points) ----------------
    def surf(anchor_id, bname, origin, direction):
        pt, n = ray_hit(world_meshes[bname], origin, direction)
        o = origins[bname]
        meta.anchor(anchor_id, bname, (pt[0] - o[0], pt[1] - o[1], pt[2] - o[2]), n)

    down = (0.0, 0.0, -1.0)
    R = 1.0  # +Y is the patient's right
    cx = chest_c[0]
    surf("general_inspection", "chest", (cx, 0.0, 2.0), down)
    surf("pupils", "head", (eye_x, 0.0, 2.0), down)  # bridge of the nose between the eyes
    for side, _ in SIDES:
        e = eyes[side]
        surf(f"pupil_{side}", "head", (e[0], e[1], 2.0), down)
    er = eyes["r"]
    surf("conjunctiva", "head", (er[0] - p.eye_r * 1.25, er[1], 2.0), down)
    neck_mid = ((neck_a[0] + neck_b[0]) / 2 + 0.01, 0.0, (neck_a[2] + neck_b[2]) / 2)
    surf("jvp", "neck", (neck_mid[0], 2.0 * R, neck_mid[2]), (0.0, -1.0, 0.0))
    d = (0.0, -0.6 * R, -1.0)
    surf("carotid_pulse", "neck", (neck_mid[0] + 0.01, 0.6 * R * 2.0 + neck_mid[1], 2.0 + neck_mid[2]), d)
    wr_r = (x_wr, p.arm_y + 0.004, -D + p.forearm_r)
    surf("radial_pulse", "forearm_r", (wr_r[0] + 0.03, wr_r[1] - 1.0, wr_r[2] + 1.0), (0.0, 1.0, -1.0))
    surf("blood_pressure", "upper_arm_r", ((x_sh + x_el) / 2, p.arm_y, 2.0), down)
    surf("temperature", "head", (hx + rx * 0.3, 0.0, 2.0), down)
    surf("heart_auscultation", "chest", (cx - p.chest_r[0] * 0.25, -0.045, 2.0), down)
    surf("chest_auscultation_front", "chest", (cx + p.chest_r[0] * 0.45, 0.07 * R, 2.0), down)
    surf("chest_auscultation_back", "chest", (cx, 0.075 * R, -2.0), (0.0, 0.0, 1.0))
    surf("chest_percussion", "chest", (cx + p.chest_r[0] * 0.1, 0.10 * R, 2.0), down)
    surf("chest_wall_palpation", "chest", (cx + p.chest_r[0] * 0.15, 0.0, 2.0), down)
    surf("abdomen_palpation", "abdomen", (abd_c[0], 0.05 * R, 2.0), down)
    surf("abdomen_auscultation", "abdomen", (abd_c[0] + 0.02, -0.03, 2.0), down)
    surf("calf_inspection", "shin_l", ((x_kn + x_an) / 2 + 0.03, -p.hip_y, 2.0), down)
    surf("ankle_oedema", "shin_r", (x_an + 0.06 * H / 1.75, p.hip_y, 2.0), down)
    surf("reflexes_knee", "thigh_r", (x_kn + 0.03 * H / 1.75, p.hip_y, 2.0), down)
    surf("reflexes_biceps", "upper_arm_r", (x_el + 0.035, p.arm_y, 2.0), down)
    hand_tip_x = x_wr - p.hand_len * 0.85
    surf("capillary_refill", "hand_r", (hand_tip_x, p.arm_y + 1.0, -D + p.forearm_r + 0.004), (0.0, -1.0, 0.0))

    # ---------------- poses + sidecar extras ----------------
    meta.poses = {
        "rest": {},
        "eyes_closed": {"eyelid_l_blink": -1.35, "eyelid_r_blink": -1.35},
        "reclined_45": {"spine_lower": -0.45, "spine_upper": -0.34},
        "head_turned_left": {"head_turn": 0.6},
        "knees_bent": {"hip_l": 0.7, "hip_r": 0.7, "knee_l": -1.3, "knee_r": -1.3, "ankle_l": 0.5, "ankle_r": 0.5},
        "arm_r_raised": {"shoulder_r": 1.4},
    }
    head_back = (hx, 0.0, -D + p.head_lift)
    meta.extra = {
        "description": p.description,
        "height": H,
        "facing": [0.0, 0.0, 1.0],
        "headDirection": [1.0, 0.0, 0.0],
        "leftDirection": [0.0, -1.0, 0.0],
        "supportDepth": D,
        "supportNormal": [0.0, 0.0, 1.0],
        "headRestPoint": list(head_back),
        "headLift": p.head_lift,
        "breathingBody": "chest",
        "breathingAxis": [0.0, 0.0, 1.0],
        "breathingAmplitude": 0.04,
        **p.extra,
    }
    meta.zup_vectors = ["facing", "headDirection", "leftDirection", "supportNormal", "headRestPoint", "breathingAxis"]
    return model, meta


def allowances(ctx) -> None:
    pass


def make_checks(p: PatientParams, model):
    def checks(ctx) -> None:
        lo, hi = ctx.part_world_bounds("pelvis")
        total_lo = [1e9] * 3
        total_hi = [-1e9] * 3
        for b in model.rigid_bodies:
            blo, bhi = ctx.part_world_bounds(b.name)
            total_lo = [min(a, c) for a, c in zip(total_lo, blo)]
            total_hi = [max(a, c) for a, c in zip(total_hi, bhi)]
        length = total_hi[0] - total_lo[0]
        ctx.expect_metric("body_length", length, minimum=p.height * 0.95, maximum=p.height * 1.08, unit="m")
        ctx.expect_metric("support_plane", total_lo[2], minimum=-p.pelvis_r[2] - 0.002, maximum=-p.pelvis_r[2] + 0.002, unit="m")
        # head toward +X, face toward +Z
        ctx.check("head_towards_plus_x", ctx.part_world_position("head")[0] > 0.3 * p.height)
        ctx.check("feet_towards_minus_x", ctx.part_world_position("foot_l")[0] < -0.3 * p.height)
        ctx.check("left_is_minus_y", ctx.part_world_position("hand_l")[1] < 0 < ctx.part_world_position("hand_r")[1])
        # eyelids close over the eyes
        with ctx.pose({"eyelid_l_blink": -1.35, "eyelid_r_blink": -1.35}):
            for side in ("l", "r"):
                ctx.expect_contact(f"eyelid_{side}", "head", contact_tol=1e-4, name=f"eyelid_{side}_closed_stays_on_head")
                lo_l, hi_l = ctx.part_world_bounds(f"eyelid_{side}")
                ilo, ihi = ctx.shape_world_bounds("head", f"iris_{side}")
                ctx.check(f"eyelid_{side}_covers_iris_when_closed", hi_l[2] > ihi[2], f"lid top {hi_l[2]:.4f} iris top {ihi[2]:.4f}")
        with ctx.pose({"knee_r": -1.3, "hip_r": 0.7}):
            ctx.expect_no_collision("shin_r", "shin_l", name="bent_knee_clears_other_leg")

    return checks


def run(p: PatientParams) -> None:
    model, meta = build_patient(p)
    finalize(
        model,
        meta,
        allow_joint_overlaps=True,
        allowances=allowances,
        extra_checks=make_checks(p, model),
        preview_views=[
            ("", ModelView(direction=(0.5, -1.0, 0.9), width=720, height=480, color_by="material")),
            ("face", ModelView(direction=(-0.15, -0.2, 1.0), up=(1.0, 0.0, 0.0), width=360, height=360, color_by="material", selected_parts=("head", "eyelid_l", "eyelid_r", "neck"))),
        ],
    )
