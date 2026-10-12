# Realistic patient models (drop-in GLB)

The built-in patients are generated from simple shapes (`assets/models/src/patient*.py`). A
realistic, rigged human GLB can replace any of them without code changes:

```
apps/sim/public/models/humans/adult_male.glb
apps/sim/public/models/humans/adult_female.glb
apps/sim/public/models/humans/elderly.glb
apps/sim/public/models/humans/child.glb
```

When a file is present, the app (`apps/sim/src/scene/humanoid.ts`):

1. Shows the rest pose (imported animation clips are ignored).
2. Brings the arms down from a T- or A-pose to lie along the body.
3. Lays the body supine on the bed, head on the pillow, face up, back on the mattress.
4. Places every exam point (heart, lungs, pupils, pulses, knee reflex…) from the skeleton.
5. Breathes at the case's respiratory rate by moving the spine. It blinks through blend shapes
   named like `eyeBlinkLeft`, `Blink` or `Eyes_Closed`, and turns the head when the patient is in
   pain.

If the skeleton can't be recognised, the browser console says which bones are missing and the
built-in patient is used instead.

Models **without a skeleton** work too if they are already lying down (or standing with the
arms down). They are oriented from their head, eye and leg meshes. Exam points are found by
casting rays onto the real body surface, and breathing gently moves the shirt and torso meshes.
The current adult male (`humans/adult_male.glb`, "Ali_MRI", CC BY 4.0, see `humans/CREDITS.md`)
is this kind.

## What to send

| | Requirement |
|---|---|
| Format | Binary glTF 2.0 (`.glb`) with textures embedded (JPG/PNG/WebP, up to 2048 px) |
| Rig | A humanoid skeleton. Supported naming: Mixamo, Character Creator / iClone, Unreal mannequin, Rigify, VRM, or plain names such as `Hips`, `Spine`, `Neck`, `Head`, `LeftArm`/`UpperArm_L`, `LeftForeArm`/`LowerArm_L`, `LeftHand`, `LeftUpLeg`/`Thigh_L`, `LeftLeg`/`Calf_L`, `LeftFoot`, `LeftToeBase` |
| Pose | Standing, T-pose or A-pose, facing forward. Toe or eye bones help the app tell front from back |
| Clothing | Hospital gown, or shorts/underwear, so the chest, abdomen, arms and lower legs can be examined |
| Face | Optional: blink blend shapes (ARKit names are ideal), jaw-open for speech |
| Size | Real-world scale in metres if possible. Under 15 MB and about 60,000 triangles per patient, so a lab of 30 PCs loads quickly |
| Licence | Must allow the university to use the model **and serve it to students' browsers**. Read the licence before sending; some popular sources forbid this (see below) |

### Sources that fit

- **MakeHuman / MPFB (Blender add-on):** realistic bodies with a game rig. Exports are CC0. You
  can set age, sex and build for each of the four patients.
- **Reallusion Character Creator 4 / ActorCore:** highly realistic, exports a rigged GLB. Check
  that the licence covers real-time use in the university's own app.
- **Your own scans or commissioned artwork:** best realism, and the university owns the result.

Avoid **MetaHuman**: its licence only allows rendering in Unreal Engine. **Mixamo** characters and
**Daz3D** models need their licence checked before they can be served from a web app.

## Optional settings

Next to the model, `humans/<model>.json` can set:

```json
{
  "height": 1.78,
  "anchors": { "heart_auscultation": [-0.08, 0.05, 0.14] }
}
```

- `height`: standing height in metres. The model is scaled to it.
- `anchors`: moves an exam point. The values are metres toward the head, toward the patient's
  left, and out of the skin, measured from its bone.

## Checking a new model

Run the app with the model in place and open a case. Check that:

- the patient lies flat on the mattress, face up, head on the pillow, arms at the sides;
- in the Examination panel, each instrument's markers sit on the right spots in the Chest,
  Head and Back views;
- the chest rises with the respiratory rate.

`npm run screenshots` captures every view into `docs/screenshots/` for review.
