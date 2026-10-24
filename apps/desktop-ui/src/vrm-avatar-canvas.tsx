import React from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import type { VRM } from "@pixiv/three-vrm";
import { getAvatarAsset } from "./avatar-library";
import type { AvatarIntent, AvatarProfile, AvatarSettings } from "../../../modules/character/src/index";

type HumanoidBone =
  | "head" | "neck" | "hips" | "spine" | "chest"
  | "leftUpperArm" | "rightUpperArm" | "leftLowerArm" | "rightLowerArm"
  | "leftUpperLeg" | "rightUpperLeg" | "leftLowerLeg" | "rightLowerLeg";

const HUMANOID_BONES: readonly HumanoidBone[] = [
  "head", "neck", "hips", "spine", "chest",
  "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm",
  "leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg"
];

interface LoadedModel {
  root: THREE.Object3D;
  vrm?: VRM;
  mixer?: THREE.AnimationMixer;
  baseScale: THREE.Vector3;
  baseY: number;
  baseRotation: THREE.Euler;
  center: THREE.Vector3;
  height: number;
  bones: Partial<Record<HumanoidBone, THREE.Object3D>>;
  boneBases: Partial<Record<HumanoidBone, THREE.Euler>>;
}

function prepareAvatarMaterials(root: THREE.Object3D): { meshes: number; materials: number; baseColorTextures: number } {
  let meshes = 0;
  let materials = 0;
  let baseColorTextures = 0;
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    meshes++;
    const slots = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of slots) {
      materials++;
      // GLTF/VRM base-color textures use sRGB. Reassert it for both standard and MToon materials
      // and request an upload before the first frame instead of silently rendering as untextured.
      const map = (material as THREE.Material & { map?: THREE.Texture | null }).map;
      if (map instanceof THREE.Texture) {
        map.colorSpace = THREE.SRGBColorSpace;
        map.needsUpdate = true;
        baseColorTextures++;
      }
      material.needsUpdate = true;
    }
  });
  return { meshes, materials, baseColorTextures };
}

