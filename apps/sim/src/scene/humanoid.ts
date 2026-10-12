import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { PatientRig } from "./fallback.js";
import type { PatientModel } from "./scene.js";
import { poseStaticHuman } from "./static-human.js";

/**
 * Drop-in human models. Put a rigged, standing (T- or A-pose) human at
 * `/models/humans/<model>.glb` (adult_male, adult_female, elderly, child) and it replaces the
 * built-in patient: it is laid supine on the bed with the arms at the sides, exam points are
 * placed from the skeleton, breathing moves the spine, and blinking uses blend shapes named
 * like "eyeBlinkLeft" / "Blink" when present. An optional `/models/humans/<model>.json` can set
 * `height` (metres) and per-point `anchors` corrections. See assets/models/HUMANS.md.
 */
export interface HumanoidConfig {
  /** Standing height in metres; the model is scaled to it. Default: keep the model's size. */
  height?: number;
  /** Corrections to exam points, in metres: { pointId: [towardHead, towardPatientLeft, outOfSkin] }. */
  anchors?: Record<string, [number, number, number]>;
}

/** Bone names in common rigs (Mixamo, Character Creator, Unreal/UE mannequin, Rigify, VRM), normalised. */
const BONES = {
  hips: ["hips", "pelvis", "hip"],
  spine: ["spine", "spine01", "spine1", "spine_01"],
  chest: ["spine2", "upperchest", "chest", "spine03", "spine02", "spine3"],
  neck: ["neck", "neck01", "neck1"],
  head: ["head"],
  armL: ["leftarm", "upperarml", "leftupperarm", "lupperarm", "arml", "upperarmleft", "ccbaselupperarm"],
  armR: ["rightarm", "upperarmr", "rightupperarm", "rupperarm", "armr", "upperarmright", "ccbaserupperarm"],
  foreL: ["leftforearm", "lowerarml", "forearml", "leftlowerarm", "lforearm", "ccbaselforearm"],
  foreR: ["rightforearm", "lowerarmr", "forearmr", "rightlowerarm", "rforearm", "ccbaserforearm"],
  handL: ["lefthand", "handl", "lhand", "ccbaselhand"],
  handR: ["righthand", "handr", "rhand", "ccbaserhand"],
  thighL: ["leftupleg", "thighl", "leftupperleg", "upperlegl", "lthigh", "ccbaselthigh"],
  thighR: ["rightupleg", "thighr", "rightupperleg", "upperlegr", "rthigh", "ccbaserthigh"],
  shinL: ["leftleg", "calfl", "shinl", "leftlowerleg", "lowerlegl", "lcalf", "ccbaselcalf"],
  shinR: ["rightleg", "calfr", "shinr", "rightlowerleg", "lowerlegr", "rcalf", "ccbasercalf"],
  footL: ["leftfoot", "footl", "lfoot", "ccbaselfoot"],
  footR: ["rightfoot", "footr", "rfoot", "ccbaserfoot"],
  toeL: ["lefttoebase", "toel", "balll", "lefttoes", "ltoe0", "ccbaseltoebase"],
  toeR: ["righttoebase", "toer", "ballr", "righttoes", "rtoe0", "ccbasertoebase"],
  eyeL: ["lefteye", "eyel", "leye"],
  eyeR: ["righteye", "eyer", "reye"],
} as const;
type BoneKey = keyof typeof BONES;

