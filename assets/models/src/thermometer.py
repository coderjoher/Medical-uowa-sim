"""Infrared forehead thermometer (pistol form).

Local frame: Z up, the sensor points +X; the handle hangs down (-Z) from the
rear of the head.  Anchors: ``tip`` (sensor window centre, normal +X),
``grip`` (handle middle), ``display`` (rear display centre, normal -X).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from articraft.sdk import ModelView, RigidBodyAssembly  # noqa: E402

from common import AssetMeta, box, finalize, rgb, rounded_box, segment_cylinder  # noqa: E402


def build():
    model = RigidBodyAssembly("thermometer")
    meta = AssetMeta()
    body = model.rigid_body("thermometer")
    body.add(rounded_box((0.0, 0.0, 0.0), (0.12, 0.045, 0.05), 0.016, tol=0.003), name="head", color=rgb("white"))
    body.add(segment_cylinder((0.058, 0, 0), (0.080, 0, 0), 0.017, radial_segments=16), name="nozzle", color=rgb("teal"))
    body.add(segment_cylinder((0.079, 0, 0), (0.083, 0, 0), 0.011, radial_segments=16), name="sensor_window", color=rgb("charcoal"))
    # handle, slightly raked back
    body.add(rounded_box((-0.035, 0.0, -0.065), (0.036, 0.034, 0.10), 0.012, tol=0.003), name="handle", color=rgb("white"))
    body.add(box((-0.017, 0.0, -0.040), (0.006, 0.020, 0.024)), name="trigger", color=rgb("teal"))
    body.add(box((-0.0605, 0.0, 0.004), (0.002, 0.034, 0.030)), name="display", color=rgb("screen"))
    body.add(box((-0.040, 0.0, 0.0255), (0.020, 0.018, 0.003)), name="mode_button", color=rgb("teal_dark"))

    meta.anchor("tip", "thermometer", (0.083, 0.0, 0.0), (1.0, 0.0, 0.0))
    meta.anchor("grip", "thermometer", (-0.035, 0.0, -0.07))
    meta.anchor("display", "thermometer", (-0.0615, 0.0, 0.004), (-1.0, 0.0, 0.0))
    meta.extra = {"pointing": [1.0, 0.0, 0.0]}
    meta.zup_vectors = ["pointing"]
    return model, meta


if __name__ == "__main__":
    m, meta = build()
    finalize(m, meta, preview_views=[("", ModelView(direction=(-0.6, -1.0, 0.5), width=480, height=360, color_by="material"))])
