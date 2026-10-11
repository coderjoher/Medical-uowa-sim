"""Hospital examination bed with a hinged backrest.

Frame: Z up, bed long axis along X, head end at +X, foot end at -X.
Mattress top at z = 0.70 m, footprint ~2.0 x 0.9 m.

Bodies
  frame     root: chassis, legs, casters, seat mattress, foot board, hinge barrels
  backrest  backrest board + mattress section + pillow, hinged at the deck
            (``backrest_hinge``; after GLB normalisation 0 = flat, +1.1 rad = sitting up)

Anchors
  patient_hip   (frame)    seat top surface where the patient's pelvis centre sits
  patient_head  (backrest) pillow top surface where the back of the head rests
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from articraft.sdk import ModelView, RigidBodyAssembly  # noqa: E402

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
from articraft.sdk import SphereGeometry  # noqa: E402

LENGTH = 2.0
WIDTH = 0.9
TOP = 0.70
DECK_TOP = 0.58
DECK_BOTTOM = 0.54
HINGE_X = 0.125
X_FOOT = -LENGTH / 2
X_HEAD = LENGTH / 2
PAPER = 0.004
PILLOW_T = 0.06


def build() -> tuple[RigidBodyAssembly, AssetMeta]:
    model = RigidBodyAssembly("bed")
    meta = AssetMeta()
    frame = model.rigid_body("frame")
    back = model.rigid_body("backrest")

    # --- frame (body origin = world origin, on the floor under the bed centre) ---
    frame.add(
        box((0.0, 0.0, (DECK_TOP + DECK_BOTTOM) / 2), (LENGTH, WIDTH, DECK_TOP - DECK_BOTTOM)),
        name="deck",
        color=rgb("light_blue_grey"),
    )
    # pedestal-style chassis
    frame.add(box((0.0, 0.0, 0.33), (1.30, 0.50, 0.42)), name="pedestal", color=rgb("white"))
    frame.add(box((0.0, 0.0, 0.10), (1.75, 0.70, 0.06)), name="base", color=rgb("blue_grey"))
    for i, (x, y) in enumerate(
        [(0.80, 0.30), (0.80, -0.30), (-0.80, 0.30), (-0.80, -0.30)]
    ):
        frame.add(
            segment_cylinder((x, y, 0.07), (x, y, 0.131), 0.02, radial_segments=10),
            name=f"caster_stem_{i}",
            color=rgb("mid_grey"),
        )
        frame.add(
            SphereGeometry(0.04, width_segments=10, height_segments=6).translate(x, y, 0.04),
            name=f"caster_{i}",
            color=rgb("rubber"),
        )
    # seat mattress (foot end up to the hinge)
    seat_len = HINGE_X - 0.005 - X_FOOT
    seat_cx = X_FOOT + seat_len / 2
    frame.add(
        rounded_box((seat_cx, 0.0, (DECK_TOP + TOP - PAPER) / 2), (seat_len, WIDTH - 0.02, TOP - PAPER - DECK_TOP), 0.025),
        name="seat_mattress",
        color=rgb("teal_light"),
    )
    frame.add(
        box((seat_cx, 0.0, TOP - PAPER / 2 - 0.0005), (seat_len - 0.04, 0.55, PAPER + 0.001)),
        name="seat_paper",
        color=rgb("white"),
    )
    # foot board
    frame.add(
        rounded_box((X_FOOT - 0.015, 0.0, 0.70), (0.03, WIDTH - 0.04, 0.34), 0.012),
        name="foot_board",
        color=rgb("blue_grey"),
    )
    # hinge barrels (captured pins for the backrest)
    for side, y in (("l", 0.38), ("r", -0.38)):
        frame.add(
            segment_cylinder((HINGE_X, y - 0.05, DECK_TOP), (HINGE_X, y + 0.05, DECK_TOP), 0.018, radial_segments=12),
            name=f"hinge_barrel_{side}",
            color=rgb("mid_grey"),
        )
    # side rail handles
    for side, y in (("l", WIDTH / 2 + 0.02), ("r", -WIDTH / 2 - 0.02)):
        frame.add(
            box((-0.35, y, DECK_TOP - 0.02), (0.9, 0.04, 0.04)),
            name=f"side_rail_{side}",
            color=rgb("steel"),
        )

    # --- backrest (body origin = hinge axis point (HINGE_X, 0, DECK_TOP)) ---
    hinge = (HINGE_X, 0.0, DECK_TOP)

    def local(mesh):
        return moved(mesh, (-hinge[0], -hinge[1], -hinge[2]))

    x0 = HINGE_X + 0.005
    back_len = X_HEAD - x0
    bcx = x0 + back_len / 2
    board_t = 0.02
    back.add(
        local(box((bcx, 0.0, DECK_TOP + board_t / 2), (back_len, WIDTH - 0.04, board_t))),
        name="backrest_board",
        color=rgb("blue_grey"),
    )
    back.add(
        local(
            rounded_box(
                (bcx, 0.0, (DECK_TOP + board_t + TOP - PAPER) / 2),
                (back_len, WIDTH - 0.02, TOP - PAPER - DECK_TOP - board_t),
                0.025,
            )
        ),
        name="backrest_mattress",
        color=rgb("teal_light"),
    )
    back.add(
        local(box((bcx, 0.0, TOP - PAPER / 2 - 0.0005), (back_len - 0.04, 0.55, PAPER + 0.001))),
        name="backrest_paper",
        color=rgb("white"),
    )
    pillow_cx = 0.78
    back.add(
        local(rounded_box((pillow_cx, 0.0, TOP + PILLOW_T / 2 - 0.002), (0.36, 0.56, PILLOW_T + 0.004), 0.025)),
        name="pillow",
        color=rgb("white"),
    )

    model.joint(
        "backrest_hinge",
        frame.at(hinge),
        back.at((0.0, 0.0, 0.0)),
        dofs=revolute("y", -1.1, 0.0),
    )
    model.articulation("main", root=frame, joints=["backrest_hinge"])

    meta.anchor("patient_hip", "frame", (0.0, 0.0, TOP), (0.0, 0.0, 1.0))
    meta.anchor(
        "patient_head",
        "backrest",
        (0.72 - hinge[0], 0.0, TOP + PILLOW_T - hinge[2]),
        (0.0, 0.0, 1.0),
    )
    meta.poses = {
        "flat": {"backrest_hinge": 0.0},
        "reclined_45": {"backrest_hinge": -math.pi / 4},
        "sitting": {"backrest_hinge": -1.1},
    }
    meta.extra = {
        "mattressTopHeight": TOP,
        "pillowTopHeight": TOP + PILLOW_T,
        "size": [LENGTH, WIDTH, TOP],
        "headDirection": [1.0, 0.0, 0.0],
    }
    meta.zup_vectors = ["headDirection"]
    return model, meta


def allowances(ctx) -> None:
    for side in ("l", "r"):
        ctx.allow_overlap(
            "frame",
            "backrest",
            shape_a=f"hinge_barrel_{side}",
            shape_b="backrest_board",
            reason="hinge barrel is the pin captured by the backrest board",
        )


def checks(ctx) -> None:
    ctx.expect_metric("seat_top_z", ctx.shape_world_bounds("frame", "seat_paper")[1][2], minimum=0.699, maximum=0.701, unit="m")
    ctx.expect_contact("frame", "backrest", shape_a="deck", shape_b="backrest_board", contact_tol=1e-4)
    with ctx.pose({"backrest_hinge": -1.1}):
        lo, hi = ctx.part_world_bounds("backrest")
        ctx.check("backrest_rises_when_reclined", hi[2] > 1.2, f"top z={hi[2]:.3f}")
    ctx.expect_metric("mattress_top", ctx.part_world_bounds("frame")[1][2], minimum=0.69, maximum=0.88)


if __name__ == "__main__":
    m, meta = build()
    finalize(
        m,
        meta,
        extra_checks=checks,
        allowances=allowances,
        preview_views=[
            ("", ModelView.three_quarter(width=640, height=480, color_by="material")),
        ],
        preview_pose=None,
    )
