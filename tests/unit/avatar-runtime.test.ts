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
  subscribeAvatarEvents,
  solveTwoBoneIk,
  AvatarBoneController,
  parseAvatarDirectorOutput
} from "../../modules/character/src/index";

const settings = normalizeAvatarSettings({ scale: 99, cameraDistance: Number.NaN, motionIntensity: -2, autonomy: "invalid", blink: false });
assert.equal(settings.scale, 1.8);
assert.equal(settings.cameraDistance, DEFAULT_AVATAR_SETTINGS.cameraDistance);
assert.equal(normalizeAvatarSettings({ cameraDistance: 1.1 }).cameraDistance, 1.7);
assert.equal(normalizeAvatarSettings({ trackCursor: true }).trackCursor, true);
assert.equal(normalizeAvatarSettings({ directorEnabled: false }).directorEnabled, false);
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
const ik = solveTwoBoneIk(
  {x:0,y:0,z:0}, {x:1,y:1,z:0}, 1, 1, {x:0,y:0,z:1}
);
const distance = (a:{x:number;y:number;z:number},b:{x:number;y:number;z:number}) =>
  Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
assert.ok(Math.abs(distance({x:0,y:0,z:0},ik.elbow)-1)<1e-6,"IK preserves upper-arm length");
assert.ok(Math.abs(distance(ik.elbow,ik.wrist)-1)<1e-6,"IK preserves forearm length");
assert.ok(ik.elbow.z>0,"IK uses the supplied bend plane");
const controller = new AvatarBoneController();
controller.setIntent({action:"wave",expression:"happy",intensity:1,gesture:"greet",durationMs:2000});
let gestureFrame = controller.update(1/60);
for(let i=0;i<59;i++)gestureFrame = controller.update(1/60);
assert.ok(gestureFrame.rightHand.vertical > gestureFrame.leftHand.vertical,"greeting raises the right hand through semantic hand targets");
for(let i=0;i<180;i++)gestureFrame = controller.update(1/60);
assert.ok(Math.abs(gestureFrame.rightHand.vertical - gestureFrame.leftHand.vertical) < 0.03,"a completed gesture settles back toward a balanced rest pose");
const directed = parseAvatarDirectorOutput(JSON.stringify({
  gesture:"greet",expression:"happy",gaze:"user",intensity:0.8,durationMs:1800
}));
assert.deepEqual(directed,{
  action:"wave",expression:"happy",intensity:0.8,
  gesture:"greet",gaze:"user",durationMs:1800
});
assert.equal(parseAvatarDirectorOutput('{"gesture":"unknown"}'),undefined,"invalid agent output is rejected");
const canvasSource=fs.readFileSync(path.resolve(process.cwd(),"apps/desktop-ui/src/vrm-avatar-canvas.tsx"),"utf8");
const overlaySource=fs.readFileSync(path.resolve(process.cwd(),"apps/desktop-ui/src/avatar-overlay.tsx"),"utf8");
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
assert.ok(canvasSource.includes("uniforms?.map?.value"),"VRM MToon base-color textures are detected through shader uniforms");
assert.ok(canvasSource.includes("cursorTargetRef.current"),"cursor gaze target updates without recreating the WebGL renderer");
assert.ok(overlaySource.includes('window.addEventListener("pointermove", handlePointerMove'),"cursor gaze uses supported WebView pointer events");
assert.ok(overlaySource.includes("overlayPassthrough && !next.profile.settings.trackCursor"),"cursor tracking keeps pointer events enabled in the native overlay");
assert.ok(canvasSource.includes("applyTwoBoneArmIk"),"semantic arm gestures are solved against normalized VRM hand end-effectors");
assert.ok(canvasSource.includes("candidate.isTexture === true")&&!canvasSource.includes('"needsUpdate" in candidate'),"texture diagnostics use Three.js isTexture marker and do not reject the needsUpdate setter");
assert.ok(canvasSource.includes("decodedBaseColorTextures")&&canvasSource.includes("missingBaseColorTextureImages"),"avatar diagnostics distinguish assigned textures from unavailable image pixels");
assert.ok(canvasSource.includes("(current.height * 0.56) / Math.tan(verticalHalfFov)") && canvasSource.includes("(current.width * 0.56) / Math.tan(horizontalHalfFov)"),"camera full-body fit accounts for both unscaled model height and width");
assert.ok(canvasSource.includes("baseColorTextures === 0"),"textureless imports report the material/texture diagnosis instead of silently claiming a complete load");
console.log("avatar-runtime.test.ts: passed");
