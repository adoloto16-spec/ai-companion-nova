import assert from "node:assert/strict";
import {
  DEFAULT_AVATAR_SETTINGS,
  classifyAvatarFileName,
  normalizeAvatarSettings,
  resolveAvatarSignal,
  resolveDialogueIntent
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
console.log("avatar-runtime.test.ts: passed");
