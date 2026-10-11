"""Adult male mannequin patient (~1.75 m), short dark hair, blue gown.

See patient.py for the shared rig, axis conventions and anchors.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import rgb  # noqa: E402
from patient import PatientParams, run  # noqa: E402

PARAMS = PatientParams(
    name="patient_adult_male",
    height=1.75,
    skin=(0.80, 0.62, 0.50),
    hair=(0.14, 0.11, 0.09),
    iris=(0.30, 0.20, 0.12),
    gown=rgb("gown"),
    hair_style="short",
    description="Adult male, ~40 years, 1.75 m",
)

if __name__ == "__main__":
    run(PARAMS)
