import {AutomaticMemoryAgent} from "../../core/src";
import {InMemoryAuditService,InMemoryEventBus,InMemoryChatTraceStore,MemoryBrokerImpl} from "../../core/src";
import {defaultAppSettings} from "../../contracts/src/settings";
import {StandardContractValidator} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import type {AutomaticMemoryAgentRequest,ChatRequest,ChatResponse} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

function response(request:ChatRequest,content:string):ChatResponse{
  return {apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"memory.provider",model:request.model,message:{id:request.requestId,role:"assistant",content},finishReason:"stop"};
}
function request(conversationId:string,turnId:string):AutomaticMemoryAgentRequest{
  return {apiVersion:"1",schemaVersion:"1",characterId:"character.a",conversationId,turnId,model:"memory-model",
    userMessage:{role:"user",content:"У меня любимый цвет — синий."},
    assistantMessage:{role:"assistant",content:"Запомню."},contextMessages:[]};
}

async function main(){
  const store=new InMemoryMemoryStore();
  const broker=new MemoryBrokerImpl({store,validator:new StandardContractValidator(),audit:new InMemoryAuditService(),events:new InMemoryEventBus()});
  const traces=new InMemoryChatTraceStore();
  const settings={...defaultAppSettings(),memoryAgent:{...defaultAppSettings().memoryAgent,enabled:true,providerPresetId:"preset.memory",model:"memory-model"}};
  let calls=0;
  const runtime={async chat(req:ChatRequest){calls++;return response(req,"У пользователя любимый цвет — синий.")},async getChatModelForPreset(){return "memory-model"}};
  const agent=new AutomaticMemoryAgent({settings:()=>settings,broker,runtime,traceStore:traces});

  const first=await agent.process(request("conversation.a","turn-a"));
  ok(Boolean(first),"automatic agent creates durable memory");
  equal(first?.characterId,"character.a","automatic memory is character scoped");
  equal(first?.originConversationId,"conversation.a","conversation is provenance only");

  const duplicate=await agent.process(request("conversation.b","turn-b"));
  equal(duplicate?.id,first?.id,"same content is duplicate across conversations");
  equal((await broker.list("character.a")).length,1,"duplicate protection is character scoped");

  const otherCharacter=await broker.list("character.b");
  equal(otherCharacter.length,0,"other character never receives memory");
  equal(calls,2,"agent was invoked once per completed turn");

  let failedCalls=0;
  const failing=new AutomaticMemoryAgent({
    settings:()=>settings,broker,runtime:{
      async chat(){failedCalls++;throw new Error("provider unavailable")},
      async getChatModelForPreset(){return "memory-model"}
    },traceStore:traces
  });
  const failed=await failing.process(request("conversation.c","turn-c"));
  equal(failed,undefined,"provider failure is isolated");
  equal(failedCalls,1,"failing provider called once");
  equal((await broker.list("character.a")).length,1,"provider failure does not corrupt canonical memory");
  console.log("PASS Automatic Memory Agent unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
