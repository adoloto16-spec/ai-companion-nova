import assert from "node:assert/strict";
import { analyzeScreenFrame, parseScreenObservation, SCREEN_ANALYSIS_PROMPT } from "../../modules/vision/src/index";

async function run() {
  const frame = { width: 1280, height: 720, capturedAt: "2026-10-23T12:30:00.000Z", source: "display-capture" as const };
  const result = parseScreenObservation(JSON.stringify({
    summary: "A browser video is visible.",
    regions: [
      { label: "Video", description: "Video viewport", x: 0.1, y: 0.2, width: 0.7, height: 0.6, confidence: 0.85 },
      { label: "Invalid", description: "bad", x: -1, y: 0, width: 0.5, height: 0.5, confidence: 1 }
    ]
  }), frame);
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0]?.bounds.width, 0.7);
  assert.ok(SCREEN_ANALYSIS_PROMPT.includes("normalized"));
  let usedModel = "";
  const inferred = await analyzeScreenFrame({ imageBase64: "aGVsbG8=", ...frame }, {
    analyzeImage: async request => { usedModel = request.model; return JSON.stringify({ summary: "Video", regions: [] }); }
  }, "existing-vision-model");
  assert.equal(usedModel, "existing-vision-model");
  assert.equal(inferred.regions.length, 0);
  await assert.rejects(() => analyzeScreenFrame({ imageBase64: "", ...frame }, { analyzeImage: async () => "{}" }, "model"), /No screen image/);
  console.log("screen-understanding.test.ts: passed");
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
