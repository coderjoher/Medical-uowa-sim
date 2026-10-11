"""Rebuild every asset: author + test + export (Articraft), convert to GLB, verify.

    uv run --project /tmp/articraft-src/Articraft python assets/models/build_all.py [name ...]
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OBJECTS = [
    "room",
    "bed",
    "monitor",
    "tray",
    "stethoscope",
    "penlight",
    "hammer",
    "bp_cuff",
    "thermometer",
    "patient_adult_male",
    "patient_adult_female",
    "patient_elderly",
    "patient_child",
]


def run(args: list[str]) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run([sys.executable, *args], check=True)


def main(names: list[str]) -> None:
    for name in names or OBJECTS:
        run([str(HERE / "src" / f"{name}.py")])
    run([str(HERE / "usdz_to_glb.py"), *names])
    run([str(HERE / "verify_glb.py")])


if __name__ == "__main__":
    main(sys.argv[1:])
