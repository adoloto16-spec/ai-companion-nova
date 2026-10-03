import {
  InMemoryAuditService,
  InMemoryChatTraceStore,
  InMemoryDiagnosticsStore,
  InMemoryEventBus,
  MemoryBrokerImpl,
  MemoryExtractionService
} from "../../core/src";
import {StandardContractValidator} from "../../contracts/src";
import type {ChatRequest,ChatResponse,MemoryExtractionRequest} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

const requestBase:MemoryExtractionRequest={
  apiVersion:"1",
  schemaVersion:"1",
  characterId:"character.a",
  conversationId:"conversation.a",
  turnId:"turn-1",
  model:"fake-memory-extractor",
  providerId:"fake.chat",
  userMessage:{id:"u1",role:"user",content:"I prefer aviation examples and I moved to Nuremberg."},
  assistantMessage:{id:"a1",role:"assistant",content:"Understood."},
  contextMessages:[
    {id:"c1",role:"user",content:"The table is green."},
    {id:"c2",role:"assistant",content:"I will keep that in mind."}
  ]
};

function response(request:ChatRequest,content:string):ChatResponse{
  return {
    apiVersion:"1",
    schemaVersion:"1",
    requestId:request.requestId,
    conversationId:request.context.conversationId,
    providerId:request.providerId??"fake.chat",
    model:request.model,
    message:{id:request.requestId+":assistant",role:"assistant",content},
    finishReason:"stop"
  };
}

async function newService(
  result:string|Error,
  options:{traceStore?:InMemoryChatTraceStore;diagnostics?:InMemoryDiagnosticsStore}={}
){
  const broker=new MemoryBrokerImpl({
    store:new InMemoryMemoryStore(),
    validator:new StandardContractValidator(),
    audit:new InMemoryAuditService(),
    events:new InMemoryEventBus(),
    characterExists:async id=>id==="character.a",
    conversationExists:async (characterId,conversationId)=>characterId==="character.a"&&conversationId==="conversation.a"
  });
  const traceStore=options.traceStore??new InMemoryChatTraceStore();
  const diagnostics=options.diagnostics??new InMemoryDiagnosticsStore();
  const calls:{requests:ChatRequest[];presetIds:(string|undefined)[]}={requests:[],presetIds:[]};
  const runtime={
    capabilities:()=>({structuredOutput:false}),
    async chat(request:ChatRequest,providerPresetId?:string):Promise<ChatResponse>{
      calls.requests.push(request);
      calls.presetIds.push(providerPresetId);
      if(result instanceof Error)throw result;
      return response(request,result);
    }
  };
  return {
    service:new MemoryExtractionService(runtime,broker,{validator:new StandardContractValidator(),traceStore,diagnostics}),
    broker,
    traceStore,
    diagnostics,
    calls
  };
}

function startCompletedMainTrace(traceStore:InMemoryChatTraceStore):void{
  traceStore.start({
    turnId:requestBase.turnId,
    requestId:requestBase.turnId,
    characterId:requestBase.characterId,
    conversationId:requestBase.conversationId,
    timestamp:"2026-10-03T00:00:00.000Z"
  });
  traceStore.update(requestBase.turnId,{status:"completed"});
}

