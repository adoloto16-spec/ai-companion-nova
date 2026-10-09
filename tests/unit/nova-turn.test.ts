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

const damaged = serialized.replace(/<SITUATION>[\s\S]*?<\/SITUATION>/, "<SITUATION>broken");
const recovered = parseNovaTurn(damaged);
assert.equal(recovered.complete, false);
assert.equal(recovered.turn?.speech, source.speech);
assert.equal(recovered.turn?.situation, "");
assert.ok(recovered.diagnostics.length > 0);

assert.equal(parseNovaTurn('{"thought":"plain JSON"}').turn, undefined);
assert.equal(parseNovaTurn("plain text only").turn, undefined);
const unsupportedVersion=parseNovaTurn(serialized.replace('version="1"', 'version="2"'));
assert.equal(unsupportedVersion.complete, false);
assert.equal(unsupportedVersion.turn, undefined, "unsupported protocol versions cannot recover speech as a valid NovaTurn");
assert.equal(parseNovaTurn(serialized.replace("<NEXT_WAKE_MS>30000</NEXT_WAKE_MS>", "<NEXT_WAKE_MS>3.5</NEXT_WAKE_MS>")).turn?.nextWakeMs, 30_000);
assert.equal(parseNovaTurn(serialized + serialized).turn?.speech, undefined);

const emptyTurn:NovaTurn={...source,situation:"",thoughts:"",emotion:"",tools:[],toolResults:[],speech:"",nextWakeMs:1};
const emptyParsed=parseNovaTurn(serializeNovaTurn(emptyTurn));
assert.equal(emptyParsed.complete,true,"explicit empty fields are valid");
assert.equal(emptyParsed.turn?.speech,"","empty speech stays explicitly empty");
assert.equal(emptyParsed.fields.speech.status,"empty");
assert.equal(emptyParsed.fields.thoughts.status,"empty");

const whitespaceAndCase=parseNovaTurn(
  "<nova_turn version = \"1\" >\n< situation >Context</ SITUATION >\n<THOUGHTS>Private</THOUGHTS >\n<EMOTION>Calm</EMOTION>\n<TOOLS ></TOOLS >\n<TOOL_RESULTS></TOOL_RESULTS>\n<SPEECH >Hello</ SPEECH >\n<NEXT_WAKE_MS>45000</NEXT_WAKE_MS>\n</ nova_turn >"
);
assert.equal(whitespaceAndCase.turn?.speech,"Hello","tag names are case-insensitive and harmless tag whitespace is accepted");
assert.equal(whitespaceAndCase.complete,true);

const aliasWithoutWrapper=parseNovaTurn("<PUBLIC_SPEECH>Recovered public answer</PUBLIC_SPEECH>");
assert.equal(aliasWithoutWrapper.turn?.speech,"Recovered public answer","unique speech aliases recover independently without a wrapper");
assert.equal(aliasWithoutWrapper.fields.speech.status,"recovered");
assert.equal(aliasWithoutWrapper.complete,false);
assert.ok(aliasWithoutWrapper.diagnostics.includes("NOVA_TURN-wrapper-invalid"));

const duplicateSpeech=parseNovaTurn(serialized.replace(
  "</SPEECH>",
  "</SPEECH><SPEECH>private ambiguous content</SPEECH>"
));
assert.equal(duplicateSpeech.turn,undefined,"duplicate speech is never chosen arbitrarily");
assert.equal(duplicateSpeech.fields.speech.status,"invalid");
assert.ok(duplicateSpeech.diagnostics.some(value=>value.includes("SPEECH-duplicate")));

const missingSpeech=parseNovaTurn(serialized.replace(/<SPEECH>[\s\S]*?<\/SPEECH>/,""));
assert.equal(missingSpeech.turn,undefined,"missing speech is not inferred from other fields");
assert.equal(missingSpeech.fields.speech.status,"missing");

const malformedArguments=parseNovaTurn(serialized.replace(
  /<read_memory>[\s\S]*?<\/read_memory>/,
  "<read_memory>{bad json}</read_memory>"
));
assert.equal(malformedArguments.turn?.speech,source.speech,"valid speech survives malformed unrelated tool arguments");
assert.ok(malformedArguments.diagnostics.includes("tool-arguments-invalid:read_memory"));

assert.equal(parseNovaTurn("Situation and thoughts without labelled speech").turn,undefined);
assert.equal(parseNovaTurn("x".repeat(32_001)).diagnostics[0],"response-too-large");

console.log("NovaTurn protocol tests passed.");
