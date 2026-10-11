"""Instrument trolley with a rimmed top tray and five labelled tool slots.

Frame: Z up, origin on the floor under the trolley centre; long side along X.
Tray top surface at z = 0.90 m.  Each slot is a coloured mat; its anchor sits
on the mat top surface (normal +Z) where the tool's ``grip``/centre should rest.
Anchors: slot_stethoscope, slot_penlight, slot_hammer, slot_bp_cuff,
slot_thermometer, handle.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from articraft.sdk import ModelView, RigidBodyAssembly, SphereGeometry  # noqa: E402

from common import AssetMeta, box, finalize, rgb, rounded_box, segment_cylinder  # noqa: E402

TOP = 0.90
L, W = 0.60, 0.42
MAT_T = 0.004

SLOTS = {
    "slot_stethoscope": ((-0.15, 0.085), (0.25, 0.20), "teal_light"),
    "slot_bp_cuff": ((-0.15, -0.105), (0.25, 0.16), "light_blue_grey"),
    "slot_penlight": ((0.145, 0.135), (0.25, 0.07), "teal_light"),
    "slot_hammer": ((0.145, 0.035), (0.25, 0.10), "light_blue_grey"),
    "slot_thermometer": ((0.145, -0.105), (0.25, 0.16), "teal_light"),
}


def build():
    model = RigidBodyAssembly("tray")
    meta = AssetMeta()
    b = model.rigid_body("trolley")
    plate_t = 0.012
    b.add(box((0, 0, TOP - plate_t / 2), (L, W, plate_t)), name="tray_plate", color=rgb("steel"))
    rim_h = 0.03
    for name, c, s in (
        ("rim_px", (L / 2 - 0.005, 0, TOP + rim_h / 2 - 0.002), (0.01, W, rim_h + 0.004)),
        ("rim_nx", (-L / 2 + 0.005, 0, TOP + rim_h / 2 - 0.002), (0.01, W, rim_h + 0.004)),
        ("rim_py", (0, W / 2 - 0.005, TOP + rim_h / 2 - 0.002), (L, 0.01, rim_h + 0.004)),
        ("rim_ny", (0, -W / 2 + 0.005, TOP + rim_h / 2 - 0.002), (L, 0.01, rim_h + 0.004)),
    ):
        b.add(box(c, s), name=name, color=rgb("steel"))
    shelf_z = 0.30
    b.add(box((0, 0, shelf_z), (L - 0.02, W - 0.02, 0.012)), name="lower_shelf", color=rgb("light_blue_grey"))
    for i, (x, y) in enumerate([(0.27, 0.18), (0.27, -0.18), (-0.27, 0.18), (-0.27, -0.18)]):
        b.add(segment_cylinder((x, y, 0.07), (x, y, TOP - 0.006), 0.013, radial_segments=10), name=f"leg_{i}", color=rgb("steel"))
        b.add(segment_cylinder((x, y, 0.045), (x, y, 0.075), 0.008, radial_segments=8), name=f"caster_stem_{i}", color=rgb("mid_grey"))
        b.add(SphereGeometry(0.03, width_segments=10, height_segments=6).translate(x, y, 0.03), name=f"caster_{i}", color=rgb("rubber"))
    # push handle at -X end
    for s in (1, -1):
        b.add(segment_cylinder((-0.27, 0.15 * s, TOP - 0.03), (-0.36, 0.15 * s, TOP + 0.06), 0.009, radial_segments=8), name=f"handle_arm_{'l' if s > 0 else 'r'}", color=rgb("steel"))
    b.add(segment_cylinder((-0.36, -0.17, TOP + 0.06), (-0.36, 0.17, TOP + 0.06), 0.013, radial_segments=10), name="handle_bar", color=rgb("teal"))
    # front drawer between shelves (decorative)
    b.add(rounded_box((0.0, 0.0, 0.7845), (0.50, 0.36, 0.209), 0.01, tol=0.006), name="drawer_box", color=rgb("white"))
    b.add(box((0.2505, 0.0, 0.78), (0.003, 0.12, 0.02)), name="drawer_pull", color=rgb("teal"))

    for anchor_id, ((x, y), (sx, sy), col) in SLOTS.items():
        b.add(box((x, y, TOP + MAT_T / 2 - 0.0005), (sx, sy, MAT_T + 0.001)), name=f"mat_{anchor_id[5:]}", color=rgb(col))
        meta.anchor(anchor_id, "trolley", (x, y, TOP + MAT_T), (0.0, 0.0, 1.0))
    meta.anchor("handle", "trolley", (-0.36, 0.0, TOP + 0.06))
    meta.extra = {"trayTopHeight": TOP + MAT_T, "size": [L, W, TOP]}
    return model, meta


def checks(ctx):
    lo, hi = ctx.shape_world_bounds("trolley", "tray_plate")
    ctx.expect_metric("tray_top", hi[2], minimum=0.899, maximum=0.901, unit="m")


if __name__ == "__main__":
    m, meta = build()
    finalize(m, meta, extra_checks=checks)
