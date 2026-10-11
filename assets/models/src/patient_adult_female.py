"""Adult female mannequin patient (~1.63 m), long dark-brown hair, pink gown.

See patient.py for the shared rig, axis conventions and anchors.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import rgb  # noqa: E402,F401
from patient import PatientParams, run  # noqa: E402

PARAMS = PatientParams(
    name="patient_adult_female",
    height=1.63,
    pelvis_r=(0.12, 0.178, 0.11),
    abdomen_r=(0.10, 0.13, 0.10),
    chest_r=(0.145, 0.15, 0.108),
    head_r=(0.108, 0.08, 0.095),
    neck_r=0.045,
    shoulder_y=0.185,
    arm_y=0.222,
    hip_y=0.095,
    upper_arm_r=0.040,
    forearm_r=0.033,
    hand_len=0.165,
    hand_half=(0.0, 0.015, 0.038),
    thigh_r=0.072,
    shin_r=0.047,
    foot_len=0.23,
    foot_r=(0.036, 0.04),
    eye_r=0.013,
    eye_spacing=0.031,
    skin=(0.88, 0.72, 0.62),
    hair=(0.24, 0.15, 0.10),
    iris=(0.25, 0.32, 0.22),
    gown=rgb("gown_pink"),
    lip=(0.76, 0.40, 0.45),
    hair_style="long",
    breasts=True,
    description="Adult female, ~35 years, 1.63 m",
)

if __name__ == "__main__":
    run(PARAMS)
