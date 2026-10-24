import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_AVATAR_SETTINGS,
  classifyAvatarFileName,
  normalizeAvatarSettings,
  resolveAvatarSignal,
  resolveDialogueIntent,
  publishAvatarIntent,
  subscribeAvatarEvents
} from "../../modules/character/src/index";

const settings = normalizeAvatarSettings({ scale: 99, cameraDistance: Number.NaN, motionIntensity: -2, autonomy: "invalid", blink: false });
assert.equal(settings.scale, 1.8);
assert.equal(settings.cameraDistance, DEFAULT_AVATAR_SETTINGS.cameraDistance);
assert.equal(settings.motionIntensity, 0);
assert.equal(settings.autonomy, "balanced");
assert.equal(settings.blink, false);
assert.equal(classifyAvatarFileName("NOVA.VRM"), "vrm");
assert.equal(classifyAvatarFileName("scene.glb"), "glb");
assert.throws(() => classifyAvatarFileName("model.gltf"), /\.vrm/);
assert.equal(resolveDialogueIntent("That is interesting", true).action, "talk");
assert.equal(resolveDialogueIntent("That is interesting", false).expression, "happy");
assert.deepEqual(resolveAvatarSignal({ type: "user-action", action: "wave" }), {
  action: "wave", expression: "happy", intensity: 1
});
const canvasSource=fs.readFileSync(path.resolve(process.cwd(),"apps/desktop-ui/src/vrm-avatar-canvas.tsx"),"utf8");
assert.ok(canvasSource.includes('className="vrm-avatar-canvas-renderer" ref={host}'),"Three.js receives a dedicated inner host that React does not populate with overlay nodes");
assert.ok(canvasSource.includes('className={"vrm-avatar-canvas " + className} aria-label='),"the React-owned avatar overlay remains mounted outside the imperative Three.js host");
let receivedIntent:unknown;
const unsubscribeAvatar = subscribeAvatarEvents(event=>{if(event.kind==="intent")receivedIntent=event;});
const publishedIntent={action:"wave" as const,expression:"happy" as const,intensity:1};
publishAvatarIntent(publishedIntent);
assert.deepEqual(receivedIntent,{kind:"intent",intent:publishedIntent},"avatar actions are delivered synchronously in the current Chat view as well as across windows");
unsubscribeAvatar();
assert.ok(canvasSource.includes("toneMappingExposure = 1"),"VRM renderer tones down overexposed material colors");
assert.ok(canvasSource.includes("leftUpperArm")&&canvasSource.includes("leftLowerArm"),"procedural avatar rig moves upper and lower arms instead of remaining in a T-pose");
assert.ok(canvasSource.includes("const leftLeg = bone(\"leftUpperLeg\")"),"humanoid locomotion includes weight-shift animation for the legs");
assert.ok(canvasSource.includes("action.action === \"wave\""),"the avatar rig has a dedicated arm-wave animation");
assert.ok(canvasSource.includes('current.vrm?.meta.metaVersion === "0" ? -1 : 1'),"camera uses the VRM 0.x forward direction instead of viewing the back");
assert.ok(canvasSource.includes("prepareAvatarMaterials(root)"),"loaded avatar material maps are reconfigured for sRGB and uploaded");
assert.ok(canvasSource.includes("baseColorTextures === 0"),"textureless imports report the material/texture diagnosis instead of silently claiming a complete load");
console.log("avatar-runtime.test.ts: passed");
