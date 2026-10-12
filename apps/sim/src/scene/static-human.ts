import { Ray } from "@babylonjs/core/Culling/ray";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { PatientRig } from "./fallback.js";

/**
 * Human models without a skeleton (for example scans or posed Sketchfab exports). The body is
 * oriented from its head, eye and leg meshes, laid on the bed (it should already be lying, or
 * standing with the arms down), and exam points are found by casting rays onto the actual
 * body surface at standard anatomical proportions.
 */

/**
 * Exam points: t = distance from the top of the head as a fraction of height; side = metres
 * toward the patient's left for a 1.75 m adult (negative = right); back = on the back surface.
 * Limb points use the right side, which faces the examiner.
 */
const POINTS: Record<string, { t: number; side: number; back?: boolean; eye?: "mid" | "right" }> = {
  pupils: { t: 0, side: 0, eye: "mid" },
  conjunctiva: { t: 0, side: 0, eye: "right" },
  temperature: { t: 0.05, side: 0 },
  jvp: { t: 0.145, side: -0.045 },
  carotid_pulse: { t: 0.14, side: -0.03 },
  general_inspection: { t: 0.29, side: 0 },
  chest_wall_palpation: { t: 0.245, side: 0 },
  chest_auscultation_front: { t: 0.225, side: -0.075 },
  heart_auscultation: { t: 0.27, side: 0.045 },
  chest_percussion: { t: 0.26, side: 0.085 },
  chest_auscultation_back: { t: 0.25, side: -0.06, back: true },
  abdomen_palpation: { t: 0.36, side: 0 },
  abdomen_auscultation: { t: 0.375, side: 0.05 },
  blood_pressure: { t: 0.25, side: -0.215 },
  reflexes_biceps: { t: 0.33, side: -0.235 },
  radial_pulse: { t: 0.46, side: -0.255 },
  capillary_refill: { t: 0.53, side: -0.265 },
  reflexes_knee: { t: 0.72, side: -0.09 },
  calf_inspection: { t: 0.8, side: -0.09 },
  ankle_oedema: { t: 0.93, side: -0.075 },
};

export interface StaticHumanConfig {
  height?: number;
  anchors?: Record<string, [number, number, number]>;
}