export default function VrmAvatarCanvas({ profile, settings, intent, className = "" }: {
  profile?: AvatarProfile;
  settings: AvatarSettings;
  intent: AvatarIntent;
  className?: string;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const settingsRef = React.useRef(settings);
  const intentRef = React.useRef(intent);
  const [status, setStatus] = React.useState("No model loaded");
  const [error, setError] = React.useState("");

  React.useEffect(() => { settingsRef.current = settings; }, [settings]);
  React.useEffect(() => { intentRef.current = intent; }, [intent]);

  React.useEffect(() => {
    const container = host.current;
    if (!container || !profile) {
      setStatus("Import a .vrm or .glb model to begin.");
      setError("");
      return;
    }
    let disposed = false;
    let frame = 0;
    let loaded: LoadedModel | undefined;
    let renderer: THREE.WebGLRenderer | undefined;
    let previousTime = 0;
    let elapsed = 0;
    let blinkRemaining = 0;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x76809a, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(1.5, 2.5, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xb8d4ff, 0.35);
    fill.position.set(-2, 1, 1.5);
    scene.add(fill);

    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
      // This ref targets a dedicated empty renderer host, not the parent holding React overlays.
      container.replaceChildren(renderer.domElement);
    } catch (cause) {
      setStatus("Renderer unavailable");
      setError(cause instanceof Error ? cause.message : "WebGL could not be initialized.");
      return;
    }
    const resize = new ResizeObserver(() => {
      if (!renderer || disposed) return;
      const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resize.observe(container);

    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    setError("");
    setStatus("Reading local model…");
    const acceptGltf = (gltf: import("three/addons/loaders/GLTFLoader.js").GLTF) => {
      if (disposed) return;
      const vrm = gltf.userData.vrm as VRM | undefined;
      const root = vrm?.scene ?? gltf.scene;
      const materialDiagnostics = prepareAvatarMaterials(root);
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      if (![size.x, size.y, size.z, center.x, center.y, center.z].every(Number.isFinite) || size.y <= 0.01 || size.x <= 0 || size.z <= 0) {
        setStatus("Model has no renderable geometry");
        setError("The selected file did not produce a visible 3D mesh. Verify that it is a valid, self-contained VRM/GLB file.");
        return;
      }
      const bones: Partial<Record<HumanoidBone, THREE.Object3D>> = {};
      const boneBases: Partial<Record<HumanoidBone, THREE.Euler>> = {};
      for (const name of HUMANOID_BONES) {
        const node = vrm?.humanoid?.getNormalizedBoneNode(name);
        if (node) {
          bones[name] = node;
          boneBases[name] = node.rotation.clone();
        }
      }
      scene.add(root);
      loaded = {
        root, ...(vrm ? { vrm } : {}),
        ...(gltf.animations.length ? { mixer: new THREE.AnimationMixer(root) } : {}),
        baseScale: root.scale.clone(), baseY: root.position.y, baseRotation: root.rotation.clone(), center,
        height: Math.max(size.y, 1), bones, boneBases
      };
      if (loaded.mixer && gltf.animations[0]) loaded.mixer.clipAction(gltf.animations[0]).play();
      if (materialDiagnostics.meshes > 0 && materialDiagnostics.baseColorTextures === 0) {
        setStatus(vrm ? "VRM loaded · no color textures" : "GLB loaded · no color textures");
        setError("Loaded " + materialDiagnostics.meshes + " mesh(es) with " + materialDiagnostics.materials + " material slot(s), but none has a base-color texture map. This file may have been exported without embedded textures; import a self-contained textured VRM/GLB.");
      } else {
        setError("");
        setStatus(vrm ? "VRM loaded" : gltf.animations.length ? "GLB loaded · animation playing" : "GLB loaded");
      }
    };
    const failGltf = (cause: unknown) => {
      if (disposed) return;
      setStatus("Model load failed");
      setError(cause instanceof Error ? cause.message : "Three.js could not parse this model.");
    };
    setStatus("Reading local model…");
    void getAvatarAsset(profile.assetId).then(async blob => {
      if (disposed) return;
      if (!blob) throw new Error("The stored model file is missing. Re-import the model.");
      // VRM and the supported GLB import flow are self-contained binary glTF files. Parsing
      // bytes directly avoids fetching a blob: URL, which the packaged Tauri CSP does not allow.
      const buffer = await blob.arrayBuffer();
      if (disposed) return;
      setStatus("Parsing model…");
      loader.parse(buffer, "", acceptGltf, failGltf);
    }).catch(cause => {
      if (disposed) return;
      setStatus("Model unavailable");
      setError(cause instanceof Error ? cause.message : "Local avatar storage could not be read.");
    });

    const render = (now: number) => {
      if (disposed || !renderer) return;
      const delta = previousTime ? Math.min((now - previousTime) / 1000, 0.05) : 0;
      previousTime = now;
      elapsed += delta;
      const current = loaded;
      if (current) {
        const prefs = settingsRef.current, action = intentRef.current;
        const activity = prefs.idleMotion && prefs.autonomy !== "off" ? prefs.motionIntensity : 0;
        current.root.scale.copy(current.baseScale).multiplyScalar(prefs.scale);
        current.root.position.y = current.baseY + (prefs.breathing ? Math.sin(elapsed * 1.25) * 0.018 * activity : 0);
        if (current.vrm || !current.mixer) {
          current.root.rotation.set(
            current.baseRotation.x + Math.sin(elapsed * 0.42) * 0.018 * activity,
            current.baseRotation.y + Math.sin(elapsed * 0.31) * 0.035 * activity,
            current.baseRotation.z + Math.sin(elapsed * 0.58) * 0.012 * activity
          );
        }
        // Let embedded GLB animation update its own tracks before applying the procedural VRM pose.
        current.mixer?.update(delta);

        const bone = (name: HumanoidBone) => current.bones[name];
        const base = (name: HumanoidBone) => current.boneBases[name];
        const head = bone("head"), headBase = base("head");
        if (head && headBase) {
          const yaw = prefs.lookAround ? Math.sin(elapsed * 0.57) * 0.18 * Math.max(activity, 0.5) : 0;
          const pitch = prefs.lookAround ? Math.sin(elapsed * 0.37) * 0.06 * Math.max(activity, 0.5) : 0;
          head.rotation.set(headBase.x + pitch, headBase.y + yaw, headBase.z);
        }
        const leftUpper = bone("leftUpperArm"), leftBase = base("leftUpperArm");
        const rightUpper = bone("rightUpperArm"), rightBase = base("rightUpperArm");
        const leftLower = bone("leftLowerArm"), leftLowerBase = base("leftLowerArm");
        const rightLower = bone("rightLowerArm"), rightLowerBase = base("rightLowerArm");
        const wave = action.action === "wave" ? Math.sin(elapsed * 8) * 0.22 * action.intensity : 0;
        const talkingGesture = action.action === "talk" ? Math.sin(elapsed * 2.6) * 0.22 * action.intensity : 0;
        // Establish a relaxed non-T-pose as the baseline for ordinary humanoid VRMs.
        // The left/right signs are mirrored because humanoid upper-arm local axes are mirrored.
        if (leftUpper && leftBase) {
          const shoulderSwing = Math.sin(elapsed * 1.7) * 0.07 * activity;
          leftUpper.rotation.set(leftBase.x + talkingGesture * 0.55, leftBase.y + shoulderSwing, leftBase.z + 0.52 + talkingGesture);
        }
        if (rightUpper && rightBase) {
          if (action.action === "wave") {
            rightUpper.rotation.set(rightBase.x - 0.65, rightBase.y - 0.12, rightBase.z - 1.15 + wave);
          } else {
            const shoulderSwing = Math.sin(elapsed * 1.7 + 0.7) * 0.07 * activity;
            rightUpper.rotation.set(rightBase.x + talkingGesture * 0.55, rightBase.y - shoulderSwing, rightBase.z - 0.52 - talkingGesture);
          }
        }
        if (leftLower && leftLowerBase) {
          const elbowBend = action.action === "talk" ? 0.38 + Math.abs(Math.sin(elapsed * 2.6)) * 0.25 : 0.12;
          leftLower.rotation.set(leftLowerBase.x, leftLowerBase.y, leftLowerBase.z - elbowBend * Math.max(activity, action.action === "talk" ? 0.8 : 0.2));
        }
        if (rightLower && rightLowerBase) {
          if (action.action === "wave") rightLower.rotation.set(rightLowerBase.x, rightLowerBase.y - 0.12, rightLowerBase.z - 0.72 + wave * 1.35);
          else {
            const elbowBend = action.action === "talk" ? 0.38 + Math.abs(Math.sin(elapsed * 2.3 + 1)) * 0.25 : 0.12;
            rightLower.rotation.set(rightLowerBase.x, rightLowerBase.y, rightLowerBase.z + elbowBend * Math.max(activity, action.action === "talk" ? 0.8 : 0.2));
          }
        }
        const spine = bone("spine"), spineBase = base("spine");
        if (spine && spineBase) spine.rotation.set(spineBase.x + Math.sin(elapsed * 0.8) * 0.025 * activity, spineBase.y + talkingGesture * 0.2, spineBase.z);
        const chest = bone("chest"), chestBase = base("chest");
        if (chest && chestBase) chest.rotation.set(chestBase.x + Math.sin(elapsed * 1.2) * 0.018 * activity, chestBase.y, chestBase.z);
        const hips = bone("hips"), hipsBase = base("hips");
        if (hips && hipsBase) hips.rotation.set(hipsBase.x, hipsBase.y + Math.sin(elapsed * 0.34) * 0.025 * activity, hipsBase.z);
        const leftLeg = bone("leftUpperLeg"), leftLegBase = base("leftUpperLeg");
        const rightLeg = bone("rightUpperLeg"), rightLegBase = base("rightUpperLeg");
        const leftShin = bone("leftLowerLeg"), leftShinBase = base("leftLowerLeg");
        const rightShin = bone("rightLowerLeg"), rightShinBase = base("rightLowerLeg");
        const weightShift = Math.sin(elapsed * 1.45) * 0.035 * activity;
        if (leftLeg && leftLegBase) leftLeg.rotation.set(leftLegBase.x + weightShift, leftLegBase.y, leftLegBase.z);
        if (rightLeg && rightLegBase) rightLeg.rotation.set(rightLegBase.x - weightShift, rightLegBase.y, rightLegBase.z);
        if (leftShin && leftShinBase) leftShin.rotation.set(leftShinBase.x + Math.max(0, weightShift) * 0.5, leftShinBase.y, leftShinBase.z);
        if (rightShin && rightShinBase) rightShin.rotation.set(rightShinBase.x + Math.max(0, -weightShift) * 0.5, rightShinBase.y, rightShinBase.z);

        if (current.vrm?.expressionManager) {
          const expressions = current.vrm.expressionManager;
          expressions.setValue("happy", action.expression === "happy" ? action.intensity : 0);
          expressions.setValue("sad", action.expression === "sad" ? action.intensity : 0);
          expressions.setValue("surprised", action.expression === "surprised" ? action.intensity : 0);
          expressions.setValue("aa", action.action === "talk" ? 0.12 + Math.abs(Math.sin(elapsed * 9)) * 0.34 : 0);
          if (prefs.blink) {
            if (elapsed % 4.3 < delta) blinkRemaining = 0.12;
            blinkRemaining = Math.max(0, blinkRemaining - delta);
            expressions.setValue("blink", blinkRemaining > 0 ? Math.sin(Math.PI * blinkRemaining / 0.12) : 0);
          } else expressions.setValue("blink", 0);
        }
        current.vrm?.update(delta);
        const center = current.center.clone().multiplyScalar(prefs.scale);
        const height = current.height * prefs.scale;
        // VRM 0.x faces -Z; VRM 1.0 faces +Z. A fixed +Z camera views VRM 0.x from behind.
        const cameraSide = current.vrm?.meta.metaVersion === "0" ? -1 : 1;
        camera.position.set(center.x, center.y + height * 0.04, center.z + height * prefs.cameraDistance * cameraSide);
        camera.lookAt(center);
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      loaded?.mixer?.stopAllAction();
      renderer?.dispose();
      renderer?.domElement.remove();
      scene.clear();
    };
  }, [profile?.assetId, profile?.format, profile?.id]);

  return <div className={"vrm-avatar-canvas " + className} aria-label={profile ? "Avatar preview" : "Avatar preview empty"}>
    <div className="vrm-avatar-canvas-renderer" ref={host} aria-hidden="true" />
    {status !== "VRM loaded" && status !== "GLB loaded" && status !== "GLB loaded · animation playing" &&
      <div className={"avatar-canvas-status" + (error ? " avatar-canvas-status-error" : "")} aria-live="polite"><strong>{status}</strong>{error && <span role="alert">{error}</span>}</div>}
  </div>;
}
