import {InMemoryAuditService} from "../../core/src";
import type {MemoryStoreState} from "../../contracts/src";
import {IpcMemoryStore} from "../../host/memory/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryConversationStore} from "../../host/conversations/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const persistedStates=new Map<string,MemoryStoreState>();
  const memoryInvoke=async(command:string,args?:Record<string,unknown>):Promise<unknown>=>{
    switch(command){
      case "get_memory_state":{
        const characterId=args?.characterId;
        if(typeof characterId!=="string")throw new Error("missing characterId in test IPC boundary");
        const state=persistedStates.get(characterId);
        return state?JSON.parse(JSON.stringify(state)) as MemoryStoreState:undefined;
      }
      case "save_memory_state":{
        const stateValue=args?.stateValue;
        if(!stateValue||typeof stateValue!=="object")throw new Error("missing stateValue in test IPC boundary");
        const state=JSON.parse(JSON.stringify(stateValue)) as MemoryStoreState;
        persistedStates.set(state.characterId,state);
        return undefined;
      }
      case "supersede_memory":{
        const characterId=args?.characterId;
        const conversationId=args?.conversationId;
        const previousMemoryId=args?.previousMemoryId;
        const replacement=args?.replacement;
        if(typeof characterId!=="string"||typeof conversationId!=="string"||typeof previousMemoryId!=="string"||!replacement||typeof replacement!=="object"){
          throw new Error("invalid supersede IPC test boundary");
        }
        const current=persistedStates.get(characterId);
        if(!current)throw new Error("memory state was not found");
        const index=current.items.findIndex(item=>item.id===previousMemoryId);
        if(index<0)throw new Error("memory item was not found");
        const next=JSON.parse(JSON.stringify(current)) as MemoryStoreState;
        const superseded=next.items[index]!;
        superseded.status="superseded";
        superseded.updatedAt=(replacement as {updatedAt:string}).updatedAt;
        next.items=[...next.items,JSON.parse(JSON.stringify(replacement))];
        persistedStates.set(characterId,next);
        return JSON.parse(JSON.stringify(replacement));
      }
      default:
        throw new Error("Unexpected memory IPC command: "+command);
    }
  };
  const memoryStore=new IpcMemoryStore(memoryInvoke);
  const conversationStore=new InMemoryConversationStore();
  const runtime=await createFoundationRuntime({characterStore,memoryStore,conversationStore});
  await runtime.start();
  try{
    const nova=await runtime.getActiveCharacter();
    const novaConversation=await runtime.getActiveConversation(nova.id);
    const gm=await runtime.createCharacter({name:"GM"});
    const gmConversation=await runtime.getActiveConversation(gm.id);
    const created=await runtime.createMemory(nova.id,{
      id:"runtime.memory.1",conversationId:novaConversation.id,type:"experience",content:"Nova met the user at the lake.",tags:["lake","meeting"],
      importance:80,confidence:70,source:"conversation",sourceReference:"conversation/message-42",mutationPolicy:"locked"
    });
    const gmMemory=await runtime.createMemory(gm.id,{id:"runtime.memory.2",conversationId:gmConversation.id,type:"goal",content:"GM tracks separate goals.",source:"user",mutationPolicy:"suggest"});
    equal((await runtime.searchMemory({characterId:nova.id,conversationId:novaConversation.id,query:"lake"}))[0]?.id,created.id,"runtime search returns scoped memory");
    equal(await runtime.getMemory(gm.id,gmConversation.id,created.id),undefined,"runtime enforces character scope");
    await runtime.updateMemory(gm.id,gmConversation.id,gmMemory.id,{content:"GM tracks a separate goal."});
    const replacement=await runtime.supersedeMemory(nova.id,novaConversation.id,created.id,{
      id:"runtime.memory.3",conversationId:novaConversation.id,type:"experience",content:"Nova met the user in Munich.",tags:["meeting","munich"],
      importance:85,confidence:90,source:"user",mutationPolicy:"locked"
    });
    equal(replacement.status,"active","runtime supersede returns active replacement");
    equal((await runtime.getMemory(nova.id,novaConversation.id,created.id))?.status,"superseded","runtime retains historical memory");
    const reloaded=await createFoundationRuntime({characterStore,memoryStore:new IpcMemoryStore(memoryInvoke),conversationStore});
    await reloaded.start();
    try{
      equal((await reloaded.getMemory(nova.id,novaConversation.id,replacement.id))?.content,"Nova met the user in Munich.","memory survives runtime restart");
      equal((await reloaded.searchMemory({characterId:gm.id,conversationId:gmConversation.id,query:"goal"})).length,1,"other character memory survives restart");
    }finally{await reloaded.stop()}
  }finally{await runtime.stop()}
  ok(new InMemoryAuditService(),"audit architecture remains reusable");
  console.log("PASS Dynamic Memory runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