export function poseStaticHuman(
  scene: Scene,
  root: TransformNode,
  pose: TransformNode,
  meshes: AbstractMesh[],
  cfg: StaticHumanConfig,
  defaultHeight: number,
  label: string,
): { rig: PatientRig; supportDepth: number } | null {
  const refresh = () => {
    root.computeWorldMatrix(true);
    for (const n of root.getDescendants(false)) (n as TransformNode).computeWorldMatrix?.(true);
  };
  const boxOf = (list: AbstractMesh[]) => {
    refresh();
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = min.scale(-1);
    for (const m of list) {
      m.refreshBoundingInfo({});
      const b = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, b.minimumWorld);
      max = Vector3.Maximize(max, b.maximumWorld);
    }
    return { min, max, centre: min.add(max).scale(0.5), size: max.subtract(min) };
  };
  const find = (re: RegExp) => meshes.filter((m) => re.test(m.name));
  const headMeshes = find(/head|skull|hair|face/i).filter((m) => !/headphone/i.test(m.name));
  const eyeL = find(/eye[_ .-]?l(?![a-z])|l[_ .-]?eye|lefteye|eye_left/i);
  const eyeR = find(/eye[_ .-]?r(?![a-z])|r[_ .-]?eye|righteye|eye_right/i);
  if (!headMeshes.length && !(eyeL.length && eyeR.length)) {
    console.warn(`Human model ${label}: no skeleton and no head/eye meshes to orient it; using the built-in patient.`);
    return null;
  }

  // ---- Orientation from the meshes --------------------------------------------------------
  const all = boxOf(meshes);
  const head = boxOf(headMeshes.length ? headMeshes : [...eyeL, ...eyeR]).centre;
  const s = all.size;
  const axis = s.x >= s.y && s.x >= s.z ? new Vector3(1, 0, 0) : s.y >= s.z ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const headDir = Vector3.Dot(head.subtract(all.centre), axis) >= 0 ? axis : axis.scale(-1);
  const eyes = eyeL.length && eyeR.length ? { l: boxOf(eyeL).centre, r: boxOf(eyeR).centre } : null;
  const perp = (v: Vector3) => v.subtract(headDir.scale(Vector3.Dot(v, headDir))).normalize();
  const face = eyes ? perp(eyes.l.add(eyes.r).scale(0.5).subtract(head)) : axis.y ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const third = Vector3.Cross(headDir, face).normalize();
  const fwd = Vector3.Cross(third, headDir).normalize();
  const q = Quaternion.Identity();
  Quaternion.RotationQuaternionFromAxisToRef(headDir, fwd, third, q);
  pose.rotationQuaternion = Quaternion.Inverse(q).multiply(pose.rotationQuaternion ?? Quaternion.Identity());
  // Make sure the face ended up pointing up (handedness can flip the result).
  const faceNow = () => {
    if (!eyes) return 1;
    const e = boxOf([...eyeL, ...eyeR]).centre;
    const h = boxOf(headMeshes.length ? headMeshes : [...eyeL, ...eyeR]).centre;
    return e.y - h.y;
  };
  if (faceNow() < 0) {
    const base = pose.rotationQuaternion.clone();
    const flip = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI);
    for (const cand of [flip.multiply(base), base.multiply(flip)]) {
      pose.rotationQuaternion = cand;
      const b = boxOf(meshes);
      const hx = boxOf(headMeshes.length ? headMeshes : [...eyeL, ...eyeR]).centre.x;
      if (faceNow() > 0 && hx > b.centre.x) break;
    }
  }

  // ---- Scale and position: pelvis at the origin, torso centre at y = 0 -------------------------
  let b = boxOf(meshes);
  const length = b.size.x;
  const height = cfg.height ?? (length > 1 && length < 2.2 ? length : defaultHeight);
  pose.scaling.scaleInPlace(height / length);
  b = boxOf(meshes);
  const k = height / 1.75;
  const torsoHalf = 0.11 * k;
  pose.position.addInPlace(new Vector3(-(b.max.x - 0.47 * height), -(b.min.y + torsoHalf), -b.centre.z));
  b = boxOf(meshes);
  const supportDepth = torsoHalf + 0.004;
  const left = eyes ? (() => {
    const e = { l: boxOf(eyeL).centre, r: boxOf(eyeR).centre };
    return Math.sign(e.l.z - e.r.z) || 1;
  })() : 1;

  // ---- Exam points on the body surface ---------------------------------------------------------
  const pickable = new Set(meshes);
  const surface = (x: number, z: number, back: boolean) => {
    const from = new Vector3(x, back ? b.min.y - 1 : b.max.y + 1, z);
    const hit = scene.pickWithRay(new Ray(from, new Vector3(0, back ? 1 : -1, 0), 4), (m) => pickable.has(m));
    return hit?.hit && hit.pickedPoint ? hit.pickedPoint : null;
  };
  const anchors: PatientRig["anchors"] = {};
  const eyesNow = eyes ? { l: boxOf(eyeL).centre, r: boxOf(eyeR).centre } : null;
  for (const [id, p] of Object.entries(POINTS)) {
    let point: Vector3 | null = null;
    if (p.eye && eyesNow) {
      const e = p.eye === "mid" ? eyesNow.l.add(eyesNow.r).scale(0.5) : eyesNow.r;
      // Conjunctiva: the lower lid, just below the right eye, so it does not cover the pupils marker.
      point = e.add(new Vector3(p.eye === "right" ? -0.022 * k : 0, 0.012 * k, 0));
    } else {
      const x = b.max.x - p.t * height;
      const z0 = p.side * k * left;
      // Limbs may sit a little in or out of the standard position: search sideways for skin.
      for (const d of [0, -0.015, 0.015, -0.03, 0.03, -0.05, 0.05, -0.07, 0.07, -0.1, 0.1]) {
        const hit = surface(x, z0 + d * k * left * Math.sign(p.side || 1), !!p.back);
        if (hit) {
          point = hit.add(new Vector3(0, (p.back ? -1 : 1) * 0.012, 0));
          break;
        }
      }
    }
    if (!point) {
      console.warn(`Human model ${label}: no body surface found for exam point ${id}`);
      continue;
    }
    const fix = cfg.anchors?.[id];
    if (fix) point = point.add(new Vector3(fix[0], fix[2], fix[1] * left));
    anchors[id] = { node: root, local: point };
  }

  // ---- Breathing: the torso and top rise and fall slightly --------------------------------------
  const torso = find(/shirt|top|gown|torso|chest|body(?!.*(arm|leg|head))/i).filter((m) => !/arm|leg|head|eye|nail|lash|hair/i.test(m.name));
  const chestMotion = torso.map((m) => {
    const inv = m.computeWorldMatrix(true).clone().invert();
    const local = Vector3.TransformNormal(new Vector3(0, 1, 0), inv);
    const ax = Math.abs(local.x) > Math.abs(local.y) ? (Math.abs(local.x) > Math.abs(local.z) ? "x" : "z") : Math.abs(local.y) > Math.abs(local.z) ? "y" : "z";
    const bb = boxOf([m]);
    m.setPivotPoint(new Vector3(bb.centre.x, bb.min.y, bb.centre.z), Space.WORLD);
    const base = m.scaling.clone();
    return (amount: number) => {
      m.scaling.copyFrom(base);
      m.scaling[ax] = base[ax] * (1 + 0.018 * amount);
    };
  });

  // Skin: a little light scattering so it does not look like painted plastic.
  for (const m of meshes) {
    const mat = m.material;
    if (mat instanceof PBRMaterial && /skin/i.test(mat.name)) {
      mat.subSurface.isTranslucencyEnabled = true;
      mat.subSurface.translucencyIntensity = 0.2;
      mat.subSurface.tintColor = new Color3(0.9, 0.35, 0.25);
    }
  }

  console.info(`Human model ${label}: static mesh, ${height.toFixed(2)} m, ${Object.keys(anchors).length} exam points, breathing on ${torso.length} meshes`);
  return {
    supportDepth,
    rig: {
      root,
      faceLocal: new Vector3(0, 1, 0),
      headLocal: new Vector3(1, 0, 0),
      chest: null,
      head: null,
      eyelids: [],
      eyelidAxis: new Vector3(1, 0, 0),
      anchors,
      breathe: chestMotion.length ? (amount: number) => chestMotion.forEach((f) => f(amount)) : undefined,
    },
  };
}