const norm = (name: string) => name.replace(/^.*:/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Exam points relative to a bone: [towardHead, towardPatientLeft, outOfSkin] in metres for a
 * 1.75 m adult (scaled with height). "Out" is toward the face side; negative is the back.
 * The camera looks at the patient's right side, so limb points use the right limbs.
 */
const ANCHORS: Record<string, { bone: BoneKey; to?: BoneKey; t?: number; off: [number, number, number] }> = {
  general_inspection: { bone: "chest", off: [0, 0, 0.15] },
  pupils: { bone: "head", off: [0.06, 0, 0.1] },
  conjunctiva: { bone: "head", off: [0.05, -0.035, 0.095] },
  temperature: { bone: "head", off: [0.11, 0, 0.09] },
  jvp: { bone: "neck", off: [0, -0.05, 0.03] },
  carotid_pulse: { bone: "neck", off: [0.02, -0.035, 0.05] },
  heart_auscultation: { bone: "chest", off: [-0.06, 0.05, 0.13] },
  chest_auscultation_front: { bone: "chest", off: [0.04, -0.07, 0.13] },
  chest_percussion: { bone: "chest", off: [0, 0.08, 0.13] },
  chest_wall_palpation: { bone: "chest", off: [0.02, 0, 0.14] },
  chest_auscultation_back: { bone: "chest", off: [0, -0.06, -0.13] },
  abdomen_palpation: { bone: "spine", off: [-0.04, 0, 0.14] },
  abdomen_auscultation: { bone: "spine", off: [-0.07, 0.05, 0.14] },
  blood_pressure: { bone: "armR", to: "foreR", t: 0.45, off: [0, 0, 0.05] },
  reflexes_biceps: { bone: "foreR", off: [0.04, 0, 0.04] },
  radial_pulse: { bone: "handR", to: "foreR", t: 0.18, off: [0, 0, 0.025] },
  capillary_refill: { bone: "handR", off: [-0.08, 0, 0.02] },
  reflexes_knee: { bone: "shinR", off: [0.03, 0, 0.06] },
  calf_inspection: { bone: "shinR", to: "footR", t: 0.4, off: [0, 0, 0.06] },
  ankle_oedema: { bone: "footR", off: [0.03, 0, 0.05] },
};

const DEFAULT_HEIGHT: Record<PatientModel, number> = { adult_male: 1.76, adult_female: 1.64, elderly: 1.66, child: 1.25 };

export interface Humanoid {
  rig: PatientRig;
  /** Distance from the hips down to the back surface, i.e. hip height above the mattress. */
  supportDepth: number;
}

async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok && !(r.headers.get("content-type") ?? "").includes("text/html"); // SPA fallback is not a model
  } catch {
    return false;
  }
}

