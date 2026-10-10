import assert from "node:assert/strict";
import {parseNovaTurn,serializeNovaTurn,type ChatMessage,type NovaTurn} from "../../contracts/src";
import {countVisibleSpeechMessages,resolveNovaTurnMessagePresentation,shouldRenderNovaTurn} from "../../apps/desktop-ui/src/nova-turn-visibility";

const base:NovaTurn={
  version:1,situation:"situation-private",thoughts:"thoughts-private",emotion:"emotion-private",
  tools:[],toolResults:[],speech:"",nextWakeMs:30_000
};
const empty=serializeNovaTurn(base);
const visible=serializeNovaTurn({...base,speech:"Visible user-facing reply.",longMemory:"Private candidate that must never be displayed."});
const malformed="<NOVA_TURN version=\"1\"><THOUGHTS>private note</THOUGHTS>";
const emptyParsed=parseNovaTurn(empty);
const visibleParsed=parseNovaTurn(visible);
const malformedParsed=parseNovaTurn(malformed);

assert.equal(shouldRenderNovaTurn(emptyParsed,false),false,"empty speech is hidden in ordinary Chat");
assert.equal(shouldRenderNovaTurn(emptyParsed,true),true,"empty persisted turns remain visible in technical mode");
assert.equal(shouldRenderNovaTurn(malformedParsed,false),false,"malformed raw content is never presented as public speech");
assert.equal(shouldRenderNovaTurn(malformedParsed,true),true,"malformed persisted turns remain visible in technical mode");
assert.equal(shouldRenderNovaTurn(visibleParsed,false),true,"unique valid speech remains visible in ordinary Chat");
assert.equal(visibleParsed.turn?.speech,"Visible user-facing reply.","ordinary Chat reads only SPEECH even when LONGMEMORY is present");
assert.notEqual(visibleParsed.speech,"Private candidate that must never be displayed.","LONGMEMORY is never promoted to visible speech");

const ordinary:ChatMessage={id:"ordinary",role:"assistant",content:"Ordinary assistant text without NovaTurn metadata."};
const ordinaryPresentation=resolveNovaTurnMessagePresentation(ordinary,false);
assert.equal(ordinaryPresentation.isNovaTurn,false,"ordinary assistant messages are not parsed as NovaTurn");
assert.equal(ordinaryPresentation.render,true,"ordinary assistant messages remain visible");
assert.equal(ordinaryPresentation.text,ordinary.content,"ordinary assistant content remains unchanged");

const taggedWithMetadata:ChatMessage={id:"tagged",role:"assistant",content:visible,metadata:{novaTurnVersion:1}};
const taggedPresentation=resolveNovaTurnMessagePresentation(taggedWithMetadata,false);
assert.equal(taggedPresentation.render,true,"valid persisted tag-format NovaTurn is visible");
assert.equal(taggedPresentation.text,"Visible user-facing reply.","tag-format rendering projects only SPEECH");

const jsonPayload=JSON.stringify({
  version:1,
  speech:"Native JSON speech survives history reload.",
  situation:"native-situation",
  thoughts:"native-thoughts",
  emotion:"native-emotion",
  tools:[{name:"read_memory",arguments:{query:"private"}}],
  longMemory:"Private native JSON memory candidate.",
  nextWakeMs:45_000
});
const nativeJsonMessage:ChatMessage={id:"native-json",role:"assistant",content:jsonPayload,metadata:{novaTurnVersion:1}};
const nativePresentation=resolveNovaTurnMessagePresentation(nativeJsonMessage,false);
assert.equal(nativePresentation.render,true,"valid native JSON Schema NovaTurn is not hidden by the tag parser");
assert.equal(nativePresentation.text,"Native JSON speech survives history reload.","JSON NovaTurn displays only speech");
assert.equal(nativePresentation.parseResult?.turn?.longMemory,"Private native JSON memory candidate.","native JSON parser retains LONGMEMORY for technical diagnostics");
assert.deepEqual(nativePresentation.parseResult?.turn?.toolResults,[],"JSON parsing never accepts model-invented tool results");
assert.equal(nativePresentation.text.includes("native-thoughts")||nativePresentation.text.includes("Private native JSON memory"),false,"JSON internal fields never enter normal message text");
const nativeJsonWithoutMetadata:ChatMessage={id:"native-json-legacy",role:"assistant",content:jsonPayload};
const unmarkedNativePresentation=resolveNovaTurnMessagePresentation(nativeJsonWithoutMetadata,false);
assert.equal(unmarkedNativePresentation.isNovaTurn,true,"schema-valid stored NovaTurn JSON is recognized without metadata");
assert.equal(unmarkedNativePresentation.text,"Native JSON speech survives history reload.","schema-valid native JSON is projected to speech even when metadata was lost");
const malformedJsonWithoutMetadata:ChatMessage={id:"ordinary-json",role:"assistant",content:'{"version":1,"speech":"unfinished'};
const malformedOrdinary=resolveNovaTurnMessagePresentation(malformedJsonWithoutMetadata,false);
assert.equal(malformedOrdinary.isNovaTurn,false,"malformed JSON without NovaTurn metadata is not reclassified as a NovaTurn");
assert.equal(malformedOrdinary.text,malformedJsonWithoutMetadata.content,"ordinary assistant text without metadata remains ordinary text");

