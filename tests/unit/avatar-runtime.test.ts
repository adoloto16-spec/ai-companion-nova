import assert from "node:assert/strict";
import {
  DEFAULT_AVATAR_SETTINGS, classifyAvatarFileName, normalizeAvatarSettings,
  findUniqueMatchingMonitor, resolveOverlayPlacement, resolveAvatarSignal, resolveDialogueIntent
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
const intent = resolveAvatarSignal({
  type: "screen-region", label: "Video", bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, confidence: 0.8
});
assert.equal(intent.action, "point");
assert.deepEqual(intent.target, { x: 0.25, y: 0.4 });
assert.throws(() => resolveAvatarSignal({
  type: "screen-region", label: "Bad", bounds: { x: -1, y: 0, width: 1, height: 1 }, confidence: 1
}), /bounds are invalid/);
const monitor = {
  physicalSize: { width: 1920, height: 1080 },
  logicalPosition: { x: 0, y: 0 },
  logicalSize: { width: 1920, height: 1080 },
  workAreaPosition: { x: 0, y: 0 },
  workAreaSize: { width: 1920, height: 1040 },
  scaleFactor: 1
};
assert.equal(findUniqueMatchingMonitor({ surface: "monitor", width: 1920, height: 1080 }, [monitor]), monitor);
assert.equal(findUniqueMatchingMonitor({ surface: "window", width: 1920, height: 1080 }, [monitor]), undefined);
assert.equal(findUniqueMatchingMonitor({ surface: "monitor", width: 1920, height: 1080 }, [monitor, monitor]), undefined);
assert.deepEqual(resolveOverlayPlacement({ x: 0.7, y: 0.4, width: 0.2, height: 0.15 }, monitor), {
  x: 1198, y: 173, width: 320, height: 500
});
assert.throws(() => resolveOverlayPlacement({ x: -1, y: 0, width: 0.2, height: 0.2 }, monitor), /geometry is invalid/);
console.log("avatar-runtime.test.ts: passed");
