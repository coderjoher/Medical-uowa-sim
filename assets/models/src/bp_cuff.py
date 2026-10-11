"""Blood-pressure cuff (sphygmomanometer) with inflation bulb and dial gauge.

Local frame: Z up.  The cuff is an open band wrapped around the X axis (the
arm axis); the opening of the band faces +Z.  Tubing runs from the band to a
dial gauge and an inflation bulb.
Anchors: ``tip`` (inner skin-contact surface of the band opposite the opening,
normal +Z = towards the arm axis), ``center`` (band axis centre: align this
with the arm axis), ``bulb`` (squeeze point), ``gauge`` (dial face).
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from articraft.sdk import LatheGeometry, ModelView, RigidBodyAssembly  # noqa: E402
from articraft.sdk.mesh import tube_from_spline_points  # noqa: E402

from common import AssetMeta, ellipsoid, finalize, rgb, segment_cylinder  # noqa: E402

R_IN = 0.052
R_OUT = 0.064
HALF_W = 0.07
GAP = 0.9  # rad left open at the top (+Z)


def build():
    model = RigidBodyAssembly("bp_cuff")
    meta = AssetMeta()
    body = model.rigid_body("bp_cuff")
    band = LatheGeometry(
        [(R_IN, -HALF_W), (R_OUT, -HALF_W), (R_OUT, HALF_W), (R_IN, HALF_W)],
        segments=28,
        angle=2 * math.pi - GAP,
        axis="x",
    )
    # rotate so the gap is centred on +Z
    lo, hi = band.bounds
    band.rotate_x(math.pi / 2 + GAP / 2)
    body.add(band, name="cuff_band", color=rgb("gown_dark"))
    # velcro strip / seam (visual)
    body.add(
        LatheGeometry(
            [(R_OUT - 0.001, -0.02), (R_OUT + 0.003, -0.02), (R_OUT + 0.003, 0.02), (R_OUT - 0.001, 0.02)],
            segments=16,
            angle=1.6,
            axis="x",
        ).rotate_x(math.pi + 0.3),
        name="cuff_strap",
        color=rgb("teal_dark"),
    )
    # tube port at the -Y side
    port = (0.0, -R_OUT + 0.003, -0.02)
    port_end = (0.0, -R_OUT - 0.012, -0.03)
    body.add(segment_cylinder(port, port_end, 0.006, radial_segments=10), name="port", color=rgb("dark_grey"))
    gauge_c = (0.03, -0.20, -0.06)
    bulb_c = (-0.06, -0.26, -0.13)
    body.add(
        tube_from_spline_points([port_end, (0.0, -0.10, -0.06), (0.02, -0.16, -0.07), (gauge_c[0], gauge_c[1] + 0.02, gauge_c[2])], radius=0.0045, samples_per_segment=6, radial_segments=8),
        name="tube_gauge",
        color=rgb("charcoal"),
    )
    body.add(
        tube_from_spline_points([port_end, (-0.01, -0.12, -0.09), (-0.05, -0.19, -0.12), (bulb_c[0], bulb_c[1] + 0.035, bulb_c[2])], radius=0.0045, samples_per_segment=6, radial_segments=8),
        name="tube_bulb",
        color=rgb("charcoal"),
    )
    # dial gauge: disc facing +Z
    body.add(segment_cylinder((gauge_c[0], gauge_c[1], gauge_c[2] - 0.012), (gauge_c[0], gauge_c[1], gauge_c[2] + 0.010), 0.032, radial_segments=20), name="gauge_body", color=rgb("steel"))
    body.add(segment_cylinder((gauge_c[0], gauge_c[1], gauge_c[2] + 0.009), (gauge_c[0], gauge_c[1], gauge_c[2] + 0.013), 0.027, radial_segments=20), name="gauge_face", color=rgb("white"))
    body.add(segment_cylinder((gauge_c[0], gauge_c[1] + 0.03, gauge_c[2]), (gauge_c[0], gauge_c[1] + 0.012, gauge_c[2]), 0.006, radial_segments=10), name="gauge_stem", color=rgb("steel"))
    # needle (thin box approximated by a flat cylinder segment)
    body.add(segment_cylinder((gauge_c[0], gauge_c[1], gauge_c[2] + 0.014), (gauge_c[0] + 0.018, gauge_c[1] + 0.010, gauge_c[2] + 0.014), 0.0016, radial_segments=6), name="gauge_needle", color=rgb("coral"))
    # bulb + valve
    body.add(ellipsoid(bulb_c, (0.030, 0.042, 0.030), segments=(16, 10)), name="bulb", color=rgb("charcoal"))
    body.add(segment_cylinder((bulb_c[0], bulb_c[1] + 0.03, bulb_c[2]), (bulb_c[0], bulb_c[1] + 0.05, bulb_c[2]), 0.008, radial_segments=10), name="valve", color=rgb("steel"))

    bottom = (0.0, 0.0, -R_IN)
    meta.anchor("tip", "bp_cuff", bottom, (0.0, 0.0, 1.0))
    meta.anchor("center", "bp_cuff", (0.0, 0.0, 0.0))
    meta.anchor("bulb", "bp_cuff", bulb_c)
    meta.anchor("gauge", "bp_cuff", (gauge_c[0], gauge_c[1], gauge_c[2] + 0.013), (0.0, 0.0, 1.0))
    meta.extra = {"cuffAxis": [1.0, 0.0, 0.0], "cuffInnerRadius": R_IN}
    meta.zup_vectors = ["cuffAxis"]
    return model, meta


if __name__ == "__main__":
    m, meta = build()
    finalize(m, meta, preview_views=[("", ModelView(direction=(0.8, -1.0, 0.7), width=480, height=400, color_by="material"))])
