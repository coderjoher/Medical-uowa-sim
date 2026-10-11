"""Child mannequin patient (~1.20 m, ~7 years): larger head relative to body,
short limbs, brown hair with a fringe, teal gown.

See patient.py for the shared rig, axis conventions and anchors.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import rgb  # noqa: E402,F401
from patient import PatientParams, run  # noqa: E402

PARAMS = PatientParams(
    name="patient_child",
    height=1.20,
    s_pelvis=0.55,
    s_lumbar=0.595,
    s_thorax=0.665,
    s_neck_base=0.80,
    s_shoulder=0.785,
    s_elbow=0.62,
    s_wrist=0.49,
    s_hip=0.515,
    s_knee=0.28,
    s_ankle=0.045,
    pelvis_r=(0.08, 0.115, 0.075),
    abdomen_r=(0.068, 0.105, 0.075),
    chest_r=(0.095, 0.115, 0.08),
    head_r=(0.10, 0.078, 0.09),
    neck_r=0.036,
    shoulder_y=0.13,
    arm_y=0.15,
    hip_y=0.06,
    upper_arm_r=0.030,
    forearm_r=0.026,
    hand_len=0.12,
    hand_half=(0.0, 0.012, 0.030),
    thigh_r=0.048,
    shin_r=0.035,
    foot_len=0.17,
    foot_r=(0.028, 0.032),
    eye_r=0.0125,
    eye_spacing=0.029,
    head_lift=0.05,
    skin=(0.92, 0.76, 0.64),
    hair=(0.36, 0.24, 0.14),
    iris=(0.30, 0.20, 0.12),
    gown=rgb("teal_light"),
    lip=(0.80, 0.46, 0.46),
    hair_style="child",
    description="Child, ~7 years, 1.20 m",
)

if __name__ == "__main__":
    run(PARAMS)
