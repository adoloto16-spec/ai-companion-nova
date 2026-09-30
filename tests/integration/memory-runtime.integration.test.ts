import {InMemoryAuditService} from "../../core/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryConversationStore} from "../../host/conversations/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const memoryStore=new InMemoryMemoryStore();
  const conversationStore=new InMemoryConversationStore();
  const runtime=await createFoundationRuntime({characterStore,memoryStore,conversationStore});
  await runtime.start();
  try{
    const nova=await runtime.getActiveCharacter();
    const gm=await runtime.createCharacter({name:"GM"});
    const novaConversation=await runtime.getActiveConversation(nova.id);
    const gmConversation=await runtime.getActiveConversation(gm.id);
    const created=await runtime.createMemory(nova.id,novaConversation.id,{
      id:"runtime.memory.1",type:"experience",content:"Nova met the user at the lake.",tags:["lake","meeting"],
      importance:80,confidence:70,source:"conversation",sourceReference:"conversation/message-42",mutationPolicy:"locked"
    });
    const gmMemory=await runtime.createMemory(gm.id,gmConversation.id,{id:"runtime.memory.2",type:"goal",content:"GM tracks separate goals.",source:"user",mutationPolicy:"suggest"});
    equal((await runtime.searchMemory({characterId:nova.id,conversationId:novaConversation.id,query:"lake"}))[0]?.id,created.id,"runtime search returns scoped memory");
    equal(await runtime.getMemory(gm.id,gmConversation.id,created.id),undefined,"runtime enforces character scope");
    await runtime.updateMemory(gm.id,gmConversation.id,gmMemory.id,{content:"GM tracks a separate goal."});
    const replacement=await runtime.supersedeMemory(nova.id,novaConversation.id,created.id,{
      id:"runtime.memory.3",type:"experience",content:"Nova met the user in Munich.",tags:["meeting","munich"],
      importance:85,confidence:90,source:"user",mutationPolicy:"locked"
    });
    equal(replacement.status,"active","runtime supersede returns active replacement");
    const otherConversation=await runtime.createConversation(nova.id,{title:"Other"});
    const otherMemory=await runtime.createMemory(nova.id,otherConversation.id,{id:"runtime.memory.other",type:"fact",content:"Only in other conversation.",source:"user"});
    equal((await runtime.searchMemory({characterId:nova.id,conversationId:novaConversation.id,query:"Only"})).length,0,"memory from another conversation is isolated");
    equal((await runtime.searchMemory({characterId:nova.id,conversationId:otherConversation.id,query:"Only"}))[0]?.id,otherMemory.id,"other conversation memory is visible only in its own scope");
    equal((await runtime.getMemory(nova.id,novaConversation.id,created.id))?.status,"superseded","runtime retains historical memory");
    const reloaded=await createFoundationRuntime({characterStore,memoryStore,conversationStore});
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
