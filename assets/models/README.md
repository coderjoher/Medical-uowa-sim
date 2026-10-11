# 3D assets (Articraft → GLB)

Stylised, low-poly models for the exam room: room, bed, vital-signs monitor,
instrument trolley, five hand tools and four articulated mannequin patients.
Each object is written as a Python script using the
Articraft SDK (Apache-2.0, local checkout at `/tmp/articraft-src/Articraft`). The script builds a
`RigidBodyAssembly`, validates it, runs a `TestContext` and exports USDZ. A
converter then turns each USDZ into a GLB for Babylon.js, plus a JSON sidecar.

```
assets/models/
  src/common.py          shared helpers: palette, mesh helpers, ray-cast anchors, finalize() = test + export
  src/patient.py         parametric mannequin rig shared by the 4 patient scripts
  src/<object>.py        one authoring script per object
  build/<object>/        Articraft output: usdz/0000.usdz, model.json (manifest v2), meta.json (anchors, poses)
  previews/<object>.png  headless renders from the SDK (patients also have *_face.png)
  usdz_to_glb.py         USDZ -> apps/sim/public/models/<object>.glb + <object>.json
  verify_glb.py          checks on the GLBs and sidecars (see "Verification")
  build_all.py           runs all of the above
```

## Regenerate

The Articraft venv lives at `/tmp/articraft-src/Articraft`. It provides
`articraft`, `pxr` (usd-core), `trimesh`, `numpy` and `PIL`. Run these from the
repo root:

```sh
# everything: author + test + export, convert, verify
uv run --project /tmp/articraft-src/Articraft python assets/models/build_all.py

# a single object
uv run --project /tmp/articraft-src/Articraft python assets/models/src/bed.py
uv run --project /tmp/articraft-src/Articraft python assets/models/usdz_to_glb.py bed   # no args = all of build/
uv run --project /tmp/articraft-src/Articraft python assets/models/verify_glb.py
```

A full rebuild takes about 2–3 minutes; the patient overlap checks take most of
that time. Each script fails with an `AssertionError` if its `TestContext`
report does not pass.

`finalize()` in `common.py` runs these checks on every object:
`check_model_valid`, `fail_if_mesh_unhealthy`, `fail_if_isolated_parts`,
`fail_if_parts_overlap_in_current_pose`, `fail_if_articulation_separates_child`
(sweeps every revolute joint), disconnected-island and scale warnings, and
"every anchor names an existing body". Each object adds its own checks on top,
for example:

- bed: the seat top is at 0.70 m and the backrest rises when reclined.
- monitor: the screen centre is at 1.35–1.55 m.
- patients:
  - body length and support plane,
  - head toward +X, left toward -Y,
  - the closed eyelids cover the iris and stay on the head,
  - a bent knee clears the other leg.

Patient limbs overlap at their own joint, giving a ball-and-socket look. These
overlaps are allowed only for parent/child pairs that are joined by a joint. An
overlap between any other pair of bodies still fails.

## Conventions

| | Articraft authoring / USDZ | GLB + sidecar (what the app sees) |
|---|---|---|
| up | +Z | +Y (rotated -90° about X: `(x, y, z) → (x, z, -y)`) |
| units | meters | meters |
| handedness | right-handed | right-handed glTF |

- **One glTF node per rigid body**, named exactly like the Articraft body. The
  node hierarchy follows the articulation tree.
- **Node origin = the body's joint frame to its parent.** The root node origin
  is the body origin. At rest every node is axis-aligned with its parent: there
  is no rest rotation, only a translation. Rotating a node about the joint
  `axis` rotates it about the joint.
- Geometry is grouped per colour: one primitive per colour, with a shared PBR
  material (`metallicFactor 0`, `roughnessFactor 0.8`). The colours come from
  the flat palette in `common.py`. There are no textures.
- `monitor` → node `screen` has `TEXCOORD_0`, a planar projection where u runs
  left to right and v runs top to bottom. Its material is named `screen`, so you
  can swap in a `DynamicTexture`. In Babylon's default left-handed mode the
  scene is mirrored on X, so you may need `uScale = -1` on the texture; with
  `scene.useRightHandedSystem = true` it reads correctly. Check this visually.
- **Joints**: the names are descriptive (`backrest_hinge`, `eyelid_l_blink`,
  `knee_r`, ...). In the sidecar each joint has `parent`, `child`, `type`
  (`revolute` | `prismatic` | `fixed`), `axis` (unit vector in the child node's
  local Y-up frame) and `limits` (radians or meters).
  - The converter normalises one-sided ranges so that the useful direction is
    positive. A range authored as `[lo, 0]` is written as `[0, -lo]` with the
    axis negated. Results: bed recline `[0, 1.1]`, eyelid close `[0, 1.45]`,
    knee flexion `[0, 2.3]`, spine flexion / sitting up `[0, 0.9]`, neck
    flexion `[0, 0.8]`.
  - To pose a joint:
    `node.rotationQuaternion = Quaternion.RotationAxis(new Vector3(...axis), angle)`.
    The rest rotation is the identity. This is node-local, so it works in either
    Babylon handedness mode.
  - The only `fixed` joint is `monitor.screen_mount`, which gives the screen its
    own node.
- **Named poses**: the sidecar `poses` holds ready-made joint-angle sets, using
  the same normalised signs:
  - bed: `flat`, `reclined_45`, `sitting`.
  - patients: `eyes_closed`, `reclined_45`, `head_turned_left` (for JVP),
    `knees_bent`, `arm_r_raised`.
