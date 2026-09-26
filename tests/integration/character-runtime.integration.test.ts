import {ChatSessionController,ConversationSession,InMemoryCharacterStore} from "../../core/src";
import type {ChatRequest,ChatResponse} from "../../contracts/src";
import {createFoundationRuntime as startRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function providerConfigurationFailureFallbackTest(){
  const loaded=await loadProviderConfigurationSafely({
    load:async()=>{throw new Error("invalid provider configuration: credentialReference.version must be string")},
    save:async()=>{},
    clear:async()=>{}
  });
  equal(loaded.configuration,undefined,"provider config failure produces no real runtime configuration");
  ok(loaded.error,"provider config failure is retained for diagnostics");

  const runtime=await startFoundationRuntime({
    providerConfiguration:loaded.configuration,
    characterStore:new InMemoryCharacterStore()
  });
  try{
    const nova=await runtime.getActiveCharacter();
    equal(nova.name,"Nova","Character initializes after provider config failure");
    equal((await runtime.listCharacters()).some(character=>character.id===nova.id),true,"active Character is present in list");
    const entry=await runtime.createCoreBookEntry(nova.id,{
      title:"Fallback-accessible entry",
      content:"Core Book remains accessible.",
      activation:{kind:"always"},
      source:"user"
    });
    equal(entry.title,"Fallback-accessible entry","Core Book remains writable on fallback runtime");
    equal((await runtime.listCoreBookEntries(nova.id)).length,1,"Core Book remains readable on fallback runtime");

    const response=await runtime.chat({
      apiVersion:"1",
      schemaVersion:"1",
      requestId:"provider-config-fallback",
      model:"fake-chat",
      context:{conversationId:"provider-config-fallback",messages:[{role:"user",content:"hello"}]}
    });
    equal(response.providerId,"fake.chat","Fake provider remains available when no real provider configuration is valid");
  }finally{await runtime.stop()}
}

async function main(){
  await providerConfigurationFailureFallbackTest();

  const characterStore=new InMemoryCharacterStore();
  const runtime=await startRuntime({characterStore});
  await runtime.start();
  try{
    const nova=await runtime.getActiveCharacter();
    equal(nova.name,"Nova","runtime starts with deterministic Nova");
    const gm=await runtime.createCharacter({name:"GM"});
    await runtime.setActiveCharacter(gm.id);
    equal((await runtime.getActiveCharacter()).id,gm.id,"runtime switches active character");

    const novaSession=new ConversationSession("conversation-nova",nova.id);
    const gmSession=new ConversationSession("conversation-gm",gm.id);
    const makeResponse=(request:ChatRequest):ChatResponse=>({
      apiVersion:request.apiVersion,schemaVersion:request.schemaVersion,requestId:request.requestId,
      conversationId:request.context.conversationId,providerId:"fake.chat",model:request.model,
      message:{id:request.requestId+":assistant",role:"assistant",content:"fake response"},finishReason:"stop"
    });
    const novaController=new ChatSessionController(novaSession,{chat:async request=>makeResponse(request)},{requestIdFactory:()=> "nova-request"});
    const gmController=new ChatSessionController(gmSession,{chat:async request=>makeResponse(request)},{requestIdFactory:()=> "gm-request"});

    equal(novaController.getSnapshot().characterId,nova.id,"Nova session scoped to Nova");
    equal(gmController.getSnapshot().characterId,gm.id,"GM session scoped to GM");

    await novaController.submit("hello Nova","fake-chat");
    await gmController.submit("hello GM","fake-chat");
    equal(novaSession.getMessages()[0]?.content,"hello Nova","Nova history isolated");
    equal(gmSession.getMessages()[0]?.content,"hello GM","GM history isolated");
    equal(novaSession.getMessages().length,2,"Nova session only has its turn");
    equal(gmSession.getMessages().length,2,"GM session only has its turn");

    const reloaded=await startRuntime({characterStore});
    await reloaded.start();
    try{
      equal((await reloaded.getActiveCharacter()).id,gm.id,"active character survives runtime restart");
      equal((await reloaded.listCharacters()).length,2,"character list survives runtime restart");
    }finally{await reloaded.stop()}

    ok(nova.id!==gm.id,"character ids remain distinct");
  }finally{await runtime.stop()}
  console.log("PASS Character runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
