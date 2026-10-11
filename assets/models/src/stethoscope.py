"""Stethoscope: chest piece, Y tubing, binaurals and ear tips.

Local frame: Z up.  The chest piece sits at the origin with its diaphragm
facing -Z; tubing runs towards +X to the binaurals.
Anchors: ``tip`` (diaphragm face centre, normal -Z), ``grip`` (chest piece
stem, where the fingers hold it), ``earpiece_l`` / ``earpiece_r``.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from articraft.sdk import ModelView, RigidBodyAssembly, SphereGeometry  # noqa: E402
from articraft.sdk.mesh import tube_from_spline_points  # noqa: E402

from common import AssetMeta, finalize, rgb, segment_cylinder  # noqa: E402

TUBE_R = 0.0055


def build():
    model = RigidBodyAssembly("stethoscope")
    meta = AssetMeta()
    body = model.rigid_body("stethoscope")
    # chest piece
    body.add(segment_cylinder((0, 0, -0.006), (0, 0, 0.008), 0.024, radial_segments=24), name="diaphragm_head", color=rgb("steel"))
    body.add(segment_cylinder((0, 0, -0.0075), (0, 0, -0.004), 0.0215, radial_segments=24), name="diaphragm", color=rgb("charcoal"))
    body.add(segment_cylinder((0, 0, 0.007), (0, 0, 0.016), 0.014, radial_segments=16), name="bell", color=rgb("steel"))
    body.add(segment_cylinder((0.0, 0, 0.012), (0.04, 0, 0.012), 0.005, radial_segments=10), name="stem", color=rgb("steel"))
    # main tube from the stem to the Y junction
    yj = (0.36, 0.0, 0.03)
    body.add(
        tube_from_spline_points([(0.036, 0, 0.012), (0.12, 0.04, 0.02), (0.24, -0.03, 0.03), yj], radius=TUBE_R, samples_per_segment=6, radial_segments=10),
        name="tube_main",
        color=rgb("teal_dark"),
    )
    body.add(SphereGeometry(0.009, width_segments=10, height_segments=6).translate(*yj), name="y_junction", color=rgb("teal_dark"))
    ear = {}
    for side, s in (("l", 1.0), ("r", -1.0)):
        b_start = (0.50, 0.055 * s, 0.03)
        body.add(
            tube_from_spline_points([yj, (0.43, 0.035 * s, 0.03), b_start], radius=TUBE_R, samples_per_segment=6, radial_segments=10),
            name=f"tube_{side}",
            color=rgb("teal_dark"),
        )
        tip = (0.66, 0.028 * s, 0.03)
        body.add(
            tube_from_spline_points([(0.495, 0.055 * s, 0.03), (0.58, 0.066 * s, 0.03), (0.645, 0.045 * s, 0.03), tip], radius=0.0028, samples_per_segment=6, radial_segments=8),
            name=f"binaural_{side}",
            color=rgb("steel"),
        )
        body.add(SphereGeometry(0.0075, width_segments=10, height_segments=6).translate(*tip), name=f"ear_tip_{side}", color=rgb("charcoal"))
        ear[side] = tip
    body.add(segment_cylinder((0.53, -0.06, 0.03), (0.53, 0.06, 0.03), 0.002, radial_segments=6), name="spring", color=rgb("steel"))

    meta.anchor("tip", "stethoscope", (0.0, 0.0, -0.0075), (0.0, 0.0, -1.0))
    meta.anchor("grip", "stethoscope", (0.0, 0.0, 0.016))
    meta.anchor("earpiece_l", "stethoscope", ear["l"])
    meta.anchor("earpiece_r", "stethoscope", ear["r"])
    return model, meta


if __name__ == "__main__":
    m, meta = build()
    finalize(m, meta, preview_views=[("", ModelView(direction=(0.3, -0.6, 1.0), width=560, height=360, color_by="material"))])