const jsonWithoutLongMemory=JSON.stringify({
  version:1,speech:"No memory candidate.",situation:"",thoughts:"",emotion:"",tools:[],nextWakeMs:30_000
});
assert.equal(resolveNovaTurnMessagePresentation({id:"json-no-memory",role:"assistant",content:jsonWithoutLongMemory,metadata:{novaTurnVersion:1}},false).text,
  "No memory candidate.","schema-valid JSON with absent optional LONGMEMORY remains renderable");

const oldTaggedWithoutMetadata:ChatMessage={id:"old-tagged",role:"assistant",content:visible};
const oldTaggedPresentation=resolveNovaTurnMessagePresentation(oldTaggedWithoutMetadata,false);
assert.equal(oldTaggedPresentation.isNovaTurn,true,"pre-metadata tagged NovaTurn history is recognized by its envelope");
assert.equal(oldTaggedPresentation.render,true,"old tagged history remains visible");
assert.equal(oldTaggedPresentation.text,"Visible user-facing reply.","old tagged history continues to render speech only");

const malformedJson:ChatMessage={id:"bad-json",role:"assistant",content:'{"version":1,"speech":"unfinished',metadata:{novaTurnVersion:1}};
const invalidJsonDefault=resolveNovaTurnMessagePresentation(malformedJson,false);
const invalidJsonTechnical=resolveNovaTurnMessagePresentation(malformedJson,true);
assert.equal(invalidJsonDefault.render,false,"invalid JSON NovaTurn is hidden from ordinary chat");
assert.equal(invalidJsonTechnical.render,true,"invalid JSON NovaTurn stays accessible for diagnosis");
assert.equal(invalidJsonTechnical.text,"The model returned no valid speech.","technical mode does not leak raw JSON into the regular speech bubble");
assert.ok(invalidJsonTechnical.parseResult?.diagnostics.some(item=>item==="native-json-invalid-json"),"malformed JSON has an explicit parser diagnostic");

const messages:ChatMessage[]=[
  {id:"user",role:"user",content:"Question"},
  {id:"empty",role:"assistant",content:empty,metadata:{novaTurnVersion:1}},
  taggedWithMetadata,
  {id:"malformed",role:"assistant",content:malformed,metadata:{novaTurnVersion:1}},
  {id:"legacy",role:"assistant",content:"Legacy plain reply"},
  {id:"old-tagged",role:"assistant",content:visible},
  nativeJsonMessage,
  nativeJsonWithoutMetadata,
  malformedJson,
  {id:"tool",role:"tool",content:"tool result"}
];
assert.equal(countVisibleSpeechMessages(messages),5,"count includes plain assistant, canonical tag, pre-metadata tag and both schema-valid native JSON messages; excludes empty/invalid/user/tool");

const reloadedMessages=JSON.parse(JSON.stringify([taggedWithMetadata,nativeJsonMessage,nativeJsonWithoutMetadata,oldTaggedWithoutMetadata])) as ChatMessage[];
assert.equal(resolveNovaTurnMessagePresentation(reloadedMessages[0]!,false).text,"Visible user-facing reply.","tag-format history remains visible after persistence/reload round-trip");
assert.equal(resolveNovaTurnMessagePresentation(reloadedMessages[1]!,false).text,"Native JSON speech survives history reload.","native JSON history remains visible after persistence/reload round-trip");
assert.equal(resolveNovaTurnMessagePresentation(reloadedMessages[2]!,false).text,"Native JSON speech survives history reload.","metadata-free native JSON history remains visible after reload");
assert.equal(resolveNovaTurnMessagePresentation(reloadedMessages[3]!,false).text,"Visible user-facing reply.","legacy tagged history without metadata remains visible after reload");

const technicalEmpty=resolveNovaTurnMessagePresentation({id:"empty",role:"assistant",content:empty,metadata:{novaTurnVersion:1}},true);
assert.equal(technicalEmpty.render,true,"technical mode preserves empty turns");
assert.equal(technicalEmpty.text,"The model returned no valid speech.","empty records never promote serialized fields to ordinary text");
assert.equal(technicalEmpty.parseResult?.fields.situation.status,"empty","technical mode retains field statuses");
console.log("nova-turn-visibility: ok");
