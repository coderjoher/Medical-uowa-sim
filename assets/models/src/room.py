"""Examination room shell: floor, three walls (open towards -Y for the camera),
doctor's desk with chair and monitor, wall-mounted cabinet, wash basin, window.

Frame: Z up, origin at floor centre.  Floor 5.0 (X) x 4.0 (Y) m, walls 2.8 m
high at y = +2 (back) and x = +-2.5 (sides).  No ceiling.  Static: one body.
Anchors (floor positions, normal +Z) suggesting a layout:
  bed_spot (bed centre, bed long axis along +X with the head at +X),
  monitor_spot, tray_spot, doctor_spot, desk_top, chair_spot, camera_hint.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from articraft.sdk import ModelView, RigidBodyAssembly  # noqa: E402

from common import AssetMeta, box, finalize, rgb, segment_cylinder  # noqa: E402

FX, FY, H, T = 5.0, 4.0, 2.8, 0.1


def build():
    model = RigidBodyAssembly("room")
    meta = AssetMeta()
    r = model.rigid_body("room")
    add = lambda n, c, s, col: r.add(box(c, s), name=n, color=rgb(col))  # noqa: E731
    add("floor", (0, 0, -0.02), (FX + 2 * T, FY + T, 0.04), "floor")
    add("wall_back", (0, FY / 2 + T / 2, H / 2), (FX + 2 * T, T, H), "wall")
    add("wall_left", (-FX / 2 - T / 2, 0, H / 2), (T, FY, H), "wall")
    add("wall_right", (FX / 2 + T / 2, 0, H / 2), (T, FY, H), "wall")
    # accent band and skirting
    add("band_back", (0, FY / 2 - 0.005, 1.0), (FX, 0.012, 0.12), "wall_accent")
    add("band_left", (-FX / 2 + 0.005, 0, 1.0), (0.012, FY, 0.12), "wall_accent")
    add("band_right", (FX / 2 - 0.005, 0, 1.0), (0.012, FY, 0.12), "wall_accent")
    add("skirt_back", (0, FY / 2 - 0.01, 0.05), (FX, 0.022, 0.10), "blue_grey")
    add("skirt_left", (-FX / 2 + 0.01, 0, 0.05), (0.022, FY, 0.10), "blue_grey")
    add("skirt_right", (FX / 2 - 0.01, 0, 0.05), (0.022, FY, 0.10), "blue_grey")
    # window on the right wall
    add("window_frame", (FX / 2 - 0.02, 0.2, 1.65), (0.04, 1.4, 1.1), "white")
    add("window_pane", (FX / 2 - 0.045, 0.2, 1.65), (0.012, 1.26, 0.96), "light_blue_grey")
    add("window_mullion", (FX / 2 - 0.055, 0.2, 1.65), (0.012, 0.04, 0.96), "white")

    # doctor's desk in the back-left corner
    dx, dy, dw, dd, dh = -1.65, 1.55, 1.4, 0.7, 0.75
    add("desk_top", (dx, dy, dh - 0.015), (dw, dd, 0.03), "wood")
    add("desk_pedestal", (dx + dw / 2 - 0.22, dy, (dh - 0.03) / 2), (0.40, dd - 0.06, dh - 0.03), "white")
    add("desk_drawer_line", (dx + dw / 2 - 0.22, dy - dd / 2 + 0.025, 0.45), (0.36, 0.01, 0.01), "mid_grey")
    add("desk_leg_l", (dx - dw / 2 + 0.04, dy, (dh - 0.03) / 2), (0.04, dd - 0.06, dh - 0.03), "white")
    add("desk_modesty", (dx - 0.1, dy + dd / 2 - 0.03, 0.45), (dw - 0.5, 0.02, 0.5), "white")
    add("pc_screen", (dx - 0.1, dy + 0.15, dh + 0.25), (0.55, 0.03, 0.34), "charcoal")
    add("pc_stand", (dx - 0.1, dy + 0.18, dh + 0.04), (0.06, 0.04, 0.10), "dark_grey")
    add("pc_base", (dx - 0.1, dy + 0.18, dh + 0.005), (0.22, 0.16, 0.01), "dark_grey")
    add("keyboard", (dx - 0.1, dy - 0.12, dh + 0.01), (0.44, 0.15, 0.02), "light_blue_grey")
    add("folder", (dx + 0.45, dy - 0.05, dh + 0.02), (0.24, 0.32, 0.04), "teal")
    # chair
    cx, cy = dx - 0.1, dy - 0.75
    add("chair_seat", (cx, cy, 0.48), (0.46, 0.46, 0.07), "teal_dark")
    add("chair_back", (cx, cy - 0.24, 0.80), (0.44, 0.05, 0.52), "teal_dark")
    add("chair_back_post", (cx, cy - 0.235, 0.53), (0.06, 0.04, 0.12), "dark_grey")
    r.add(segment_cylinder((cx, cy, 0.06), (cx, cy, 0.46), 0.025, radial_segments=10), name="chair_column", color=rgb("dark_grey"))
    add("chair_foot_x", (cx, cy, 0.05), (0.6, 0.05, 0.04), "dark_grey")
    add("chair_foot_y", (cx, cy, 0.05), (0.05, 0.6, 0.04), "dark_grey")
    for i, (ox, oy) in enumerate(((0.28, 0), (-0.28, 0), (0, 0.28), (0, -0.28))):
        add(f"chair_wheel_{i}", (cx + ox, cy + oy, 0.0149), (0.05, 0.05, 0.03), "rubber")

    # wall cabinet on the back wall, above the bed area
    kx, kw, kd, kz0, kz1 = 0.6, 1.2, 0.35, 1.55, 2.25
    add("cabinet_body", (kx, FY / 2 - kd / 2, (kz0 + kz1) / 2), (kw, kd, kz1 - kz0), "white")
    for i, off in enumerate((-kw / 4, kw / 4)):
        add(f"cabinet_door_{i}", (kx + off, FY / 2 - kd - 0.01, (kz0 + kz1) / 2), (kw / 2 - 0.02, 0.02, kz1 - kz0 - 0.04), "light_blue_grey")
        add(f"cabinet_handle_{i}", (kx + off + (-1 if i == 0 else 1) * (-kw / 4 + 0.06), FY / 2 - kd - 0.03, kz0 + 0.12), (0.02, 0.02, 0.14), "teal")
    add("cabinet_cross", (kx, FY / 2 - kd - 0.021, kz1 - 0.12), (0.16, 0.004, 0.05), "teal")
    add("cabinet_cross_v", (kx, FY / 2 - kd - 0.021, kz1 - 0.12), (0.05, 0.004, 0.16), "teal")

    # wash basin on the right wall
    sx, sy = FX / 2, -1.2
    add("basin", (sx - 0.25, sy, 0.85), (0.5, 0.6, 0.18), "white")
    add("basin_bowl", (sx - 0.27, sy, 0.935), (0.34, 0.44, 0.012), "light_blue_grey")
    add("basin_pedestal", (sx - 0.2, sy, 0.38), (0.18, 0.22, 0.76), "white")
    r.add(segment_cylinder((sx - 0.06, sy, 0.94), (sx - 0.06, sy, 1.06), 0.015, radial_segments=10), name="tap", color=rgb("steel"))
    add("tap_spout", (sx - 0.12, sy, 1.06), (0.13, 0.025, 0.025), "steel")
    add("soap_dispenser", (sx - 0.04, sy + 0.45, 1.25), (0.08, 0.10, 0.20), "teal")
    add("mirror", (sx - 0.006, sy, 1.55), (0.012, 0.5, 0.6), "light_blue_grey")

    floor_n = (0.0, 0.0, 1.0)
    meta.anchor("bed_spot", "room", (0.3, 0.6, 0.0), floor_n)
    meta.anchor("monitor_spot", "room", (1.65, 1.35, 0.0), floor_n)
    meta.anchor("tray_spot", "room", (-0.95, -0.25, 0.0), floor_n)
    meta.anchor("doctor_spot", "room", (0.3, -0.35, 0.0), floor_n)
    meta.anchor("chair_spot", "room", (cx, cy, 0.0), floor_n)
    meta.anchor("desk_top", "room", (dx, dy, dh), floor_n)
    meta.anchor("camera_hint", "room", (0.3, -2.6, 1.65))
    meta.extra = {"floorSize": [FX, FY], "wallHeight": H, "openSide": [0.0, -1.0, 0.0]}
    meta.zup_vectors = ["openSide"]
    return model, meta


if __name__ == "__main__":
    m, meta = build()
    finalize(m, meta, preview_views=[("", ModelView(direction=(0.7, -1.0, 0.8), width=720, height=540, color_by="material"))])
