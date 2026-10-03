import {
  AutomaticMemoryAgent,
  InMemoryAuditService,
  InMemoryChatTraceStore,
  InMemoryDiagnosticsStore,
  InMemoryEventBus,
  MemoryBrokerImpl
} from "../../core/src";
import {defaultAppSettings,StandardContractValidator} from "../../contracts/src";
import type {AppSettings,AutomaticMemoryAgentRequest,ChatRequest,ChatResponse} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

const baseRequest:AutomaticMemoryAgentRequest={
  apiVersion:"1",
  schemaVersion:"1",
  characterId:"character.a",
  conversationId:"conversation.a",
  turnId:"turn-1",
  userMessage:{id:"u1",role:"user",content:"I prefer green."},
  assistantMessage:{id:"a1",role:"assistant",content:"Understood; I will use green examples."},
  contextMessages:[
    {id:"c1",role:"user",content:"We are working on an aviation example."},
    {id:"c2",role:"assistant",content:"I will remember the aviation context."}
  ]
};

function response(request:ChatRequest,content:string):ChatResponse{
  return {
    apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,
    providerId:request.providerId??"fake.chat",model:request.model,
    message:{id:request.requestId+":assistant",role:"assistant",content},finishReason:"stop"
  };
}

async function fixture(content:string|Error,overrides:Partial<AppSettings>={}){
  const validator=new StandardContractValidator();
  const memoryStore=new InMemoryMemoryStore();
  const broker=new MemoryBrokerImpl({
    store:memoryStore,validator,audit:new InMemoryAuditService(),events:new InMemoryEventBus(),
    characterExists:async id=>id==="character.a",
    conversationExists:async (characterId,conversationId)=>characterId==="character.a"&&["conversation.a","conversation.b"].includes(conversationId)
  });
  const diagnostics=new InMemoryDiagnosticsStore();
  const traceStore=new InMemoryChatTraceStore();
  const settings={...defaultAppSettings(),memoryAgent:{...defaultAppSettings().memoryAgent,providerPresetId:"preset.memory",model:"memory-model",...overrides.memoryAgent}};
  let calls=0;
  const presetIds:string[]=[];
  const requests:ChatRequest[]=[];
  const runtime={
    async chat(request:ChatRequest,presetId?:string):Promise<ChatResponse>{
      calls++;requests.push(request);if(presetId)presetIds.push(presetId);
      if(content instanceof Error)throw content;
      return response(request,content);
    },
    async getChatModelForPreset(presetId:string){return presetId==="preset.memory"?"memory-model":"unexpected-model";}
  };
  const agent=new AutomaticMemoryAgent({settings:()=>settings,broker,runtime,diagnostics,traceStore});
  return {agent,broker,diagnostics,traceStore,calls:()=>calls,presetIds,requests,settings};
}

function completedMainTrace(traceStore:InMemoryChatTraceStore,request=baseRequest):void{
  traceStore.start({
    turnId:request.turnId,requestId:request.turnId,characterId:request.characterId,
    conversationId:request.conversationId,timestamp:"2026-10-03T00:00:00.000Z"
  });
  traceStore.update(request.turnId,{status:"completed"});
}

