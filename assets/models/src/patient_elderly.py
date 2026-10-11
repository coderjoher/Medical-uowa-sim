"""Elderly male mannequin patient (~1.68 m): thinner limbs, slightly stooped
(rounded upper back, shoulders and head carried forward), balding grey hair.

See patient.py for the shared rig, axis conventions and anchors.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import rgb  # noqa: E402,F401
from patient import PatientParams, run  # noqa: E402

PARAMS = PatientParams(
    name="patient_elderly",
    height=1.68,
    pelvis_r=(0.115, 0.16, 0.105),
    abdomen_r=(0.11, 0.145, 0.112),
    chest_r=(0.155, 0.155, 0.112),
    head_r=(0.112, 0.083, 0.098),
    neck_r=0.045,
    shoulder_y=0.185,
    arm_y=0.204,
    hip_y=0.085,
    upper_arm_r=0.037,
    forearm_r=0.030,
    hand_len=0.175,
    hand_half=(0.0, 0.014, 0.038),
    thigh_r=0.060,
    shin_r=0.041,
    foot_len=0.245,
    foot_r=(0.037, 0.042),
    chest_lift=0.015,
    shoulder_lift=0.015,
    head_lift=0.075,
    skin=(0.84, 0.70, 0.62),
    hair=(0.80, 0.80, 0.78),
    iris=(0.35, 0.40, 0.45),
    gown=(0.72, 0.80, 0.84),
    lip=(0.66, 0.44, 0.44),
    hair_style="balding",
    description="Elderly male, ~78 years, 1.68 m, thin and slightly stooped",
)

if __name__ == "__main__":
    run(PARAMS)
