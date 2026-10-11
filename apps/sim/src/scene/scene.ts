import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { type Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
// Deep imports keep the bundle to what the scene uses; these two register features by side effect.
import "@babylonjs/core/Culling/ray"; // scene.pick for exam markers
import "@babylonjs/loaders/glTF/2.0"; // .glb models
import type { ExamTool } from "@sim/shared";
import { EXAM_POINTS } from "@sim/shared";
import type { Vitals } from "@sim/shared";
import { buildFallbackPatient, buildFallbackRoom, type PatientRig } from "./fallback.js";
import { MonitorFace } from "./monitor.js";

const BLINK_S = 0.16;

export type PatientModel = "adult_male" | "adult_female" | "elderly" | "child";
export type View = "overview" | "chest" | "head" | "back";
export const VIEWS: View[] = ["overview", "chest", "head", "back"];

interface Sidecar {
  name: string;
  anchors: Record<string, { body: string; position: [number, number, number] }>;
  joints?: { name: string; parent: string; child: string; axis: [number, number, number]; type: string; limits: [number, number] }[];
  headDirection?: [number, number, number];
  facing?: [number, number, number];
  /** Pelvis height above the bed surface (patients). */
  supportDepth?: number;
}

export interface ExamMarker {
  pointId: string;
  mesh: Mesh;
  screenRect(): { x: number; y: number; width: number; height: number } | null;
}

async function loadModel(scene: Scene, name: string): Promise<{ root: TransformNode; sidecar: Sidecar } | null> {
  try {
    const res = await fetch(`/models/${name}.json`);
    if (!res.ok) return null;
    const sidecar = (await res.json()) as Sidecar;
    const result = await ImportMeshAsync(`/models/${name}.glb`, scene);
    const root = new TransformNode(`${name}-root`, scene);
    for (const m of result.meshes) if (!m.parent) m.parent = root;
    for (const t of result.transformNodes) if (!t.parent) t.parent = root;
    return { root, sidecar };
  } catch {
    return null;
  }
}

const findNode = (root: TransformNode, name: string) => root.getChildTransformNodes(false).find((n) => n.name === name) ?? (root.getChildMeshes(false).find((m) => m.name === name) as TransformNode | undefined);

/**
 * The 3D examination room: room, bed, monitor, tray and patient. Models come from Articraft
 * GLBs in /models when present; otherwise simple stylized primitives are used so the case
 * still runs.
 */
export class SimScene {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  private monitor!: MonitorFace;
  private patient!: PatientRig;
  private patientRoot!: TransformNode;
  private markers: ExamMarker[] = [];
  private markerMat!: StandardMaterial;
  private markerHoverMat!: StandardMaterial;
  private t = 0;
  private nextBlink = 2;
  private coughUntil = 0;
  vitals: Vitals | null = null;
  appearance: string[] = [];
  view: View = "overview";
  onMarker: (pointId: string) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, powerPreference: "high-performance" });
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.86, 0.9, 0.93, 1);
    this.camera = new ArcRotateCamera("cam", -Math.PI / 2, 1.05, 3.2, new Vector3(0, 0.85, 0), this.scene);
    this.camera.minZ = 0.05;
    this.camera.fov = 0.75;
    const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), this.scene);
    hemi.intensity = 0.85;
    hemi.groundColor = new Color3(0.55, 0.58, 0.62);
    const sun = new DirectionalLight("key", new Vector3(-0.4, -1, 0.6), this.scene);
    sun.intensity = 0.6;
    addEventListener("resize", () => this.engine.resize());
  }

  async load(model: PatientModel): Promise<void> {
    const scene = this.scene;
    this.markerMat = new StandardMaterial("marker", scene);
    this.markerMat.diffuseColor = new Color3(0.1, 0.75, 0.75);
    this.markerMat.emissiveColor = new Color3(0.05, 0.4, 0.4);
    this.markerMat.alpha = 0.85;
    this.markerHoverMat = this.markerMat.clone("marker-hover");
    this.markerHoverMat.emissiveColor = new Color3(1, 0.75, 0.1);
    this.markerHoverMat.diffuseColor = new Color3(1, 0.8, 0.2);

    const [room, bed, monitor, tray, patient] = await Promise.all([
      loadModel(scene, "room"),
      loadModel(scene, "bed"),
      loadModel(scene, "monitor"),
      loadModel(scene, "tray"),
      loadModel(scene, `patient_${model}`),
    ]);
    const fallback = buildFallbackRoom(scene, { room: !room, bed: !bed, monitor: !monitor, tray: !tray });

    // Babylon's glTF loader mirrors X when converting to its left-handed world, so the room's
    // open side ends up toward +Z; turn it to face the camera, which looks from -Z.
    if (room) room.root.rotation.y = Math.PI;
    if (bed) bed.root.position.set(0, 0, 0);
    if (monitor) {
      // The model's screen faces +Z; turn it toward the camera.
      monitor.root.position.set(-1.25, 0, 0.55);
      monitor.root.rotation.y = Math.PI;
    }
    if (tray) tray.root.position.set(1.2, 0, 0.75);

    // Monitor face: the Articraft "screen" body if present, else the fallback screen plane.
    this.monitor = new MonitorFace(scene);
    const screenMat = new StandardMaterial("screen-mat", scene);
    screenMat.diffuseTexture = this.monitor.texture;
    screenMat.emissiveTexture = this.monitor.texture;
    screenMat.specularColor = Color3.Black();
    const screenMeshes = monitor ? monitor.root.getChildMeshes(false).filter((m) => /screen/i.test(m.name) || /screen/i.test(m.parent?.name ?? "")) : [];
    if (screenMeshes.length) {
      // The converter's screen UVs run bottom-up relative to the canvas.
      this.monitor.flipY = true;
      screenMeshes.forEach((m) => (m.material = screenMat));
    }
    else if (fallback.screen) fallback.screen.material = screenMat;

    // Patient on the bed: pelvis on the bed's hip anchor (lifted by the patient's support
    // depth), head turned toward the bed's head anchor.
    const bedAnchor = (id: string) => {
      const a = bed?.sidecar.anchors[id];
      if (!bed || !a) return null;
      const n = findNode(bed.root, a.body) ?? bed.root;
      n.computeWorldMatrix(true);
      return Vector3.TransformCoordinates(Vector3.FromArray(a.position), n.getWorldMatrix());
    };
    const hipW = bedAnchor("patient_hip");
    const headW = bedAnchor("patient_head");
    if (patient) {
      this.patientRoot = patient.root;
      this.patient = this.rigFromModel(patient.root, patient.sidecar);
      if (hipW && headW) {
        patient.root.position.copyFrom(hipW.add(new Vector3(0, patient.sidecar.supportDepth ?? 0, 0)));
        const want = headW.subtract(hipW);
        // Sidecar vectors are in glTF coordinates; the loader mirrors X.
        const hd = patient.sidecar.headDirection ?? [1, 0, 0];
        const have = new Vector3(-hd[0], hd[1], hd[2]);
        const yaw = Math.atan2(want.z, want.x) - Math.atan2(have.z, have.x);
        patient.root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), -yaw);
      } else patient.root.position.set(0, 0.72 + (patient.sidecar.supportDepth ?? 0), 0);
    } else {
      this.patient = buildFallbackPatient(scene, model);
      this.patientRoot = this.patient.root;
      this.patientRoot.position.set(0, (hipW?.y ?? 0.72) + 0.02, 0);
    }
    this.setView("overview", true);

    scene.onPointerObservable.add((pi) => {
      if (pi.type !== 1 /* POINTERDOWN */) return;
      const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m.metadata?.examPoint);
      if (pick?.hit && pick.pickedMesh) this.onMarker(pick.pickedMesh.metadata.examPoint);
    });

    let last = performance.now();
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.animate(dt);
      scene.render();
    });
  }

  private rigFromModel(root: TransformNode, sidecar: Sidecar): PatientRig {
    const node = (n: string) => findNode(root, n) ?? null;
    const f = sidecar.facing ?? [0, 1, 0];
    const hd = sidecar.headDirection ?? [1, 0, 0];
    return {
      root,
      // Sidecar vectors are glTF; the loader mirrors X.
      faceLocal: new Vector3(-f[0], f[1], f[2]),
      headLocal: new Vector3(-hd[0], hd[1], hd[2]),
      chest: node("chest"),
      head: node("head"),
      eyelids: [node("eyelid_l"), node("eyelid_r")].filter((x): x is TransformNode => !!x),
      eyelidAxis: (() => {
        const j = sidecar.joints?.find((x) => x.child === "eyelid_l");
        return j ? Vector3.FromArray(j.axis) : new Vector3(1, 0, 0);
      })(),
      anchors: Object.fromEntries(
        Object.entries(sidecar.anchors).map(([id, a]) => [id, { node: node(a.body) ?? root, local: Vector3.FromArray(a.position) }]),
      ),
    };
  }

  /** Camera presets cycled by swipe. "back" rolls the patient so the back can be examined. */
  setView(v: View, instant = false): void {
    this.view = v;
    const presets: Record<View, { alpha: number; beta: number; radius: number; target: Vector3 }> = {
      overview: { alpha: -Math.PI / 2, beta: 1.05, radius: 3.0, target: new Vector3(0, 0.85, 0) },
      chest: { alpha: -Math.PI / 2, beta: 0.65, radius: 1.35, target: this.anchorWorld("heart_auscultation") ?? new Vector3(0.25, 0.85, 0) },
      head: { alpha: -Math.PI / 2 - 0.35, beta: 0.7, radius: 1.0, target: this.anchorWorld("pupils") ?? new Vector3(0.75, 0.9, 0) },
      back: { alpha: -Math.PI / 2, beta: 0.75, radius: 1.5, target: new Vector3(0.2, 0.95, 0) },
    };
    const p = presets[v];
    this.applyRoll(v === "back");
    if (instant) {
      this.camera.alpha = p.alpha;
      this.camera.beta = p.beta;
      this.camera.radius = p.radius;
      this.camera.target = p.target;
    } else this.tween = { from: { a: this.camera.alpha, b: this.camera.beta, r: this.camera.radius, t: this.camera.target.clone() }, to: p, k: 0 };
    this.refreshMarkers();
  }
  private baseRotation: Quaternion | null = null;
  private basePosition: Vector3 | null = null;
  panelOpen = false;
  private tween: { from: { a: number; b: number; r: number; t: Vector3 }; to: { alpha: number; beta: number; radius: number; target: Vector3 }; k: number } | null = null;
  private currentTool: ExamTool | null = null;

  /**
   * Back view: roll the patient a quarter turn onto their left side so the back faces the
   * examiner (camera at -Z). Chooses the roll direction that turns the face away from the camera.
   */
  private applyRoll(onSide: boolean) {
    const root = this.patientRoot;
    this.baseRotation ??= root.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(root.rotation);
    this.basePosition ??= root.position.clone();
    root.rotationQuaternion = this.baseRotation.clone();
    root.position.copyFrom(this.basePosition);
    if (!onSide) return;
    const rotate = (q: Quaternion, v: Vector3) => {
      const out = Vector3.Zero();
      v.rotateByQuaternionToRef(q, out);
      return out;
    };
    const headWorld = rotate(this.baseRotation, this.patient.headLocal).normalize();
    for (const angle of [Math.PI / 2, -Math.PI / 2]) {
      const roll = Quaternion.RotationAxis(headWorld, angle);
      for (const q of [roll.multiply(this.baseRotation), this.baseRotation.multiply(roll)]) {
        const face = rotate(q, this.patient.faceLocal);
        const head = rotate(q, this.patient.headLocal).normalize();
        if (face.z > 0.9 && Vector3.Dot(head, headWorld) > 0.99) {
          root.rotationQuaternion = q;
          root.position.y += 0.08; // half the body width above the mattress
          return;
        }
      }
    }
  }

  cycleView(dir: 1 | -1): View {
    const i = VIEWS.indexOf(this.view);
    const next = VIEWS[(i + dir + VIEWS.length) % VIEWS.length]!;
    this.setView(next);
    return next;
  }

  anchorWorld(id: string): Vector3 | null {
    const a = this.patient?.anchors[id];
    if (!a) return null;
    a.node.computeWorldMatrix(true);
    return Vector3.TransformCoordinates(a.local, a.node.getWorldMatrix());
  }

  /** Shows clickable markers for every exam point that uses `tool` on the visible side. */
  showMarkers(tool: ExamTool | null): void {
    this.currentTool = tool;
    this.refreshMarkers();
  }

  private refreshMarkers() {
    for (const m of this.markers) m.mesh.dispose();
    this.markers = [];
    const tool = this.currentTool;
    if (!tool) return;
    const side = this.view === "back" ? "back" : "front";
    for (const p of EXAM_POINTS.filter((x) => x.tool === tool && x.view === side)) {
      const a = this.patient.anchors[p.id];
      if (!a) continue;
      const mesh = MeshBuilder.CreateSphere(`marker-${p.id}`, { diameter: 0.06, segments: 12 }, this.scene);
      mesh.parent = a.node;
      mesh.position.copyFrom(a.local);
      mesh.material = this.markerMat;
      mesh.renderingGroupId = 1;
      mesh.metadata = { examPoint: p.id };
      const marker: ExamMarker = {
        pointId: p.id,
        mesh,
        screenRect: () => {
          if (mesh.isDisposed()) return null;
          const w = this.engine.getRenderWidth();
          const h = this.engine.getRenderHeight();
          const pos = Vector3.Project(mesh.getAbsolutePosition(), Matrix.Identity(), this.scene.getTransformMatrix(), this.camera.viewport.toGlobal(w, h));
          if (pos.z < 0 || pos.z > 1) return null;
          const scale = innerWidth / w;
          return { x: pos.x * scale - 24, y: pos.y * (innerHeight / h) - 24, width: 48, height: 48 };
        },
      };
      this.markers.push(marker);
    }
  }

  get examMarkers(): readonly ExamMarker[] {
    return this.markers;
  }

  hoverMarker(pointId: string, on: boolean): void {
    const m = this.markers.find((x) => x.pointId === pointId);
    if (m) m.mesh.material = on ? this.markerHoverMat : this.markerMat;
  }

  cough(): void {
    this.coughUntil = this.t + 0.6;
  }

  private animate(dt: number) {
    this.t += dt;
    // Keep the patient clear of the side panel when it is open.
    const wantOffset = this.panelOpen ? 0.22 * this.camera.radius : 0;
    this.camera.targetScreenOffset.x += (wantOffset - this.camera.targetScreenOffset.x) * Math.min(1, dt * 8);
    if (this.tween) {
      const tw = this.tween;
      tw.k = Math.min(1, tw.k + dt / 0.6);
      const e = tw.k < 0.5 ? 2 * tw.k * tw.k : 1 - (-2 * tw.k + 2) ** 2 / 2;
      this.camera.alpha = tw.from.a + (tw.to.alpha - tw.from.a) * e;
      this.camera.beta = tw.from.b + (tw.to.beta - tw.from.b) * e;
      this.camera.radius = tw.from.r + (tw.to.radius - tw.from.r) * e;
      this.camera.target = Vector3.Lerp(tw.from.t, tw.to.target, e);
      if (tw.k >= 1) this.tween = null;
    }
    const v = this.vitals;
    if (!v) return;
    this.monitor.draw(v, dt);
    const rig = this.patient;
    // Breathing at the patient's respiratory rate.
    if (rig.chest) {
      const s = 1 + 0.035 * Math.sin((2 * Math.PI * this.t * v.rr) / 60);
      const cough = this.t < this.coughUntil ? 1 + 0.08 * Math.sin((this.coughUntil - this.t) * 40) : 1;
      rig.chest.scaling.set(1, s * cough, s);
    }
    // Blinking every 2-6 s; each blink closes and opens the lids over 160 ms.
    if (this.t > this.nextBlink + BLINK_S) this.nextBlink = this.t + 2 + Math.random() * 4;
    const phase = (this.t - this.nextBlink) / BLINK_S;
    const blink = phase >= 0 && phase <= 1 ? Math.sin(Math.PI * phase) : 0;
    for (const lid of rig.eyelids) lid.rotationQuaternion = Quaternion.RotationAxis(rig.eyelidAxis, blink * 1.2);
    // Pain: a slow restless head movement.
    if (rig.head && this.appearance.includes("pain")) rig.head.rotation.y = 0.12 * Math.sin(this.t * 0.9) * Math.max(0, Math.sin(this.t * 0.31));
    if (this.appearance.includes("coughing") && Math.sin(this.t * 0.37) > 0.995) this.cough();
  }

  dispose(): void {
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}

