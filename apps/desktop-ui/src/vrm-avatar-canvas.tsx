import React from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import type { VRM } from "@pixiv/three-vrm";
import { getAvatarAsset } from "./avatar-library";
import type { AvatarIntent, AvatarProfile, AvatarSettings } from "../../../modules/character/src/index";

interface LoadedModel {
  root: THREE.Object3D;
  vrm?: VRM;
  mixer?: THREE.AnimationMixer;
  baseScale: THREE.Vector3;
  baseY: number;
  center: THREE.Vector3;
  height: number;
  head?: THREE.Object3D;
  headBase?: THREE.Euler;
  leftArm?: THREE.Object3D;
  leftArmBase?: THREE.Euler;
  rightArm?: THREE.Object3D;
  rightArmBase?: THREE.Euler;
  leftLeg?: THREE.Object3D;
  leftLegBase?: THREE.Euler;
  rightLeg?: THREE.Object3D;
  rightLegBase?: THREE.Euler;
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
    let objectUrl: string | undefined;
    let loaded: LoadedModel | undefined;
    let renderer: THREE.WebGLRenderer | undefined;
    let previousTime = 0;
    let elapsed = 0;
    let blinkRemaining = 0;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x76809a, 2));
    const key = new THREE.DirectionalLight(0xffffff, 2.5);
    key.position.set(1.5, 2.5, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xb8d4ff, 1);
    fill.position.set(-2, 1, 1.5);
    scene.add(fill);

    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
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
    void getAvatarAsset(profile.assetId).then(blob => {
      if (disposed) return;
      if (!blob) throw new Error("The stored model file is missing. Re-import the model.");
      objectUrl = URL.createObjectURL(blob);
      loader.load(objectUrl, gltf => {
        if (disposed) return;
        const vrm = gltf.userData.vrm as VRM | undefined;
        const root = vrm?.scene ?? gltf.scene;
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const head = vrm?.humanoid?.getNormalizedBoneNode("head") ?? undefined;
        const leftArm = vrm?.humanoid?.getNormalizedBoneNode("leftUpperArm") ?? undefined;
        const rightArm = vrm?.humanoid?.getNormalizedBoneNode("rightUpperArm") ?? undefined;
        const leftLeg = vrm?.humanoid?.getNormalizedBoneNode("leftUpperLeg") ?? undefined;
        const rightLeg = vrm?.humanoid?.getNormalizedBoneNode("rightUpperLeg") ?? undefined;
        scene.add(root);
        loaded = {
          root, ...(vrm ? { vrm } : {}),
          ...(gltf.animations.length ? { mixer: new THREE.AnimationMixer(root) } : {}),
          baseScale: root.scale.clone(), baseY: root.position.y, center,
          height: Math.max(size.y, 1),
          ...(head ? { head, headBase: head.rotation.clone() } : {}),
          ...(leftArm ? { leftArm, leftArmBase: leftArm.rotation.clone() } : {}),
          ...(rightArm ? { rightArm, rightArmBase: rightArm.rotation.clone() } : {}),
          ...(leftLeg ? { leftLeg, leftLegBase: leftLeg.rotation.clone() } : {}),
          ...(rightLeg ? { rightLeg, rightLegBase: rightLeg.rotation.clone() } : {})
        };
        if (loaded.mixer && gltf.animations[0]) loaded.mixer.clipAction(gltf.animations[0]).play();
        setStatus(vrm ? "VRM loaded" : gltf.animations.length ? "GLB loaded · animation playing" : "GLB loaded");
      }, undefined, cause => {
        if (disposed) return;
        setStatus("Model load failed");
        setError(cause instanceof Error ? cause.message : "Three.js could not parse this model.");
      });
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
        const walking = action.action === "walk" ? Math.sin(elapsed * 8) * 0.28 * action.intensity : 0;
        const walkBounce = action.action === "walk" ? Math.abs(Math.sin(elapsed * 8)) * 0.012 * action.intensity : 0;
        current.root.position.y = current.baseY + (prefs.breathing ? Math.sin(elapsed * 1.25) * 0.008 * activity : 0) + walkBounce;
        if (current.head && current.headBase) {
          const target = action.action === "point" || action.action === "walk" ? action.target : undefined;
          const yaw = target ? (target.x - 0.5) * 0.45 : prefs.lookAround ? Math.sin(elapsed * 0.37) * 0.12 * activity : 0;
          const pitch = target ? -(target.y - 0.5) * 0.28 : prefs.lookAround ? Math.sin(elapsed * 0.23) * 0.04 * activity : 0;
          current.head.rotation.set(current.headBase.x + pitch, current.headBase.y + yaw, current.headBase.z);
        }
        if (current.rightArm && current.rightArmBase) {
          const wave = action.action === "wave" ? Math.sin(elapsed * 7) * 0.15 * action.intensity : 0;
          const swing = action.action === "walk" ? Math.sin(elapsed * 8 + Math.PI) * 0.18 * action.intensity : 0;
          const point = action.action === "point" && (!action.target || action.target.x >= 0.5) ? 0.65 * action.intensity : 0;
          current.rightArm.rotation.set(current.rightArmBase.x + swing, current.rightArmBase.y, current.rightArmBase.z - (wave || point));
        }
        if (current.leftArm && current.leftArmBase) {
          const swing = action.action === "walk" ? Math.sin(elapsed * 8) * 0.18 * action.intensity : 0;
          const point = action.action === "point" && action.target && action.target.x < 0.5 ? 0.65 * action.intensity : 0;
          current.leftArm.rotation.set(current.leftArmBase.x + swing, current.leftArmBase.y, current.leftArmBase.z - point);
        }
        if (current.leftLeg && current.leftLegBase) {
          current.leftLeg.rotation.set(current.leftLegBase.x + walking, current.leftLegBase.y, current.leftLegBase.z);
        }
        if (current.rightLeg && current.rightLegBase) {
          current.rightLeg.rotation.set(current.rightLegBase.x - walking, current.rightLegBase.y, current.rightLegBase.z);
        }
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
        current.mixer?.update(delta);
        const center = current.center.clone().multiplyScalar(prefs.scale);
        const height = current.height * prefs.scale;
        camera.position.set(center.x, center.y + height * 0.04, center.z + height * prefs.cameraDistance);
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
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      loaded?.mixer?.stopAllAction();
      renderer?.dispose();
      renderer?.domElement.remove();
      scene.clear();
    };
  }, [profile?.assetId, profile?.format, profile?.id]);

  return <div className={"vrm-avatar-canvas " + className} ref={host} aria-label={profile ? "Avatar preview" : "Avatar preview empty"}>
    {status !== "VRM loaded" && status !== "GLB loaded" && status !== "GLB loaded · animation playing" &&
      <div className="avatar-canvas-status" aria-live="polite"><strong>{status}</strong>{error && <span role="alert">{error}</span>}</div>}
  </div>;
}
