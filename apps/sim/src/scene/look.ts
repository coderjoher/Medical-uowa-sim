import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Lighting, shadows, reflections and material response for the examination room.
 *
 * "high" (default) adds soft shadows, ambient occlusion and a reflection probe of the room.
 * "low" keeps tone mapping and material tuning only, for weak lab PCs (`?quality=low`).
 */
export type Quality = "high" | "low";

export function chooseQuality(scene: Scene): Quality {
  const q = new URLSearchParams(location.search).get("quality");
  if (q === "low" || q === "high") return q;
  const engine = scene.getEngine() as unknown as { webGLVersion?: number; getGlInfo?: () => { renderer: string } };
  // No GPU acceleration (software rendering): full effects would drop far below 60 fps.
  const renderer = engine.getGlInfo?.().renderer ?? "";
  if (/swiftshader|llvmpipe|software|basic render/i.test(renderer)) return "low";
  return engine.webGLVersion === 1 ? "low" : "high";
}

export class Look {
  readonly quality: Quality;
  private readonly sun: DirectionalLight;
  private readonly shadows: ShadowGenerator | null = null;

  constructor(
    private readonly scene: Scene,
    camera: ArcRotateCamera,
  ) {
    this.quality = chooseQuality(scene);
    const high = this.quality === "high";

    // Cool sky fill from the window side and a warm-neutral ceiling panel as the key light.
    const fill = new HemisphericLight("fill", new Vector3(0.15, 1, -0.3), scene);
    fill.intensity = 0.55;
    fill.diffuse = new Color3(0.96, 0.98, 1);
    fill.groundColor = new Color3(0.42, 0.44, 0.46);
    fill.specular = new Color3(0.15, 0.15, 0.15);
    this.sun = new DirectionalLight("ceiling", new Vector3(0.3, -1, 0.45).normalize(), scene);
    this.sun.position = new Vector3(-1.2, 3.2, -1.6);
    this.sun.intensity = 2.2;
    this.sun.diffuse = new Color3(1, 0.97, 0.92);

    if (high) {
      const sg = new ShadowGenerator(2048, this.sun);
      sg.usePercentageCloserFiltering = true;
      sg.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
      sg.bias = 0.0006;
      sg.normalBias = 0.012;
      sg.darkness = 0.35; // indoor shadows are soft and lit by bounce light
      this.sun.shadowMinZ = 0.5;
      this.sun.shadowMaxZ = 6;
      this.shadows = sg;
    }

    // Filmic colour: ACES tone mapping keeps the bright walls from clipping and gives skin depth.
    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.1;
    ip.contrast = 1.12;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 1.4;
    ip.vignetteColor.set(0.1, 0.12, 0.14, 0);

    if (high) {
      // Ambient occlusion darkens creases and contact points (body on mattress, bed on floor).
      const ssao = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [camera], true);
      ssao.radius = 0.35;
      ssao.totalStrength = 1.1;
      ssao.samples = 16;
      ssao.maxZ = 12;
      ssao.expensiveBlur = true;
      const pipeline = new DefaultRenderingPipeline("look", true, scene, [camera]);
      pipeline.samples = 4; // MSAA, since post-processing bypasses the canvas antialiasing
      pipeline.bloomEnabled = true; // a soft glow on the monitor screen only
      pipeline.bloomThreshold = 0.85;
      pipeline.bloomWeight = 0.22;
      pipeline.bloomKernel = 48;
      pipeline.imageProcessingEnabled = true;
    }
  }

  /** Meshes that cast shadows (patient, bed, monitor, tray). The room only receives them. */
  casters(meshes: AbstractMesh[]): void {
    for (const m of meshes) {
      this.shadows?.addShadowCaster(m, false);
      m.receiveShadows = !!this.shadows;
    }
  }

  receivers(meshes: AbstractMesh[]): void {
    for (const m of meshes) m.receiveShadows = !!this.shadows;
  }

  /**
   * Captures the finished room into a cube map once and uses it for reflections, so metal and
   * vinyl reflect the room instead of a black void.
   */
  captureReflections(meshes: AbstractMesh[], at: Vector3): void {
    if (this.quality !== "high") {
      // Without a reflection map, metal has nothing to reflect and turns black; keep it satin.
      for (const m of this.scene.materials) if (m instanceof PBRMaterial && m.metallic !== null && m.metallic > 0.3) m.metallic = 0.25;
      this.scene.environmentIntensity = 0;
      return;
    }
    const probe = new ReflectionProbe("room-probe", 128, this.scene, true, true);
    probe.position.copyFrom(at);
    probe.refreshRate = 0; // RENDER_ONCE
    for (const m of meshes) probe.renderList!.push(m);
    this.scene.environmentTexture = probe.cubeTexture;
    this.scene.environmentIntensity = 0.55;
  }
}

// ---- Materials -------------------------------------------------------------------------------

type Role = "metal" | "painted_metal" | "plastic" | "rubber" | "fabric" | "vinyl" | "wood" | "floor" | "wall" | "skin" | "hair" | "eye" | "lip" | "gown" | "screen";

