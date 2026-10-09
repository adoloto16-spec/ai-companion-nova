import assert from "node:assert/strict";
import { parseNovaTurn, serializeNovaTurn, type NovaTurn } from "../../contracts/src/nova-turn";

const source: NovaTurn = {
  version: 1,
  situation: "The user is comparing options.",
  thoughts: "Keep the response focused.",
  emotion: "Curious and calm.",
  tools: [{ name: "read_memory", arguments: { query: "travel preferences" } }, { name: "web_search", arguments: { query: "current fares" } }],
  toolResults: [],
  speech: "Here is the comparison. The input contained <SPEECH> as quoted text.",
  nextWakeMs: 30_000,
};
const serialized = serializeNovaTurn(source);
const roundTrip = parseNovaTurn(serialized);
assert.equal(roundTrip.complete, true);
assert.deepEqual(roundTrip.turn, source);

const damaged = serialized.replace(/<SITUATION>[\\s\\S]*?<\\/SITUATION>/, "<SITUATION>broken");
const recovered = parseNovaTurn(damaged);
assert.equal(recovered.complete, false);
assert.equal(recovered.turn?.speech, source.speech);
assert.equal(recovered.turn?.situation, "");
assert.ok(recovered.diagnostics.length > 0);

assert.equal(parseNovaTurn('{"thought":"plain JSON"}').turn, undefined);
assert.equal(parseNovaTurn("plain text only").turn, undefined);
assert.equal(parseNovaTurn(serialized.replace('version="1"', 'version="2"')).complete, false);
assert.equal(parseNovaTurn(serialized.replace("<NEXT_WAKE_MS>30000</NEXT_WAKE_MS>", "<NEXT_WAKE_MS>3.5</NEXT_WAKE_MS>")).turn?.nextWakeMs, 30_000);
assert.equal(parseNovaTurn(serialized + serialized).turn?.speech, undefined);
console.log("NovaTurn protocol tests passed.");
