import {ChatSessionController,ConversationSession,InMemoryCharacterStore} from "../../core/src";
import type {ChatRequest,ChatResponse} from "../../contracts/src";
import {createFoundationRuntime as startRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
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