/**
 * The Articraft models name each material after its colour (mat_<rrggbb>), from the shared
 * palette in assets/models/src/common.py. This maps them to what they are in the room.
 */
const PALETTE_ROLE: Record<string, Role> = {
  b8bfc7: "metal", // steel
  "8c96a1": "painted_metal", // mid grey frames
  "33383d": "rubber",
  "21262b": "plastic",
  "3d454c": "plastic",
  "0d1217": "plastic",
  b2c4d1: "plastic",
  d1dbe3: "plastic",
  "299499": "plastic",
  "1a6b73": "plastic",
  db7366: "plastic",
  f2bf59: "plastic",
  faf2bf: "plastic",
  "80a8c2": "fabric", // BP cuff
  "8ccccc": "vinyl", // mattress
  c7ad8c: "wood",
  ccd1cc: "floor",
  ebedeb: "wall",
  bdd6d6: "wall",
  f7f7f5: "eye",
};

function hsv(c: Color3): [number, number, number] {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  let h = 0;
  if (d) h = max === c.r ? ((c.g - c.b) / d) % 6 : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}

/** Patients use per-case skin, hair and gown colours, so they are classified by colour. */
function patientRole(name: string, c: Color3): Role {
  const hex = name.replace(/^mat_/, "");
  if (hex === "f7f7f5") return "eye";
  const [h, s, v] = hsv(c);
  if (v < 0.42) return "hair";
  if ((h < 10 || h > 340) && s > 0.3) return "lip";
  if (h >= 8 && h <= 40 && s >= 0.15 && s <= 0.55 && v >= 0.55) return "skin";
  if (h < 8 && s > 0.3 && v > 0.6) return "lip";
  return "gown";
}

function tune(mat: PBRMaterial, role: Role): void {
  mat.metallic = 0;
  switch (role) {
    case "metal":
      mat.metallic = 0.9;
      mat.roughness = 0.28;
      break;
    case "painted_metal":
      mat.metallic = 0.35;
      mat.roughness = 0.42;
      break;
    case "plastic":
      mat.roughness = 0.42;
      mat.clearCoat.isEnabled = false;
      break;
    case "rubber":
      mat.roughness = 0.85;
      break;
    case "vinyl":
      mat.roughness = 0.38;
      mat.clearCoat.isEnabled = true;
      mat.clearCoat.intensity = 0.35;
      mat.clearCoat.roughness = 0.25;
      break;
    case "fabric":
    case "gown":
      // Cloth: very rough with a soft sheen at grazing angles.
      mat.roughness = 0.95;
      mat.sheen.isEnabled = true;
      mat.sheen.intensity = 0.55;
      mat.sheen.color = Color3.White();
      mat.sheen.roughness = 0.6;
      break;
    case "wood":
      mat.roughness = 0.55;
      break;
    case "floor":
      // Polished hospital vinyl: a faint sheen that picks up the room's reflection.
      mat.roughness = 0.32;
      break;
    case "wall":
      mat.roughness = 0.92;
      break;
    case "skin":
      // Skin: soft highlights and a little light scattering through thin parts (ears, fingers).
      mat.roughness = 0.58;
      mat.subSurface.isTranslucencyEnabled = true;
      mat.subSurface.translucencyIntensity = 0.25;
      mat.subSurface.tintColor = new Color3(0.9, 0.35, 0.25);
      mat.sheen.isEnabled = true;
      mat.sheen.intensity = 0.12;
      mat.sheen.color = new Color3(1, 0.9, 0.85);
      break;
    case "hair":
      mat.roughness = 0.62;
      mat.sheen.isEnabled = true;
      mat.sheen.intensity = 0.3;
      break;
    case "eye":
      mat.roughness = 0.08;
      mat.clearCoat.isEnabled = true;
      mat.clearCoat.intensity = 1;
      break;
    case "lip":
      mat.roughness = 0.45;
      break;
    case "screen":
      break;
  }
}

/** Applies physically based material settings to a loaded Articraft model. */
export function tuneMaterials(meshes: AbstractMesh[], kind: "room" | "bed" | "equipment" | "patient"): void {
  const seen = new Set<PBRMaterial>();
  for (const mesh of meshes) {
    const mats = mesh.material ? ("subMaterials" in mesh.material ? ((mesh.material as unknown as { subMaterials: unknown[] }).subMaterials ?? []) : [mesh.material]) : [];
    for (const m of mats) {
      if (!(m instanceof PBRMaterial) || seen.has(m)) continue;
      seen.add(m);
      if (/screen/i.test(m.name)) continue;
      const hex = m.name.replace(/^mat_/, "").toLowerCase();
      let role: Role;
      if (kind === "patient") role = patientRole(m.name, m.albedoColor);
      else if (hex === "f2f5f7") role = kind === "bed" ? "fabric" : "plastic"; // white: sheets and pillow on the bed
      else role = PALETTE_ROLE[hex] ?? "plastic";
      tune(m, role);
    }
  }
}
