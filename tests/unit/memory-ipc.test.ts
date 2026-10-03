import {IpcMemoryStore} from "../../host/memory/src";
import type {MemoryItem,MemoryStoreState} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const now="2026-10-03T00:00:00.000Z";
  const item:MemoryItem={
    id:"memory.ipc.1",
    characterId:"character.a",
    conversationId:"conversation.a",
    type:"preference",
    content:"User prefers green.",
    tags:[],
    importance:70,
    confidence:80,
    createdAt:now,
    updatedAt:now,
    validFrom:null,
    validUntil:null,
    source:"conversation",
    sourceReference:"turn-1",
    mutationPolicy:"auto",
    status:"active",
    metadata:{origin:"test"}
  };
  let state:MemoryStoreState|undefined={apiVersion:"1",schemaVersion:"2",characterId:"character.a",items:[item]};
  const calls:string[]=[];
  const store=new IpcMemoryStore(async(command,args)=>{
    calls.push(command);
    switch(command){
      case "get_memory_state":return args?.characterId==="character.a"?state:undefined;
      case "save_memory_state":state=args?.state as MemoryStoreState;return undefined;
      case "supersede_memory":return args?.replacement;
      default:throw new Error("Unexpected memory command: "+command);
    }
  });

  const loaded=await store.load("character.a");
  ok(Boolean(loaded),"IpcMemoryStore loads through the existing get_memory_state command");
  equal(loaded?.items[0]?.tags,[],"IPC memory item permits empty tags");
  await store.save({...loaded!,items:[item]});
  const superseding={...item,id:"memory.ipc.2",content:"User prefers green aviation examples."};
  const replaced=await store.supersede("character.a","conversation.a",item.id,superseding);
  equal(replaced.id,"memory.ipc.2","IpcMemoryStore routes supersede to the existing command");
  equal(calls,["get_memory_state","save_memory_state","supersede_memory"],"IpcMemoryStore uses only existing memory IPC boundaries");
  console.log("PASS Memory IPC boundary tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