export async function loadHumanoid(scene: Scene, model: PatientModel): Promise<Humanoid | null> {
  const base = `/models/humans/${model}`;
  if (!(await exists(`${base}.glb`))) return null;
  let cfg: HumanoidConfig = {};
  try {
    const r = await fetch(`${base}.json`);
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) cfg = (await r.json()) as HumanoidConfig;
  } catch {
    /* optional */
  }
  const result = await ImportMeshAsync(`${base}.glb`, scene);
  // Imported clips (idle, walk…) would fight the pose; show the rest pose.
  for (const g of result.animationGroups) g.dispose();
  for (const s of result.skeletons) s.returnToRest();

  const root = new TransformNode("patient-root", scene);
  const pose = new TransformNode("patient-pose", scene);
  pose.parent = root;
  for (const m of result.meshes) if (!m.parent) m.parent = pose;
  for (const t of result.transformNodes) if (!t.parent) t.parent = pose;

  const byName = new Map<string, TransformNode>();
  for (const t of result.transformNodes) if (!byName.has(norm(t.name))) byName.set(norm(t.name), t);
  const bone = (k: BoneKey): TransformNode | null => {
    for (const n of BONES[k]) {
      const t = byName.get(n);
      if (t) return t;
    }
    return null;
  };
  // No skeleton: a posed mesh (scan, Sketchfab export). Orient it from its meshes instead.
  if (!result.skeletons.length) {
    const posed = poseStaticHuman(scene, root, pose, result.meshes.filter((m) => m.getTotalVertices() > 0), cfg, DEFAULT_HEIGHT[model], model);
    if (posed) return posed;
    for (const m of result.meshes) m.dispose();
    root.dispose();
    return null;
  }
  const need: BoneKey[] = ["hips", "head", "armL", "armR", "foreL", "foreR", "handR", "shinR", "footR"];
  const missing = need.filter((k) => !bone(k));
  if (missing.length) {
    console.warn(`Human model ${model}: bones not found (${missing.join(", ")}); using the built-in patient.`);
    for (const m of result.meshes) m.dispose();
    root.dispose();
    return null;
  }

  const refresh = () => {
    root.computeWorldMatrix(true);
    for (const n of root.getDescendants(false)) (n as TransformNode).computeWorldMatrix?.(true);
  };
  const P = (k: BoneKey) => bone(k)!.getAbsolutePosition().clone();
  const meshes = result.meshes.filter((m) => m.getTotalVertices() > 0);
  const bounds = () => {
    refresh();
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = min.scale(-1);
    for (const m of meshes) {
      m.refreshBoundingInfo({ applySkeleton: true, applyMorph: true });
      const b = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, b.minimumWorld);
      max = Vector3.Maximize(max, b.maximumWorld);
    }
    return { min, max };
  };

  // ---- Measure the standing model --------------------------------------------------------
  refresh();
  // Long axis from the feet to the head, so the whole body lies level (hips-to-head alone
  // follows the posture of the spine and tilts the legs).
  const feet = bone("footL") ? P("footL").add(P("footR")).scale(0.5) : P("footR");
  const up = P("head").subtract(feet).normalize();
  const leftDir = () => P("armL").subtract(P("armR")).normalize();
  // Forward: toes point forward from the feet; failing that, the eyes sit forward of the head.
  const forward = (() => {
    const perp = (v: Vector3) => v.subtract(up.scale(Vector3.Dot(v, up))).normalize();
    if (bone("toeR") && bone("footR")) return perp(P("toeR").subtract(P("footR")));
    if (bone("eyeL") && bone("eyeR")) return perp(P("eyeL").add(P("eyeR")).scale(0.5).subtract(P("head")));
    return perp(Vector3.Cross(leftDir(), up));
  })();

  // ---- Arms down along the body (from T- or A-pose) --------------------------------------
  for (const side of ["L", "R"] as const) {
    const arm = bone(side === "L" ? "armL" : "armR")!;
    const fore = bone(side === "L" ? "foreL" : "foreR")!;
    const out = leftDir().scale(side === "L" ? 1 : -1);
    const target = up.scale(-0.97).add(out.scale(0.16)).add(forward.scale(0.08)).normalize();
    for (let i = 0; i < 2; i++) {
      refresh();
      const cur = fore.getAbsolutePosition().subtract(arm.getAbsolutePosition()).normalize();
      const dot = Math.min(1, Math.max(-1, Vector3.Dot(cur, target)));
      if (dot > 0.999) break;
      const axis = Vector3.Cross(cur, target).normalize();
      const angle = Math.acos(dot);
      arm.rotate(axis, angle, Space.WORLD);
      refresh();
      // Rotation sense differs with handedness; undo and turn the other way if it got worse.
      const after = fore.getAbsolutePosition().subtract(arm.getAbsolutePosition()).normalize();
      if (Vector3.Dot(after, target) < dot) arm.rotate(axis, -2 * angle, Space.WORLD);
    }
  }

  // ---- Scale -------------------------------------------------------------------------------
  const standing = bounds();
  const extent = standing.max.subtract(standing.min);
  const tall = Math.abs(extent.x * up.x) + Math.abs(extent.y * up.y) + Math.abs(extent.z * up.z); // along the up axis
  const wantHeight = cfg.height ?? (tall > 0.8 && tall < 2.3 ? tall : DEFAULT_HEIGHT[model]);
  const scale = wantHeight / Math.max(0.01, Math.abs(tall));
  pose.scaling.setAll(scale);

  // ---- Lie down: head toward +X, face up (+Y), hips at the origin ---------------------------
  const third = Vector3.Cross(up, forward).normalize();
  const fwd = Vector3.Cross(third, up).normalize();
  const fromModel = Quaternion.Identity();
  Quaternion.RotationQuaternionFromAxisToRef(up, fwd, third, fromModel); // maps X→up, Y→forward
  pose.rotationQuaternion = Quaternion.Inverse(fromModel);
  refresh();
  // Babylon's left-handed frame can flip the result; check where the face points and turn the
  // body over about the head-foot axis if it ended up face down.
  const facingNow = () => {
    if (bone("toeR") && bone("footR")) return P("toeR").subtract(P("footR"));
    if (bone("eyeL") && bone("eyeR")) return P("eyeL").add(P("eyeR")).scale(0.5).subtract(P("head"));
    return null;
  };
  const firstFace = facingNow();
  if (firstFace && firstFace.y < 0) {
    const base = pose.rotationQuaternion.clone();
    const flip = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI);
    for (const q of [flip.multiply(base), base.multiply(flip)]) {
      pose.rotationQuaternion = q;
      refresh();
      if (facingNow()!.y > 0 && P("head").x > P("hips").x) break;
    }
  }
  const headNow = P("head").subtract(P("hips"));
  console.info(`Human model ${model}: height ${wantHeight.toFixed(2)} m, head ${headNow.x > 0 ? "+X" : "-X"}, face ${(facingNow()?.y ?? 1) >= 0 ? "up" : "down"}`);
  pose.position.subtractInPlace(P("hips"));
  const lying = bounds();
  const supportDepth = -lying.min.y + 0.005;

  // ---- Exam points -------------------------------------------------------------------------
  refresh();
  const headDir = new Vector3(1, 0, 0);
  const faceDir = new Vector3(0, 1, 0);
  const patientLeft = P("armL").subtract(P("armR")).normalize();
  const k = wantHeight / 1.75;
  const anchors: PatientRig["anchors"] = {};
  for (const [id, a] of Object.entries(ANCHORS)) {
    const n = bone(a.bone) ?? bone("chest") ?? bone("spine") ?? bone("hips")!;
    let p = n.getAbsolutePosition().clone();
    const to = a.to ? bone(a.to) : null;
    if (to) p = Vector3.Lerp(p, to.getAbsolutePosition(), a.t ?? 0.5);
    const off = cfg.anchors?.[id] ?? a.off;
    const world = p.add(headDir.scale(off[0] * k)).add(patientLeft.scale(off[1] * k)).add(faceDir.scale(off[2] * k));
    const inv = n.getWorldMatrix().clone().invert();
    anchors[id] = { node: n, local: Vector3.TransformCoordinates(world, inv) };
  }

  // ---- Animation hooks -----------------------------------------------------------------------
  const spine = bone("spine") ?? bone("chest");
  const head = bone("head");
  const parentAxis = (n: TransformNode, worldAxis: Vector3) => {
    const parent = n.parent as TransformNode | null;
    const inv = parent ? parent.getWorldMatrix().clone().invert() : Matrix.Identity();
    return Vector3.TransformNormal(worldAxis, inv).normalize();
  };
  const turn = (n: TransformNode | null, worldAxis: Vector3) => {
    if (!n) return null;
    n.rotationQuaternion ??= Quaternion.FromEulerVector(n.rotation);
    const base = n.rotationQuaternion.clone();
    const axis = parentAxis(n, worldAxis);
    return (angle: number) => {
      n.rotationQuaternion = Quaternion.RotationAxis(axis, angle).multiply(base);
    };
  };
  // Breathing: a slight extension of the spine lifts the chest; the root's own rotation is
  // applied later, so axes are taken now in the lying frame (patient's left-right axis).
  const breatheTurn = turn(spine, patientLeft);
  const headTurn = turn(head, faceDir);
  const blinkTargets = meshes.flatMap((m: AbstractMesh) => {
    const mgr = m.morphTargetManager;
    if (!mgr) return [];
    const out = [];
    for (let i = 0; i < mgr.numTargets; i++) {
      const t = mgr.getTarget(i);
      if (/blink|eyes?_?clos/i.test(t.name)) out.push(t);
    }
    return out;
  });

  return {
    supportDepth,
    rig: {
      root,
      faceLocal: faceDir,
      headLocal: headDir,
      chest: null,
      head: null,
      eyelids: [],
      eyelidAxis: new Vector3(1, 0, 0),
      anchors,
      breathe: breatheTurn ? (b: number) => breatheTurn(b * 0.012) : undefined,
      blink: blinkTargets.length ? (v: number) => blinkTargets.forEach((t) => (t.influence = v)) : undefined,
      headTurn: headTurn ?? undefined,
    },
  };
}
