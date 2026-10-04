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
  const settings={...defaultAppSettings(),memoryAgent:{...defaultAppSettings().memoryAgent,enabled:true,providerPresetId:"preset.memory",model:"memory-model",outputMode:"plain" as const,prompt:"CUSTOM MEMORY PROMPT",promptBackup:"PREVIOUS",defaultPromptVersion:"1"}};
  let calls=0;
  const runtime={async chat(req:ChatRequest){calls++;return response(req,"У пользователя любимый цвет — синий.")},async getChatModelForPreset(){return "memory-model"}};
  const agent=new AutomaticMemoryAgent({settings:()=>settings,broker,runtime,validator:new StandardContractValidator(),traceStore:traces});

  const first=await agent.process(request("conversation.a","turn-a"));
  ok(Boolean(first),"automatic agent creates durable memory");
  equal(first?.characterId,"character.a","automatic memory is character scoped");
  equal(first?.originConversationId,"conversation.a","conversation is provenance only");

  const duplicate=await agent.process(request("conversation.b","turn-b"));
  equal(duplicate?.id,first?.id,"same content is duplicate across conversations");
  equal((await broker.list("character.a")).length,1,"duplicate protection is character scoped");

  const customHttpRequests:ChatRequest[]=[];
  const customAgent=new AutomaticMemoryAgent({settings:()=>({...settings,memoryAgent:{...settings.memoryAgent,outputMode:"plain" as const,prompt:"CUSTOM MEMORY PROMPT"}}),broker,runtime:{
    async chat(req:ChatRequest){customHttpRequests.push(req);return response(req,"NO_MEMORY")},
    async getChatModelForPreset(){return "memory-model"}
  },validator:new StandardContractValidator(),traceStore:traces});
  await customAgent.process(request("conversation.custom","turn-custom"));
  equal(customHttpRequests[0]?.context.messages[0]?.content,"CUSTOM MEMORY PROMPT","custom prompt is sent verbatim");
  equal(customHttpRequests[0]?.generation?.responseFormat,undefined,"plain agent request omits response format");

  const structuredAgent=new AutomaticMemoryAgent({settings:()=>({...settings,memoryAgent:{...settings.memoryAgent,outputMode:"structured" as const,prompt:"STRUCTURED"}}),broker,runtime:{
    async chat(req:ChatRequest){return response(req,'{"decision":"remember","content":"Structured durable fact."}')},
    async getChatModelForPreset(){return "memory-model"}
  },validator:new StandardContractValidator(),traceStore:traces});
  const structuredMemory=await structuredAgent.process(request("conversation.structured","turn-structured"));
  ok(Boolean(structuredMemory),"structured remember creates memory");
  equal((await broker.list("character.a")).filter(item=>item.content==="Structured durable fact.").length,1,"structured remember persisted");

  const noMemoryAgent=new AutomaticMemoryAgent({settings:()=>({...settings,memoryAgent:{...settings.memoryAgent,outputMode:"structured" as const}}),broker,runtime:{
    async chat(req:ChatRequest){return response(req,'{"decision":"no_memory","content":""}')},
    async getChatModelForPreset(){return "memory-model"}
  },validator:new StandardContractValidator(),traceStore:traces});
  const beforeNoMemory=(await broker.list("character.a")).length;
  equal(await noMemoryAgent.process(request("conversation.nomemory","turn-nomemory")),undefined,"structured no_memory does not persist");
  equal((await broker.list("character.a")).length,beforeNoMemory,"no_memory leaves store unchanged");

  const invalidAgent=new AutomaticMemoryAgent({settings:()=>({...settings,memoryAgent:{...settings.memoryAgent,outputMode:"structured"}}),broker,runtime:{
    async chat(req:ChatRequest){return response(req,'{"decision":"remember","content":17}')},
    async getChatModelForPreset(){return "memory-model"}
  },validator:new StandardContractValidator(),traceStore:traces});
  const beforeInvalid=(await broker.list("character.a")).length;
  equal(await invalidAgent.process(request("conversation.invalid","turn-invalid")),undefined,"invalid structured schema does not persist");
  equal((await broker.list("character.a")).length,beforeInvalid,"invalid structured output leaves store unchanged");

  const autoStructuredCalls:ChatRequest[]=[];
  let autoCall=0;
  const autoAgent=new AutomaticMemoryAgent({settings:()=>({...settings,memoryAgent:{...settings.memoryAgent,outputMode:"auto" as const}}),broker,runtime:{
    async chat(req:ChatRequest){
      autoStructuredCalls.push(req);autoCall++;
      if(autoCall===1)throw Object.assign(new Error("unsupported"),{chatError:{code:"UNSUPPORTED",details:{category:"capability"}}});
      return response(req,"NO_MEMORY");
    },async getChatModelForPreset(){return "memory-model"}
  },validator:new StandardContractValidator(),traceStore:traces});
  equal(await autoAgent.process(request("conversation.auto","turn-auto")),undefined,"auto fallback plain no-memory");
  equal(autoStructuredCalls.length,2,"auto uses two calls only on capability failure");
  equal(autoStructuredCalls[0]?.generation?.responseFormat?.type,"json-schema","auto first attempt structured");
  equal(autoStructuredCalls[1]?.generation?.responseFormat,undefined,"auto fallback plain");

  const otherCharacter=await broker.list("character.b");
  equal(otherCharacter.length,0,"other character never receives memory");
  equal(calls,2,"agent was invoked once per completed turn");

  let failedCalls=0;
  const failing=new AutomaticMemoryAgent({
    settings:()=>settings,broker,runtime:{
      async chat(){failedCalls++;throw new Error("provider unavailable")},
      async getChatModelForPreset(){return "memory-model"}
    },validator:new StandardContractValidator(),traceStore:traces
  });
  const failed=await failing.process(request("conversation.c","turn-c"));
  equal(failed,undefined,"provider failure is isolated");
  equal(failedCalls,1,"failing provider called once");
  equal((await broker.list("character.a")).length,1,"provider failure does not corrupt canonical memory");
  console.log("PASS Automatic Memory Agent unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
