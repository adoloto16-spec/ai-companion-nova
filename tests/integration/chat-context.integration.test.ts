import {ChatSessionController,ConversationSession} from "../../core/src";
import type {ChatRequest} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const memoryStore=new InMemoryMemoryStore();
  const runtime=await createFoundationRuntime({characterStore,memoryStore});
  await runtime.start();
  try{
    const character=await runtime.getActiveCharacter();
    await runtime.createMemory(character.id,{
      id:"memory.chat.1",
      type:"preference",
      content:"Nova likes jasmine tea.",
      tags:["tea"],
      importance:95,
      confidence:90,
      source:"user",
      mutationPolicy:"locked"
    });

    let captured:ChatRequest|undefined;
    const session=new ConversationSession("chat-context-e2e",character.id);
    const controller=new ChatSessionController(session,{
      async chat(request:ChatRequest){
        captured=request;
        return runtime.chat(request);
      }
    },{
      requestIdFactory:()=> "chat-context-1",
      contextBuilder:{buildContext:request=>runtime.buildContext(request)},
      contextBudget:{availableContextTokens:100,reservedOutputTokens:20,systemOverheadTokens:5,safetyMarginTokens:5}
    });

    const first=await controller.submit("What tea do you like?","fake-chat");
    equal(first.status,"sent","chat with matching memory succeeds");
    ok(captured,"ChatRequest captured");
    const firstCaptured=captured;
    equal(firstCaptured.context.messages.find(message=>message.content==="Nova likes jasmine tea.")?.metadata?.contextSource,"memory","ChatRequest receives memory context");
    equal(firstCaptured.context.messages.find(message=>message.content==="Nova likes jasmine tea.")?.metadata?.contextReferenceId,"memory.chat.1","ChatRequest preserves memory reference");
    equal(firstCaptured.context.messages.find(message=>message.content==="Nova likes jasmine tea.")?.role,"user","memory remains data-role");

    const second=await controller.submit("A completely unrelated topic.","fake-chat");
    equal(second.status,"sent","chat without matching memory still succeeds");
    ok(captured,"second ChatRequest captured");
    const secondCaptured=captured;
    equal(secondCaptured.context.messages.filter(message=>message.metadata?.contextSource==="memory").length,0,"no-match chat does not inject unrelated memory");
  }finally{
    await runtime.stop();
  }
  console.log("PASS Dynamic Memory chat context integration test");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
