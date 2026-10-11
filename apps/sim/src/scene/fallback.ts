import { Color3, MeshBuilder, StandardMaterial, TransformNode, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import type { PatientModel } from "./scene.js";

export interface PatientRig {
  root: TransformNode;
  /** Direction the face points and the head lies, in the root's local frame. */
  faceLocal: Vector3;
  headLocal: Vector3;
  chest: TransformNode | null;
  head: TransformNode | null;
  eyelids: TransformNode[];
  eyelidAxis: Vector3;
  anchors: Record<string, { node: TransformNode; local: Vector3 }>;
}

const mat = (scene: Scene, name: string, c: [number, number, number]) => {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = new Color3(...c);
  m.specularColor = new Color3(0.08, 0.08, 0.08);
  return m;
};

/** Stylized primitive room used when the Articraft models are not available. */
export function buildFallbackRoom(scene: Scene, need: { room: boolean; bed: boolean; monitor: boolean; tray: boolean }): { screen: Mesh | null } {
  let screen: Mesh | null = null;
  if (need.room) {
    const floor = MeshBuilder.CreateGround("floor", { width: 6, height: 5 }, scene);
    floor.material = mat(scene, "floor", [0.78, 0.8, 0.8]);
    const wallM = mat(scene, "wall", [0.93, 0.95, 0.96]);
    const back = MeshBuilder.CreatePlane("wall-back", { width: 6, height: 2.8, sideOrientation: 2 }, scene);
    back.position.set(0, 1.4, 2.5);
    back.material = wallM;
    for (const x of [-3, 3]) {
      const side = MeshBuilder.CreatePlane(`wall-${x}`, { width: 5, height: 2.8, sideOrientation: 2 }, scene);
      side.position.set(x, 1.4, 0);
      side.rotation.y = Math.PI / 2;
      side.material = wallM;
    }
    const desk = MeshBuilder.CreateBox("desk", { width: 1.2, height: 0.05, depth: 0.6 }, scene);
    desk.position.set(2.2, 0.75, 2.0);
    desk.material = mat(scene, "desk", [0.72, 0.62, 0.5]);
  }
  if (need.bed) {
    const frame = MeshBuilder.CreateBox("bed-frame", { width: 2.0, height: 0.5, depth: 0.85 }, scene);
    frame.position.set(0, 0.35, 0);
    frame.material = mat(scene, "bed-frame", [0.75, 0.8, 0.84]);
    const mattress = MeshBuilder.CreateBox("mattress", { width: 2.0, height: 0.12, depth: 0.85 }, scene);
    mattress.position.set(0, 0.66, 0);
    mattress.material = mat(scene, "mattress", [0.55, 0.75, 0.8]);
    const pillow = MeshBuilder.CreateBox("pillow", { width: 0.35, height: 0.1, depth: 0.55 }, scene);
    pillow.position.set(0.8, 0.76, 0);
    pillow.material = mat(scene, "pillow", [0.97, 0.97, 0.97]);
  }
  if (need.monitor) {
    const pole = MeshBuilder.CreateCylinder("monitor-pole", { height: 1.4, diameter: 0.05 }, scene);
    pole.position.set(-1.25, 0.7, 0.55);
    pole.material = mat(scene, "pole", [0.6, 0.62, 0.65]);
    const box = MeshBuilder.CreateBox("monitor-box", { width: 0.62, height: 0.42, depth: 0.08 }, scene);
    box.position.set(-1.25, 1.55, 0.55);
    box.material = mat(scene, "monitor-box", [0.25, 0.28, 0.3]);
    screen = MeshBuilder.CreatePlane("screen", { width: 0.56, height: 0.35 }, scene);
    screen.position.set(-1.25, 1.55, 0.505);
  }
  if (need.tray) {
    const top = MeshBuilder.CreateBox("tray", { width: 0.7, height: 0.04, depth: 0.45 }, scene);
    top.position.set(1.25, 0.9, 0.75);
    top.material = mat(scene, "tray", [0.82, 0.84, 0.86]);
    const legs = MeshBuilder.CreateCylinder("tray-leg", { height: 0.9, diameter: 0.04 }, scene);
    legs.position.set(1.25, 0.45, 0.75);
    legs.material = top.material;
  }
  return { screen };
}

const PROFILE: Record<PatientModel, { scale: number; skin: [number, number, number]; hair: [number, number, number]; gown: [number, number, number]; width: number }> = {
  adult_male: { scale: 1, skin: [0.8, 0.62, 0.5], hair: [0.15, 0.1, 0.08], gown: [0.62, 0.78, 0.9], width: 1 },
  adult_female: { scale: 0.94, skin: [0.86, 0.68, 0.56], hair: [0.3, 0.18, 0.1], gown: [0.7, 0.8, 0.92], width: 0.92 },
  elderly: { scale: 0.96, skin: [0.84, 0.7, 0.6], hair: [0.82, 0.82, 0.82], gown: [0.66, 0.82, 0.86], width: 0.9 },
  child: { scale: 0.68, skin: [0.88, 0.72, 0.6], hair: [0.25, 0.15, 0.08], gown: [0.75, 0.88, 0.75], width: 0.95 },
};

/**
 * Supine primitive patient: pelvis at the origin, head toward +X, face up (+Y), patient's left
 * side toward +Z (as the Articraft patients), so the camera at -Z sees the patient's right side.
 */
export function buildFallbackPatient(scene: Scene, model: PatientModel): PatientRig {
  const p = PROFILE[model];
  const s = p.scale;
  const root = new TransformNode("patient-root", scene);
  root.scaling.setAll(s);
  const skin = mat(scene, "skin", p.skin);
  const gown = mat(scene, "gown", p.gown);
  const hair = mat(scene, "hair", p.hair);

  const node = (name: string, parent: TransformNode, pos: [number, number, number]) => {
    const n = new TransformNode(name, scene);
    n.parent = parent;
    n.position.set(...pos);
    return n;
  };
  const capsule = (name: string, parent: TransformNode, length: number, radius: number, m: StandardMaterial, axis: "x" | "z" = "x") => {
    const c = MeshBuilder.CreateCapsule(name, { height: length, radius, tessellation: 12, subdivisions: 1 }, scene);
    c.parent = parent;
    c.rotation.z = axis === "x" ? Math.PI / 2 : 0;
    c.material = m;
    return c;
  };

  const w = p.width;
  const pelvis = node("pelvis", root, [0, 0.1, 0]);
  capsule("pelvis-mesh", pelvis, 0.3 * w + 0.2, 0.14 * w, gown).scaling.z = 1.3;
  const abdomen = node("abdomen", pelvis, [0.16, 0.01, 0]);
  const abd = MeshBuilder.CreateBox("abdomen-mesh", { width: 0.2, height: 0.2, depth: 0.32 * w }, scene);
  abd.parent = abdomen;
  abd.material = gown;
  const chest = node("chest", pelvis, [0.4, 0.01, 0]);
  const ch = MeshBuilder.CreateBox("chest-mesh", { width: 0.32, height: 0.22, depth: 0.38 * w }, scene);
  ch.parent = chest;
  ch.material = gown;
  const neck = node("neck", chest, [0.2, 0.0, 0]);
  capsule("neck-mesh", neck, 0.12, 0.05, skin);
  const head = node("head", neck, [0.15, 0.01, 0]);
  const skull = MeshBuilder.CreateSphere("head-mesh", { diameter: 0.21, segments: 16 }, scene);
  skull.parent = head;
  skull.scaling.set(1.1, 0.95, 0.9);
  skull.material = skin;
  const cap = MeshBuilder.CreateSphere("hair-mesh", { diameter: 0.22, segments: 12, slice: 0.5 }, scene);
  cap.parent = head;
  cap.position.x = 0.02;
  cap.rotation.z = -Math.PI / 2;
  cap.scaling.set(0.95, 1.08, 0.92);
  cap.material = hair;
  const eyeM = mat(scene, "eye", [0.12, 0.12, 0.14]);
  const eyelids: TransformNode[] = [];
  for (const [side, z] of [["l", 0.035], ["r", -0.035]] as const) {
    const eye = MeshBuilder.CreateSphere(`eye-${side}`, { diameter: 0.025 }, scene);
    eye.parent = head;
    eye.position.set(0.02, 0.095, z);
    eye.material = eyeM;
    const lidPivot = node(`eyelid_${side}`, head, [0.035, 0.1, z]);
    const lid = MeshBuilder.CreateBox(`eyelid-${side}-mesh`, { width: 0.03, height: 0.006, depth: 0.032 }, scene);
    lid.parent = lidPivot;
    lid.position.x = -0.015;
    lid.rotation.z = 0.9; // open; the rig rotates it closed
    lid.material = skin;
    eyelids.push(lidPivot);
  }

  const limbs: Record<string, TransformNode> = {};
  for (const [side, z] of [["l", 1], ["r", -1]] as const) {
    const upper = node(`upper_arm_${side}`, chest, [0.0, -0.02, z * (0.24 * w)]);
    capsule(`upper_arm_${side}-mesh`, upper, 0.3, 0.045, gown);
    const fore = node(`forearm_${side}`, upper, [-0.29, 0, 0]);
    capsule(`forearm_${side}-mesh`, fore, 0.27, 0.038, skin);
    const hand = node(`hand_${side}`, fore, [-0.19, 0, 0]);
    const hm = MeshBuilder.CreateBox(`hand_${side}-mesh`, { width: 0.1, height: 0.03, depth: 0.07 }, scene);
    hm.parent = hand;
    hm.material = skin;
    const thigh = node(`thigh_${side}`, pelvis, [-0.28, -0.01, z * 0.1 * w]);
    capsule(`thigh_${side}-mesh`, thigh, 0.42, 0.07 * w, gown);
    const shin = node(`shin_${side}`, thigh, [-0.44, 0, 0]);
    capsule(`shin_${side}-mesh`, shin, 0.4, 0.05, skin);
    const foot = node(`foot_${side}`, shin, [-0.25, 0.05, 0]);
    const fm = MeshBuilder.CreateBox(`foot_${side}-mesh`, { width: 0.06, height: 0.14, depth: 0.08 }, scene);
    fm.parent = foot;
    fm.material = skin;
    Object.assign(limbs, { [`upper_arm_${side}`]: upper, [`forearm_${side}`]: fore, [`hand_${side}`]: hand, [`thigh_${side}`]: thigh, [`shin_${side}`]: shin });
  }

  const A = (n: TransformNode, x: number, y: number, z: number) => ({ node: n, local: new Vector3(x, y, z) });
  const anchors: PatientRig["anchors"] = {
    general_inspection: A(chest, 0, 0.12, 0),
    pupils: A(head, 0.02, 0.1, 0),
    conjunctiva: A(head, 0.0, 0.095, -0.04),
    temperature: A(head, 0.08, 0.07, 0),
    jvp: A(neck, 0, 0.03, -0.05),
    carotid_pulse: A(neck, 0, 0.04, 0.05),
    radial_pulse: A(limbs.forearm_r!, -0.11, 0.035, 0),
    blood_pressure: A(limbs.upper_arm_r!, 0, 0.05, 0),
    heart_auscultation: A(chest, 0.0, 0.115, 0.05),
    chest_auscultation_front: A(chest, 0.09, 0.115, -0.09),
    chest_auscultation_back: A(chest, 0.05, -0.115, 0.08),
    chest_percussion: A(chest, -0.06, 0.115, -0.1),
    chest_wall_palpation: A(chest, 0.06, 0.115, 0.12),
    abdomen_palpation: A(abdomen, 0, 0.105, -0.05),
    abdomen_auscultation: A(abdomen, 0, 0.105, 0.05),
    calf_inspection: A(limbs.shin_l!, 0, 0.055, 0),
    ankle_oedema: A(limbs.shin_r!, -0.17, 0.05, 0),
    reflexes_knee: A(limbs.thigh_r!, -0.2, 0.075, 0),
    reflexes_biceps: A(limbs.upper_arm_r!, -0.13, 0.045, 0),
    capillary_refill: A(limbs.hand_r!, -0.03, 0.02, 0),
  };
  return { root, faceLocal: new Vector3(0, 1, 0), headLocal: new Vector3(1, 0, 0), chest, head, eyelids, eyelidAxis: new Vector3(0, 0, 1), anchors };
}
