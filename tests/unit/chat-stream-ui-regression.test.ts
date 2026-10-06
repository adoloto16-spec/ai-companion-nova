import {readFileSync} from "node:fs";
import {join} from "node:path";

function ok(value:unknown,message:string){if(!value)throw new Error(message);}
const source=readFileSync(join(process.cwd(),"apps/desktop-ui/src/main.tsx"),"utf8");

for(const label of ["Stop","Continue","Regenerate","Retry"])ok(source.includes(">"+label+"</button>"),"chat UI must expose "+label+" action");
ok(source.includes('"Send"'),"chat UI must expose Send action");
ok(source.includes("controller.stop()"),"Stop must call the controller cancellation path");
ok(source.includes("controller.continue("),"Continue must call the controller continuation path");
ok(source.includes("controller.regenerate("),"Regenerate must call the controller replacement path");
ok(source.includes("controller.retry("),"Retry must call the controller retry path");
ok(source.includes("const persistAfterAction"),"chat UI must centralize persistence after terminal actions");
ok(source.includes("await onPersist();"),"terminal streaming actions must persist conversation once");
ok(source.includes('const sending=mode==="chat"?snapshot.sending:agentSnapshot.sending;'),"chat/agent composer must derive disabled state from the active mode");
ok(source.includes("disabled={sending}"),"composer must disable while the active mode is running");
ok(!source.includes("Thinking…"),"UI must render the live assistant message instead of a fake Thinking placeholder");
ok(source.includes('snapshot.status==="streaming"'),"streaming state controls must be state-driven");
ok(source.includes('showContinue'),"interrupted state must expose Continue");
ok(source.includes('showRegenerate'),"completed/interrupted state must expose Regenerate");
ok(source.includes('showRetry'),"error state must expose Retry");
ok(source.includes('stream:(request,handlers,options,providerPresetId)=>'),"desktop controller must use FoundationRuntime.stream");

console.log("PASS chat streaming UI regression test");
