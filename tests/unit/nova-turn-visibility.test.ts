import assert from "node:assert/strict";
import {parseNovaTurn,serializeNovaTurn,type ChatMessage,type NovaTurn} from "../../contracts/src";
import {countVisibleSpeechMessages,shouldRenderNovaTurn} from "../../apps/desktop-ui/src/nova-turn-visibility";

const base:NovaTurn={
  version:1,situation:"",thoughts:"",emotion:"",tools:[],toolResults:[],speech:"",nextWakeMs:30_000
};
const empty=serializeNovaTurn(base);
const visible=serializeNovaTurn({...base,speech:"Visible user-facing reply."});
const malformed="<NOVA_TURN version=\"1\"><THOUGHTS>private note</THOUGHTS>";
const emptyParsed=parseNovaTurn(empty);
const visibleParsed=parseNovaTurn(visible);
const malformedParsed=parseNovaTurn(malformed);

assert.equal(shouldRenderNovaTurn(emptyParsed,false),false,"empty speech is hidden in ordinary Chat");
assert.equal(shouldRenderNovaTurn(emptyParsed,true),true,"empty persisted turns remain visible in technical mode");
assert.equal(shouldRenderNovaTurn(malformedParsed,false),false,"malformed raw content is never presented as public speech");
assert.equal(shouldRenderNovaTurn(malformedParsed,true),true,"malformed persisted turns remain visible in technical mode");
assert.equal(shouldRenderNovaTurn(visibleParsed,false),true,"unique valid speech remains visible in ordinary Chat");

const messages:ChatMessage[]=[
  {id:"user",role:"user",content:"Question"},
  {id:"empty",role:"assistant",content:empty,metadata:{novaTurnVersion:1}},
  {id:"visible",role:"assistant",content:visible,metadata:{novaTurnVersion:1}},
  {id:"malformed",role:"assistant",content:malformed,metadata:{novaTurnVersion:1}},
  {id:"legacy",role:"assistant",content:"Legacy reply"},
  {id:"tool",role:"tool",content:"tool result"}
];
assert.equal(messages.length,6,"test keeps all persisted records");
assert.equal(countVisibleSpeechMessages(messages),2,"speech count includes visible NovaTurn speech and legacy assistant replies, but excludes user messages, hidden/unparseable turns and tool records");
console.log("nova-turn-visibility: ok");
