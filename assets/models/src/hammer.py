"""Taylor reflex hammer.

Local frame: Z up, handle along X, rubber head at +X; the broad striking edge
faces +Z.  Anchors: ``tip`` (centre of the broad striking edge, normal +Z),
``grip`` (handle middle).
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from articraft.sdk import ExtrudeGeometry, ModelView, RigidBodyAssembly, SphereGeometry  # noqa: E402

from common import AssetMeta, finalize, rgb, segment_cylinder  # noqa: E402

HEAD_X = 0.10


def build():
    model = RigidBodyAssembly("hammer")
    meta = AssetMeta()
    body = model.rigid_body("hammer")
    body.add(segment_cylinder((-0.12, 0, 0), (HEAD_X, 0, 0), 0.0065, radial_segments=12), name="handle", color=rgb("steel"))
    body.add(segment_cylinder((-0.12, 0, 0), (-0.04, 0, 0), 0.0085, radial_segments=12), name="grip", color=rgb("dark_grey"))
    body.add(SphereGeometry(0.009, width_segments=10, height_segments=6).translate(-0.122, 0, 0), name="end_ball", color=rgb("steel"))
    # triangular rubber head: profile in the X/Z plane, extruded along Y
    profile = [(-0.016, 0.038), (0.016, 0.038), (0.005, -0.030), (-0.005, -0.030)]
    head = ExtrudeGeometry(profile, 0.024)  # profile XY, extrude Z
    head.rotate_x(math.pi / 2)  # profile Y -> Z, extrusion -> Y
    head.translate(HEAD_X + 0.004, 0.0, 0.0)
    body.add(head, name="rubber_head", color=rgb("coral"))

    meta.anchor("tip", "hammer", (HEAD_X + 0.004, 0.0, 0.038), (0.0, 0.0, 1.0))
    meta.anchor("tip_point", "hammer", (HEAD_X + 0.004, 0.0, -0.030), (0.0, 0.0, -1.0))
    meta.anchor("grip", "hammer", (-0.08, 0.0, 0.0))
    return model, meta


def checks(ctx):
    lo, hi = ctx.shape_world_bounds("hammer", "rubber_head")
    ctx.expect_metric("head_height", hi[2] - lo[2], minimum=0.06, maximum=0.08, unit="m")


if __name__ == "__main__":
    m, meta = build()
    finalize(m, meta, extra_checks=checks, preview_views=[("", ModelView(direction=(0.5, -1.0, 0.4), width=480, height=360, color_by="material"))])
