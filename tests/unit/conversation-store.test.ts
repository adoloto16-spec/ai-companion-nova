import {InMemoryConversationStore,IpcConversationStore} from "../../host/conversations/src";
import {StandardContractValidator,STANDARD_SCHEMAS} from "../../contracts/src";
import type {Conversation} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

const nova:Conversation={
  apiVersion:"1",schemaVersion:"2",id:"conversation:character.nova.default.v1:default.v2",characterId:"character.nova.default.v1",title:"Main",
  messages:[
    {id:"u1",role:"user",content:"hello Nova"},
    {id:"a1",role:"assistant",content:"hello from Nova"}
  ],
  createdAt:"2026-09-28T10:00:00.000Z",updatedAt:"2026-09-28T10:00:01.000Z"
};

async function main(){
  const validator=new StandardContractValidator();
  equal(validator.validate(nova,STANDARD_SCHEMAS["conversation"]!).valid,true,"conversation v2 schema accepts canonical state");
  equal(validator.validate({...nova,title:""} as never,STANDARD_SCHEMAS["conversation"]!).valid,false,"conversation schema rejects empty title");
  equal(validator.validate({...nova,characterId:""} as never,STANDARD_SCHEMAS["conversation"]!).valid,false,"conversation schema rejects empty character scope");
  equal(validator.validate({...nova,schemaVersion:"1"} as never,STANDARD_SCHEMAS["conversation"]!).valid,false,"conversation v1 object is no longer accepted as v2");

  const store=new InMemoryConversationStore();
  equal((await store.list(nova.characterId)).length,0,"fresh store has no conversations");
  await store.save(nova);
  const createdB:Conversation={...nova,id:"conversation:character.nova.default.v1:b",title:"Aviation",messages:[{id:"u2",role:"user",content:"aviation"}],updatedAt:"2026-09-28T11:00:00.000Z"};
  await store.save(createdB);

  equal((await store.list(nova.characterId)).length,2,"store supports multiple conversations for one Character");
  equal((await store.get(nova.characterId,nova.id))?.title,"Main","get finds conversation by scoped id");
  equal((await store.get(nova.characterId,createdB.id))?.messages[0]?.content,"aviation","second conversation remains separate");
  equal((await store.getActive(nova.characterId))?.id,nova.id,"first saved conversation becomes active by default");
  await store.setActive(nova.characterId,createdB.id);
  equal((await store.getActive(nova.characterId))?.id,createdB.id,"active conversation can switch");
  await store.save({...createdB,title:"Aviation Stories",updatedAt:"2026-09-28T11:30:00.000Z"});
  equal((await store.get(nova.characterId,createdB.id))?.title,"Aviation Stories","update round-trips title");
  equal((await store.get(nova.characterId,createdB.id))?.messages[0]?.content,"aviation","update does not cross-contaminate messages");

  let foreignRejected=false;
  try{await store.get("character.gm.default.v1",createdB.id)}catch(error){foreignRejected=String(error).includes("scope mismatch");}
  ok(foreignRejected,"cross-character get is rejected");

  await store.delete(nova.characterId,createdB.id);
  equal((await store.list(nova.characterId)).length,1,"delete removes only selected conversation");
  equal((await store.getActive(nova.characterId))?.id,nova.id,"delete switches active to remaining conversation");

  await store.delete(nova.characterId,nova.id);
  const replacement=await store.getActive(nova.characterId);
  ok(replacement,"deleting the last conversation creates deterministic default");
  equal(replacement?.id,"conversation:character.nova.default.v1:default.v2","default conversation id is deterministic");
  equal(replacement?.title,"Main","default conversation title");
  equal(replacement?.messages.length,0,"default conversation starts empty");

  const calls:Array<{command:string;args?:Record<string,unknown>}>=[];
  const ipc=new IpcConversationStore(async(command,args)=>{calls.push({command,args});switch(command){
    case "list_conversations":return [nova];
    case "get_conversation":return nova;
    case "get_active_conversation":return nova;
    default:return null;
  }});
  await ipc.list(nova.characterId);
  await ipc.get(nova.characterId,nova.id);
  await ipc.getActive(nova.characterId);
  await ipc.setActive(nova.characterId,nova.id);
  await ipc.delete(nova.characterId,nova.id);
  await ipc.clear(nova.characterId,nova.id);
  equal(calls.map(call=>call.command).join("|"),"list_conversations|get_conversation|get_active_conversation|set_active_conversation|delete_conversation|clear_conversation","IPC conversation command mapping");

  console.log("PASS conversation store v2 unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
