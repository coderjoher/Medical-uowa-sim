"""Penlight (pupil examination torch).

Local frame: Z up, the torch lies along X with the lamp at +X.
Anchors: ``tip`` (lens face centre, normal +X), ``grip`` (middle of the barrel).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from articraft.sdk import ModelView, RigidBodyAssembly  # noqa: E402

from common import AssetMeta, box, finalize, rgb, segment_cylinder  # noqa: E402

R = 0.0095  # chunky 19 mm barrel so it reads on a large screen


def build():
    model = RigidBodyAssembly("penlight")
    meta = AssetMeta()
    body = model.rigid_body("penlight")
    body.add(segment_cylinder((-0.070, 0, 0), (0.055, 0, 0), R, radial_segments=16), name="barrel", color=rgb("teal"))
    body.add(segment_cylinder((-0.078, 0, 0), (-0.069, 0, 0), R * 0.95, radial_segments=16), name="tail_cap", color=rgb("dark_grey"))
    body.add(segment_cylinder((-0.074, 0, 0), (-0.070, 0, 0), R * 1.02, radial_segments=16), name="button", color=rgb("white"))
    body.add(segment_cylinder((0.054, 0, 0), (0.076, 0, 0), R * 1.12, radial_segments=16), name="head_ring", color=rgb("steel"))
    body.add(segment_cylinder((0.075, 0, 0), (0.079, 0, 0), R * 0.85, radial_segments=16), name="lens", color=rgb("lens"))
    body.add(box((-0.020, 0.0, R + 0.002), (0.060, 0.007, 0.004)), name="clip", color=rgb("steel"))
    body.add(box((-0.050, 0.0, R + 0.0005), (0.010, 0.007, 0.004)), name="clip_root", color=rgb("steel"))

    meta.anchor("tip", "penlight", (0.079, 0.0, 0.0), (1.0, 0.0, 0.0))
    meta.anchor("grip", "penlight", (-0.02, 0.0, 0.0))
    meta.extra = {"pointing": [1.0, 0.0, 0.0]}
    meta.zup_vectors = ["pointing"]
    return model, meta


def checks(ctx):
    lo, hi = ctx.part_world_bounds("penlight")
    ctx.expect_metric("length", hi[0] - lo[0], minimum=0.14, maximum=0.18, unit="m")


if __name__ == "__main__":
    m, meta = build()
    finalize(m, meta, extra_checks=checks, preview_views=[("", ModelView(direction=(0.6, -1.0, 0.6), width=480, height=360, color_by="material"))])
