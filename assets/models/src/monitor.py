"""Vital-signs monitor on a rolling pole stand.

Frame: Z up, the screen faces -Y (towards the viewer standing at -Y).

Bodies
  stand   root: 5-spoke rolling base, pole, top bracket
  head    monitor housing, tilts about X at the bracket (``head_tilt``)
  screen  flat dark display face, fixed to the housing (``screen_mount``); its
          node origin is the centre of the display face and it carries planar UVs
          (u -> +X, v -> down) so the app can paint a DynamicTexture on it.

Anchors
  screen_center (screen)
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from articraft.sdk import ModelView, RigidBodyAssembly, SphereGeometry  # noqa: E402

from common import (  # noqa: E402
    AssetMeta,
    box,
    finalize,
    moved,
    revolute,
    rgb,
    rounded_box,
    segment_cylinder,
)

POLE_TOP = 1.26
BRACKET_TOP = 1.28
HOUSING = (0.36, 0.09, 0.28)
SCREEN = (0.30, 0.006, 0.19)


def build():
    model = RigidBodyAssembly("monitor")
    meta = AssetMeta()
    stand = model.rigid_body("stand")
    head = model.rigid_body("head")
    screen = model.rigid_body("screen")

    # ---- stand ----
    hub_z = 0.09
    stand.add(segment_cylinder((0, 0, 0.065), (0, 0, 0.115), 0.06, radial_segments=16), name="hub", color=rgb("blue_grey"))
    for i in range(5):
        a = 2 * math.pi * i / 5 + math.pi / 2
        end = (0.30 * math.cos(a), 0.30 * math.sin(a))
        stand.add(
            segment_cylinder((0.0, 0.0, hub_z), (end[0], end[1], hub_z), 0.022, radial_segments=8),
            name=f"spoke_{i}",
            color=rgb("blue_grey"),
        )
        stand.add(
            segment_cylinder((end[0], end[1], 0.035), (end[0], end[1], hub_z + 0.01), 0.012, radial_segments=8),
            name=f"caster_stem_{i}",
            color=rgb("mid_grey"),
        )
        stand.add(
            SphereGeometry(0.035, width_segments=10, height_segments=6).translate(end[0], end[1], 0.035),
            name=f"caster_{i}",
            color=rgb("rubber"),
        )
    stand.add(segment_cylinder((0, 0, 0.10), (0, 0, POLE_TOP), 0.022, radial_segments=14), name="pole", color=rgb("steel"))
    stand.add(segment_cylinder((0, 0, 0.75), (0, 0, 0.80), 0.032, radial_segments=14), name="pole_collar", color=rgb("teal"))
    stand.add(box((0.0, 0.0, (POLE_TOP - 0.01 + BRACKET_TOP) / 2), (0.14, 0.08, BRACKET_TOP - POLE_TOP + 0.01)), name="bracket", color=rgb("dark_grey"))
    # small accessory basket
    stand.add(box((0.0, 0.07, 0.95), (0.20, 0.10, 0.012)), name="basket_floor", color=rgb("light_blue_grey"))
    stand.add(box((0.0, 0.025, 0.97), (0.20, 0.012, 0.05)), name="basket_back", color=rgb("light_blue_grey"))
    stand.add(box((0.0, 0.115, 0.97), (0.20, 0.012, 0.05)), name="basket_front", color=rgb("light_blue_grey"))

    # ---- head (origin = tilt axis on top of the bracket) ----
    pivot = (0.0, 0.0, BRACKET_TOP)
    hc = (0.0, 0.0, BRACKET_TOP + HOUSING[2] / 2)

    def hl(mesh):
        return moved(mesh, (-pivot[0], -pivot[1], -pivot[2]))

    head.add(hl(rounded_box(hc, HOUSING, 0.02)), name="housing", color=rgb("white"))
    head.add(
        hl(box((0.0, -HOUSING[1] / 2 - 0.0015, hc[2] + 0.015), (SCREEN[0] + 0.03, 0.004, SCREEN[2] + 0.03))),
        name="bezel",
        color=rgb("dark_grey"),
    )
    head.add(
        hl(rounded_box((0.0, 0.0, BRACKET_TOP + HOUSING[2] + 0.012), (0.20, 0.03, 0.03), 0.01)),
        name="handle",
        color=rgb("teal"),
    )
    for i, col in enumerate(("teal", "amber", "coral")):
        head.add(
            hl(box((-0.10 + 0.05 * i, -HOUSING[1] / 2 - 0.003, BRACKET_TOP + 0.03), (0.03, 0.008, 0.016))),
            name=f"button_{i}",
            color=rgb(col),
        )
    head.add(
        hl(SphereGeometry(0.008, width_segments=8, height_segments=6).translate(0.15, -HOUSING[1] / 2, BRACKET_TOP + HOUSING[2] - 0.025)),
        name="alarm_led",
        color=rgb("teal_light"),
    )

    # ---- screen (origin = centre of the display face) ----
    face_y = -HOUSING[1] / 2 - 0.0035 - SCREEN[1]
    face_center = (0.0, face_y, hc[2] + 0.015)
    screen.add(box((0.0, SCREEN[1] / 2, 0.0), SCREEN), name="display", color=rgb("screen"))

    model.joint("head_tilt", stand.at(pivot), head.at((0.0, 0.0, 0.0)), dofs=revolute("x", -0.35, 0.35))
    model.joint(
        "screen_mount",
        head.at((face_center[0] - pivot[0], face_center[1] - pivot[1], face_center[2] - pivot[2])),
        screen.at((0.0, 0.0, 0.0)),
    )
    model.articulation("main", root=stand, joints=["head_tilt", "screen_mount"])

    meta.anchor("screen_center", "screen", (0.0, 0.0, 0.0), (0.0, -1.0, 0.0))
    meta.uv_planar = {"screen": {"u": [1.0, 0.0, 0.0], "v": [0.0, 0.0, 1.0]}}
    meta.extra = {
        "screenSize": [SCREEN[0], SCREEN[2]],
        "screenFacing": [0.0, -1.0, 0.0],
    }
    meta.zup_vectors = ["screenFacing"]
    return model, meta


def allowances(ctx):
    ctx.allow_overlap("stand", "head", shape_a="bracket", shape_b="housing", reason="tilt bracket is clamped into the housing")


def checks(ctx):
    ctx.expect_contact("head", "screen", shape_a="bezel", shape_b="display", contact_tol=1e-4)
    lo, hi = ctx.part_world_bounds("screen")
    ctx.expect_metric("screen_centre_height", (lo[2] + hi[2]) / 2, minimum=1.35, maximum=1.55, unit="m")


if __name__ == "__main__":
    m, meta = build()
    finalize(
        m,
        meta,
        allowances=allowances,
        extra_checks=checks,
        preview_views=[("", ModelView(direction=(0.6, -1.0, 0.4), width=480, height=640, color_by="material"))],
    )