- **Anchors**: `anchors.<id> = { body, position, normal? }`. `position` is in
  that body's node-local Y-up frame. To get a world position, use
  `Vector3.TransformCoordinates(position, node.getWorldMatrix())`; this works in
  both handedness modes. `normal`, when present, is the outward surface normal
  in the same frame.

### Patients

The patients lie **supine**:

- pelvis centre at the origin,
- head toward **+X** (`headDirection: [1,0,0]`),
- face/chest up **+Y** (`facing: [0,1,0]`),
- patient's left toward **+Z** (`leftDirection: [0,0,1]`) and right toward -Z,
- arms by the sides with palms toward the body.

The back rests on the plane `y = -supportDepth`. Other sidecar fields:
`height`, `headRestPoint` (back of the head, in the pelvis frame), `headLift`
(how far the head sits above the support plane, for the pillow), and breathing:
`breathingBody: "chest"`, `breathingAxis` and `breathingAmplitude` (scale the
`chest` node along the axis by ±amplitude).

Body tree:

```
pelvis
├─ abdomen ─ chest ─┬─ neck ─ head ─┬─ eyelid_l
│                   │               └─ eyelid_r
│                   ├─ upper_arm_l ─ forearm_l ─ hand_l
│                   └─ upper_arm_r ─ forearm_r ─ hand_r
├─ thigh_l ─ shin_l ─ foot_l
└─ thigh_r ─ shin_r ─ foot_r
```

Joints: `spine_lower`, `spine_upper`, `neck_flex`, `head_turn` (about the long
axis; positive turns the face to the patient's left), `eyelid_{l,r}_blink`,
`shoulder_*`, `elbow_*`, `wrist_*`, `hip_*`, `knee_*`, `ankle_*`. All are
revolute about the lateral axis, except `head_turn`.

Each patient has the 20 exam anchors the app uses. Every anchor is a surface
point found by ray-casting the named body's own mesh:
`general_inspection`, `pupils` (nose bridge between the eyes; `pupil_l`,
`pupil_r` are also given), `conjunctiva`, `jvp`, `carotid_pulse`,
`radial_pulse`, `blood_pressure`, `temperature`, `heart_auscultation`,
`chest_auscultation_front`, `chest_auscultation_back`, `chest_percussion`,
`chest_wall_palpation`, `abdomen_palpation`, `abdomen_auscultation`,
`calf_inspection`, `ankle_oedema`, `reflexes_knee`, `reflexes_biceps`,
`capillary_refill`.

### Placing things

- **Patient on the bed** (bed and patient are both Y-up with the head toward
  +X): put the pelvis at `bed.anchor(patient_hip) + (0, supportDepth, 0)`. You
  can also align `headRestPoint` with `bed.anchor(patient_head)`, which lies on
  the pillow. When the bed reclines, set the patient's `spine_lower` and
  `spine_upper` angles to match.
- **Room**: floor anchors `bed_spot`, `monitor_spot`, `tray_spot`,
  `doctor_spot`, `chair_spot` and `desk_top`, plus a suggested `camera_hint`.
  The room is open toward -Z in glTF (-Y in Articraft).
- **Tools**: each tool has a `tip` anchor (diaphragm face, lens, striking edge,
  cuff skin-contact point, IR sensor). Most also have a `grip`. Trolley slots
  are `slot_*` on the tray mats.

## Outputs

`verify_glb.py` produced these numbers. The GLBs are written without
compression.

| object | triangles | GLB size | nodes | anchors |
|---|---:|---:|---:|---|
| `room` | 620 | 40.7 KiB | 1 | bed_spot, monitor_spot, tray_spot, doctor_spot, chair_spot, desk_top, camera_hint |
| `bed` | 9552 | 182.0 KiB | 2 | patient_hip, patient_head |
| `monitor` | 5924 | 128.1 KiB | 3 | screen_center |
| `tray` | 2772 | 65.3 KiB | 1 | slot_stethoscope, slot_bp_cuff, slot_penlight, slot_hammer, slot_thermometer, handle |
| `stethoscope` | 2384 | 73.8 KiB | 1 | tip, grip, earpiece_l, earpiece_r |
| `penlight` | 344 | 14.7 KiB | 1 | tip, grip |
| `hammer` | 300 | 9.4 KiB | 1 | tip, tip_point, grip |
| `bp_cuff` | 1552 | 60.8 KiB | 1 | tip, center, bulb, gauge |
| `thermometer` | 5276 | 99.6 KiB | 1 | tip, grip, display |
| `patient_adult_male` | 7622 | 195.8 KiB | 19 | 22 exam anchors |
| `patient_adult_female` | 8524 | 214.3 KiB | 19 | 22 exam anchors |
| `patient_elderly` | 7610 | 196.3 KiB | 19 | 22 exam anchors |
| `patient_child` | 7820 | 198.8 KiB | 19 | 22 exam anchors |

Total: about 1.6 MB for all 13 GLBs.

## Verification

`verify_glb.py` checks the following:

- The GLB node list equals the body list.
- The sidecar joint parent/child pairs match the glTF hierarchy.
- The world bounds of each node match the Articraft reference pose, converted
  to Y-up (currently 0.00 mm error).
- Every patient anchor is within 3 cm of its body's surface. The exact
  point-to-triangle distance is currently 0.00 mm for all 88 anchors.
- No patient anchor is buried inside another body. This uses a winding-number
  test.

The GLBs also load in Babylon 9.30 (`NullEngine` with `@babylonjs/loaders`): all
bodies resolve as nodes and the triangle counts match.
