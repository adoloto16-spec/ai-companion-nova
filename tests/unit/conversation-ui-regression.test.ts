import {readFileSync} from "node:fs";
import {join} from "node:path";

function ok(value:unknown,message:string){if(!value)throw new Error(message)}
const source=readFileSync(join(process.cwd(),"apps/desktop-ui/src/main.tsx"),"utf8");

for(const label of ["New Conversation","Rename","Delete"])ok(source.includes(">"+label+"</button>"),"UI must expose "+label);
ok(source.includes("onSelectConversation"),"UI must expose conversation switching callback");
ok(source.includes("conversations={conversations}"),"ChatView must receive conversation list");
ok(source.includes("activeConversation={activeConversation}"),"ChatView must receive active conversation");
ok(source.includes("onClick={()=>void onCreate()} disabled={sending}"),"New Conversation is disabled while streaming");
ok(source.includes("onClick={()=>void onSelect(conversation.id)"),"conversation switching uses selected stable id");
ok(source.includes("foundation.createConversation("),"New Conversation uses FoundationRuntime lifecycle");
ok(source.includes("foundation.setActiveConversation("),"conversation switching uses FoundationRuntime lifecycle");
ok(source.includes("foundation.updateConversation("),"conversation rename/update uses FoundationRuntime lifecycle");
ok(source.includes("foundation.deleteConversation("),"conversation delete uses FoundationRuntime lifecycle");
ok(source.includes("foundation.getActiveConversation("),"active conversation restoration uses FoundationRuntime lifecycle");
ok(source.includes("conversationStore"),"UI still injects existing persistent conversation store into FoundationRuntime");
console.log("PASS Conversation Management v2 UI regression checks");
