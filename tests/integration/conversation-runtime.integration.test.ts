import type {Conversation,RetrievalQuery,RetrievalResult,Retriever} from "../../contracts/src";
import {ChatSessionController,ConversationSession} from "../../core/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryConversationStore} from "../../host/conversations/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

const createdAt="2026-09-28T10:00:00.000Z";
function persistable(controller:ChatSessionController,createdAt:string):Conversation{
  const snapshot=controller.getSnapshot();
  return {
    apiVersion:"1",schemaVersion:"1",id:snapshot.conversationId,characterId:snapshot.characterId,
    messages:snapshot.messages,createdAt,updatedAt:"2026-09-28T10:00:01.000Z"
  };
}
async function controllerFor(runtime:Awaited<ReturnType<typeof createFoundationRuntime>>,store:InMemoryConversationStore,characterId:string,createdAtValue=createdAt){
  const stored=await store.load(characterId);
  const session=new ConversationSession(stored?.id??"conversation:"+characterId+":default.v1",characterId);
  for(const message of stored?.messages??[])session.addMessage(message);
  const controller=new ChatSessionController(session,{
    chat:request=>runtime.chat(request)
  },{
    requestIdFactory:(()=>{let n=0;return ()=> "conversation-request-"+(++n)})(),
    contextBuilder:{buildContext:request=>runtime.buildContext(request)}
  });
  return {controller,createdAt:stored?.createdAt??createdAtValue};
}
async function sendAndPersist(runtime:Awaited<ReturnType<typeof createFoundationRuntime>>,store:InMemoryConversationStore,controller:ChatSessionController,recordCreatedAt:string,content:string){
  const result=await controller.submit(content,runtime.getActiveChatModel());
  equal(result.status,"sent","chat response succeeds");
  await store.save(persistable(controller,recordCreatedAt));
}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const store=new InMemoryConversationStore();

  const runtime=await createFoundationRuntime({characterStore});
  await runtime.start();
  try{
    const nova=await runtime.getActiveCharacter();
    const fresh=await controllerFor(runtime,store,nova.id);
    equal(fresh.controller.getSnapshot().messages.length,0,"fresh runtime has empty ConversationSession");
    equal(fresh.controller.getSnapshot().characterId,nova.id,"fresh conversation is scoped to active Character");
    await sendAndPersist(runtime,store,fresh.controller,fresh.createdAt,"hello Nova");
    equal((await store.load(nova.id))?.messages.length,2,"successful user+assistant turn is persisted");

    const gm=await runtime.createCharacter({name:"GM"});
    await runtime.setActiveCharacter(gm.id);
    const gmController=await controllerFor(runtime,store,gm.id);
    equal(gmController.controller.getSnapshot().messages.length,0,"new Character starts with empty conversation");
    await sendAndPersist(runtime,store,gmController.controller,gmController.createdAt,"hello GM");

    await runtime.setActiveCharacter(nova.id);
    const novaAgain=await controllerFor(runtime,store,nova.id);
    equal(novaAgain.controller.getSnapshot().messages.map(message=>message.content).join("|"),"hello Nova|fake response","Nova history survives Character switch");
    ok(!novaAgain.controller.getSnapshot().messages.some(message=>message.content==="hello GM"),"GM message never enters Nova conversation");
  }finally{await runtime.stop()}

  const restarted=await createFoundationRuntime({characterStore});
  await restarted.start();
  try{
    const nova=await restarted.getActiveCharacter();
    const restoredNova=await controllerFor(restarted,store,nova.id);
    equal(restoredNova.controller.getSnapshot().messages.map(message=>message.content).join("|"),"hello Nova|fake response","Nova history survives runtime restart");
    await restarted.setActiveCharacter((await restarted.listCharacters()).find(character=>character.name==="GM")!.id);
    const restoredGm=await controllerFor(restarted,store,(await restarted.getActiveCharacter()).id);
    equal(restoredGm.controller.getSnapshot().messages.map(message=>message.content).join("|"),"hello GM|fake response","GM history survives runtime restart");
  }finally{await restarted.stop()}

  const clearedRuntime=await createFoundationRuntime({characterStore});
  await clearedRuntime.start();
  try{
    const nova=await clearedRuntime.getActiveCharacter();
    const restored=await controllerFor(clearedRuntime,store,nova.id);
    await store.clear(nova.id);
    restored.controller.clear();
    equal((await controllerFor(clearedRuntime,store,nova.id)).controller.getSnapshot().messages.length,0,"clear removes persistent conversation");
  }finally{await clearedRuntime.stop()}

  const clearedRestart=await createFoundationRuntime({characterStore});
  await clearedRestart.start();
  try{
    const nova=await clearedRestart.getActiveCharacter();
    const afterClear=await controllerFor(clearedRestart,store,nova.id);
    equal(afterClear.controller.getSnapshot().messages.length,0,"cleared conversation remains empty after restart");
  }finally{await clearedRestart.stop()}

  const providerFallbackStore=new InMemoryConversationStore();
  const providerFallback=await createFoundationRuntime({characterStore:new InMemoryCharacterStore()});
  await providerFallback.start();
  try{
    const nova=await providerFallback.getActiveCharacter();
    const fallback=await controllerFor(providerFallback,providerFallbackStore,nova.id);
    await sendAndPersist(providerFallback,providerFallbackStore,fallback.controller,fallback.createdAt,"fallback conversation");
    equal((await providerFallbackStore.load(nova.id))?.messages.length,2,"Conversation remains valid with Fake provider fallback");
  }finally{await providerFallback.stop()}

  const failing:Retriever={
    search:async(query:RetrievalQuery):Promise<RetrievalResult>=>({apiVersion:"1",schemaVersion:"1",characterId:query.characterId,query:query.query,candidates:[],degraded:true,error:"unavailable"}),
    rebuild:async()=>{throw new Error("index unavailable")},
    rebuildAll:async()=>{throw new Error("index unavailable")}
  };
  const degradedStore=new InMemoryConversationStore();
  const degradedRuntime=await createFoundationRuntime({
    characterStore:new InMemoryCharacterStore(),
    retriever:failing
  });
  await degradedRuntime.start();
  try{
    equal((await degradedRuntime.diagnostics()).runtimeStatus,"degraded","retrieval degradation remains isolated from runtime startup");
    const nova=await degradedRuntime.getActiveCharacter();
    const degraded=await controllerFor(degradedRuntime,degradedStore,nova.id);
    await sendAndPersist(degradedRuntime,degradedStore,degraded.controller,degraded.createdAt,"degraded retrieval conversation");
    equal((await degradedStore.load(nova.id))?.messages.length,2,"Conversation persists while retrieval is degraded");
  }finally{await degradedRuntime.stop()}

  console.log("PASS conversation persistence/runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