async function main(){
  {
    const result=JSON.stringify({memories:[
      {type:"fact",content:"The table is green.",tags:["table","color"],importance:90,confidence:95,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]});
    const {service,broker,traceStore,calls}=await newService(result);
    const created=await service.process(requestBase);
    equal(created.length,1,"plain JSON creates one memory");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"table",status:"active",limit:10})).length,1,"plain JSON memory is persisted");
    equal(calls.requests[0]?.generation,undefined,"memory extraction request does not require structured output");
    const trace=traceStore.recent(1)[0];
    equal(trace?.memoryExtraction?.candidates.length,1,"trace contains extracted candidate");
    equal(trace?.memoryExtraction?.accepted.length,1,"trace contains accepted candidate");
    equal(trace?.memoryExtraction?.created.length,1,"trace contains created memory");
    equal(trace?.memoryExtraction?.status,"completed","successful extraction trace is completed");
    equal(trace?.memoryExtraction?.providerId,"fake.chat","trace records provider");
    equal(trace?.memoryExtraction?.model,requestBase.model,"trace records model");
    equal(trace?.memoryExtraction?.requestId,"memory-extraction:"+requestBase.turnId,"trace records extraction request id");
    equal(trace?.memoryExtraction?.conversationId,requestBase.conversationId,"trace records conversation");
    equal(trace?.memoryExtraction?.contextMessageCount,requestBase.contextMessages.length,"trace records context message count");
  }

  {
    const result=JSON.stringify({memories:[
      {type:"preference",content:"User prefers aviation examples.",tags:["aviation"],importance:80,confidence:95,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]});
    const {service,broker}=await newService("```json\n"+result+"\n```");
    equal((await service.process(requestBase)).length,1,"markdown fenced JSON creates a memory");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"aviation",status:"active",limit:10})).length,1,"fenced JSON is validated and persisted");
  }

  {
    const result=JSON.stringify({memories:[
      {type:"fact",content:"The table is green.",tags:["table","color"],importance:90,confidence:95,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]});
    const {service,broker}=await newService("Here is the JSON result:\n"+result+"\nEnd.");
    equal((await service.process(requestBase)).length,1,"JSON object embedded in ordinary text is extracted conservatively");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"table",status:"active",limit:10})).length,1,"embedded JSON is schema validated and persisted");
  }

  {
    const traceStore=new InMemoryChatTraceStore();
    startCompletedMainTrace(traceStore);
    const {service,broker,diagnostics}=await newService("I think you should remember that the table is green.",{traceStore});
    equal((await service.process(requestBase)).length,0,"malformed provider response creates no memory");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"malformed JSON is not persisted");
    const trace=traceStore.recent(1)[0];
    equal(trace?.status,"completed","main chat trace remains completed after extraction parse failure");
    equal(trace?.memoryExtraction?.status,"failed","malformed extraction is marked failed independently");
    equal(trace?.memoryExtraction?.failed,"Malformed provider JSON.","malformed extraction records the expected reason");
    equal(diagnostics.recentErrors(1)[0]?.code,"MALFORMED_RESULT","malformed extraction is recorded in diagnostics");
    equal(diagnostics.recentErrors(1)[0]?.metadata?.requestId,"memory-extraction:"+requestBase.turnId,"diagnostics record extraction request id");
  }

  {
    const schemaInvalid=JSON.stringify({memories:[{content:"table is green"}]});
    const {service,broker,traceStore,diagnostics}=await newService(schemaInvalid);
    equal((await service.process(requestBase)).length,0,"schema-invalid JSON creates no memory");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"schema-invalid result is not persisted");
    const trace=traceStore.recent(1)[0];
    equal(trace?.memoryExtraction?.failed,"Provider result failed extraction schema validation.","schema validation failure is recorded");
    equal(diagnostics.recentErrors(1)[0]?.code,"SCHEMA_VALIDATION_FAILED","schema validation failure is diagnostic");
  }

  {
    const result=JSON.stringify({memories:[
      {type:"fact",content:"The table is green.",tags:["table","color"],importance:90,confidence:95,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]});
    const {service,calls}=await newService(result);
    equal((await service.process(requestBase)).length,1,"provider without structured output still creates memory");
    equal((calls.requests[0] as ChatRequest).generation,undefined,"structuredOutput=false fallback uses ordinary text request");
  }

  {
    const result=JSON.stringify({memories:[]});
    const {service,calls}=await newService(result);
    const requestWithPreset={...requestBase,providerPresetId:"preset.mistral"};
    await service.process(requestWithPreset);
    equal(calls.presetIds[0],"preset.mistral","memory extraction keeps the active provider preset");
    equal(calls.requests[0]?.providerId,requestBase.providerId,"memory extraction keeps the provider id from the completed turn");
  }

  {
    const traceStore=new InMemoryChatTraceStore();
    startCompletedMainTrace(traceStore);
    const diagnostics=new InMemoryDiagnosticsStore();
    const {service,broker}=await newService(new Error("provider offline"),{traceStore,diagnostics});
    equal((await service.process(requestBase)).length,0,"provider failure creates no memory");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"provider failure is not persisted");
    const trace=traceStore.recent(1)[0];
    equal(trace?.status,"completed","provider extraction failure does not fail the main chat trace");
    equal(trace?.memoryExtraction?.status,"failed","provider extraction failure is isolated in memory trace");
    equal(trace?.memoryExtraction?.failed,"Provider call failed.","provider failure has a precise reason");
    equal(diagnostics.recentErrors(1)[0]?.code,"PROVIDER_FAILURE","provider failure is diagnostic");
    equal(diagnostics.recentErrors(1)[0]?.metadata?.providerId,requestBase.providerId,"provider diagnostic includes provider");
  }

  {
    const {service}=await newService(JSON.stringify({memories:[
      {type:"fact",content:"Cross conversation memory.",tags:["scope"],importance:80,confidence:80,source:"conversation",sourceReference:"conversation.b",mutationPolicy:"auto"}
    ]}));
    equal((await service.process(requestBase)).length,0,"candidate from another conversation is rejected");
  }

  {
    const secretResult=JSON.stringify({memories:[
      {type:"fact",content:"API key: sk-12345678901234567890",tags:["secret"],importance:100,confidence:100,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]});
    const {service,broker}=await newService(secretResult);
    equal((await service.process(requestBase)).length,0,"secret candidate is rejected");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"secret candidate never reaches persistence");
  }

  ok(true,"automatic memory extraction suite reached completion");
  console.log("PASS automatic memory extraction tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});