async function main(){
  {
    const {agent,broker,traceStore}=await fixture("NO_MEMORY");
    completedMainTrace(traceStore);
    equal(await agent.process(baseRequest),undefined,"NO_MEMORY does not create memory");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"NO_MEMORY persists nothing");
    equal(traceStore.recent(1)[0]?.status,"completed","main turn remains completed for NO_MEMORY");
    equal(traceStore.recent(1)[0]?.automaticMemory?.status,"completed","agent reports completed NO_MEMORY");
    equal(traceStore.recent(1)[0]?.automaticMemory?.result,"NO_MEMORY","agent stores exact sentinel result");
  }

  {
    const {agent,broker}=await fixture("User prefers green.");
    const created=await agent.process(baseRequest);
    ok(Boolean(created),"plain text creates memory");
    equal(created?.content,"User prefers green.","memory content exactly matches agent text");
    equal(created?.type,"observation","Core owns memory type");
    equal(created?.tags,[],"Core owns empty tags");
    equal(created?.importance,70,"Core owns fixed importance");
    equal(created?.confidence,80,"Core owns fixed confidence");
    equal(created?.source,"conversation","Core owns provenance source");
    equal(created?.sourceReference,baseRequest.turnId,"Core owns turn provenance");
    equal(created?.mutationPolicy,"auto","Core owns automatic mutation policy");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"green",status:"active",limit:10})).length,1,"memory is persisted");
  }

  {
    const {agent,broker}=await fixture("Nova agreed to continue the Su-57 discussion tomorrow.");
    const request={...baseRequest,
      turnId:"assistant-origin-1",
      userMessage:{id:"u2",role:"user" as const,content:"Remember that tomorrow we continue the Su-57 discussion."},
      assistantMessage:{id:"a2",role:"assistant" as const,content:"Agreed; tomorrow we continue the Su-57 discussion."}
    };
    const created=await agent.process(request);
    equal(created?.content,"Nova agreed to continue the Su-57 discussion tomorrow.","assistant-origin memory is supported");
    equal(created?.conversationId,"conversation.a","assistant-origin memory remains scoped");
  }

  {
    const longText="A durable user note ".repeat(40).trim();
    const {agent}=await fixture(longText);
    const created=await agent.process({...baseRequest,turnId:"long-1"});
    equal(created?.content,longText,"arbitrary nonempty text becomes memory content");
  }

  {
    const {agent,requests}=await fixture("There is no memory needed.");
    const created=await agent.process({...baseRequest,turnId:"ordinary-1"});
    equal(created?.content,"There is no memory needed.","ordinary text is not over-normalized to NO_MEMORY");
    equal(requests[0]?.generation,undefined,"agent uses an ordinary text ChatRequest");
  }

  {
    const {agent,diagnostics,traceStore}=await fixture(new Error("provider offline"));
    completedMainTrace(traceStore,{...baseRequest,turnId:"provider-failure-1"});
    equal(await agent.process({...baseRequest,turnId:"provider-failure-1"}),undefined,"provider failure creates no memory");
    const trace=traceStore.recent(1)[0];
    equal(trace?.status,"completed","main chat stays completed after agent provider failure");
    equal(trace?.automaticMemory?.status,"failed","agent failure is independent");
    equal(trace?.automaticMemory?.failed,"Provider call failed.","provider failure reason is isolated");
    equal(diagnostics.recentErrors(1)[0]?.code,"PROVIDER_FAILURE","provider failure is diagnostic");
  }

  {
    const {agent,requests,presetIds}=await fixture("Memory text.");
    await agent.process({...baseRequest,turnId:"preset-1"});
    equal(presetIds[0],"preset.memory","agent uses its own provider preset");
    equal(requests[0]?.model,"memory-model","agent uses its own model binding");
    equal(requests[0]?.generation,undefined,"agent never requests structured output");
  }

  {
    const {agent,broker}=await fixture("API key: sk-12345678901234567890");
    equal(await agent.process({...baseRequest,turnId:"secret-1"}),undefined,"secret output is rejected");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"secret memory is never persisted");
  }

  {
    const {agent,broker}=await fixture("Exact durable memory.");
    const first=await agent.process({...baseRequest,turnId:"duplicate-1"});
    const second=await agent.process({...baseRequest,turnId:"duplicate-2"});
    ok(Boolean(first),"first memory is created");
    equal(second?.id,first?.id,"exact duplicate is not created twice");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"Exact durable memory.",limit:10})).length,1,"duplicate protection is deterministic");
  }

  {
    const pending=new Promise<ChatResponse>(()=>{});
    const {agent,broker,settings}=await fixture("Unused");
    let calls=0;
    const agentWithPending=new AutomaticMemoryAgent({
      settings:()=>settings,
      broker,
      diagnostics:new InMemoryDiagnosticsStore(),
      traceStore:new InMemoryChatTraceStore(),
      runtime:{
        async chat(){calls++;return pending},
        async getChatModelForPreset(){return "memory-model";}
      }
    });
    void agentWithPending.process({...baseRequest,turnId:"inflight"});
    void agentWithPending.process({...baseRequest,turnId:"inflight"});
    await Promise.resolve();
    equal(calls,1,"same turn is processed once while in flight");
  }

  {
    const {agent,broker}=await fixture("Conversation A fact.");
    const created=await agent.process({...baseRequest,turnId:"scope-a"});
    ok(Boolean(created),"scoped memory is created");
    const otherConversation=await broker.search({characterId:"character.a",conversationId:"conversation.b",query:"",limit:10});
    equal(otherConversation.length,0,"other conversation cannot see memory");
    const otherCharacter=await broker.search({characterId:"character.b",conversationId:"conversation.a",query:"",limit:10}).catch(()=>[]);
    equal(otherCharacter.length,0,"other character cannot see memory");
  }

  {
    const settings={...defaultAppSettings(),memoryAgent:{...defaultAppSettings().memoryAgent,enabled:false,providerPresetId:"preset.memory",model:"memory-model"}};
    const validator=new StandardContractValidator();
    const store=new InMemoryMemoryStore();
    const broker=new MemoryBrokerImpl({store,validator,audit:new InMemoryAuditService(),characterExists:async id=>id==="character.a",conversationExists:async (characterId,conversationId)=>characterId==="character.a"&&conversationId==="conversation.a"});
    let calls=0;
    const traceStore=new InMemoryChatTraceStore();
    traceStore.start({turnId:"disabled",requestId:"disabled",characterId:"character.a",conversationId:"conversation.a",timestamp:"2026-10-03T00:00:00.000Z"});
    traceStore.update("disabled",{status:"completed"});
    const agent=new AutomaticMemoryAgent({
      settings:()=>settings,broker,traceStore,
      runtime:{async chat(request){calls++;return response(request,"memory")},async getChatModelForPreset(){return "memory-model";}}
    });
    equal(await agent.process({...baseRequest,turnId:"disabled"}),undefined,"disabled agent skips memory");
    equal(calls,0,"disabled agent does not call provider");
    equal(traceStore.recent(1)[0]?.automaticMemory?.status,"skipped","disabled agent is visible in diagnostics");
  }

  console.log("PASS Automatic Memory Agent v2 tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
