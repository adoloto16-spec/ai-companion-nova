import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const source=fs.readFileSync(path.resolve(process.cwd(),"apps/desktop-ui/src/main.tsx"),"utf8");
assert.doesNotMatch(source,/AgentChatController/,"AgentChatController must not remain in the user-facing Chat");
assert.doesNotMatch(source,/Send to Agent/,"Send to Agent must not remain in the UI");
assert.doesNotMatch(source,/chat-mode-switcher|Chat mode|mode==="agent"/,"Agent Mode switching must not remain in the UI");
assert.doesNotMatch(source,/agentSnapshot|agentController/,"Agent-specific UI state/controller must not remain");
assert.match(source,/startNovaLife/,"UI must be wired to Nova Life start");
assert.match(source,/stopNovaLife/,"UI must be wired to Nova Life stop");
assert.match(source,/Nova: OFF/,"UI must expose Nova OFF state");
assert.match(source,/Nova: ON/,"UI must expose Nova ON state");
assert.match(source,/appendConversationUserMessage/,"ordinary Chat composer must hand user messages to Nova Life when ON");
assert.match(source,/subscribeNovaLifeState/,"UI must observe Life Runtime state");
console.log("Nova Life UI integration: ok");
