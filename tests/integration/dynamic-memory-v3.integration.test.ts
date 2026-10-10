import {ChatSessionController,ConversationSession} from "../../core/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryConversationStore} from "../../host/conversations/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import type {ChatRequest,ChatResponse} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}
function response(request:ChatRequest):ChatResponse{
  return {apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.chat",model:request.model,message:{id:request.requestId,role:"assistant",content:"answer"},finishReason:"stop"};
}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const conversationStore=new InMemoryConversationStore();
  const memoryStore=new InMemoryMemoryStore();
  const runtime=await createFoundationRuntime({
    characterStore,conversationStore,memoryStore,
    retriever:{async search(){throw new Error("generic retrieval unavailable")},async rebuild(){throw new Error("generic retrieval unavailable")},async rebuildAll(){throw new Error("generic retrieval unavailable")}}
  });
  await runtime.start();
  const character=await runtime.getActiveCharacter();
  const startedCharacter=character;
  await runtime.setActiveCharacter(character.id);
  const conversationA=await runtime.createConversation(character.id,{id:"conversation.a",title:"A"});
  const conversationB=await runtime.createConversation(character.id,{id:"conversation.b",title:"B"});
  const memory=await runtime.createMemory(character.id,{id:"memory.favorite-color",originConversationId:conversationA.id,type:"preference",content:"У пользователя любимый цвет — синий.",tags:["цвет","синий"],importance:95,confidence:95,source:"conversation",sourceReference:"turn-a",mutationPolicy:"locked"});
  equal((await runtime.searchMemory({characterId:character.id,query:"какой любимый цвет"}))[0]?.id,memory.id,"memory broker search is character scoped");
  equal((await runtime.listMemory(character.id)).length,1,"canonical memory list contains one item");

  await runtime.clearConversation(character.id,conversationA.id);
  equal((await runtime.searchMemory({characterId:character.id,query:"цвет"}))[0]?.id,memory.id,"clear conversation preserves memory");
  await runtime.deleteConversation(character.id,conversationA.id);
  equal((await runtime.searchMemory({characterId:character.id,query:"синий"}))[0]?.id,memory.id,"deleted origin conversation does not delete memory");

  const other=await runtime.createCharacter({name:"Other"});
  equal((await runtime.searchMemory({characterId:other.id,query:"синий"})).length,0,"character isolation blocks memory leakage");

  const session=new ConversationSession(conversationB.id,character.id);
  let captured:ChatRequest|undefined;
  const controller=new ChatSessionController(session,{
    async chat(request:ChatRequest){captured=request;return response(request)}
  },{
    requestIdFactory:()=> "v3-final-request",
    contextBuilder:{buildContext:request=>runtime.buildContext(request)},
    contextBudget:{availableContextTokens:800,reservedOutputTokens:100,systemOverheadTokens:0,safetyMarginTokens:0}
  });
  const result=await controller.submit("Какой мой любимый цвет?","fake-chat");
  equal(result.status,"sent","chat turn succeeds with long-term memory");
  ok(Boolean(captured),"provider received a final ChatRequest");
  const serialized=JSON.stringify(captured?.context.messages??[]);
  ok(serialized.includes("У пользователя любимый цвет — синий."),"memory text is present in final ChatRequest");
  ok(serialized.includes("[Relevant long-term memory]"),"memory is explicitly marked as context");
  ok(!serialized.includes('"role":"user","content":"[Relevant long-term memory]'),"memory is not injected as a fresh user command");

  await runtime.stop();
  const reloaded=await createFoundationRuntime({characterStore,conversationStore,memoryStore});
  await reloaded.start();
  equal((await reloaded.listMemory(character.id)).length,1,"memory survives runtime reload");
  equal((await reloaded.searchMemory({characterId:character.id,query:"цвет"}))[0]?.id,memory.id,"reloaded memory is retrievable");
  console.log("PASS Dynamic Memory v3 integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
