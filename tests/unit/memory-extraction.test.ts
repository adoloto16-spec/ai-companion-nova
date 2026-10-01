import {InMemoryAuditService,InMemoryEventBus,MemoryBrokerImpl,MemoryExtractionService} from "../../core/src";
import {StandardContractValidator} from "../../contracts/src";
import type {ChatRequest,ChatResponse,MemoryExtractionRequest} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

const requestBase:MemoryExtractionRequest={
  apiVersion:"1",schemaVersion:"1",characterId:"character.a",conversationId:"conversation.a",turnId:"turn-1",model:"fake-memory-extractor",
  userMessage:{id:"u1",role:"user",content:"I prefer aviation examples and I moved to Nuremberg."},
  assistantMessage:{id:"a1",role:"assistant",content:"Understood."},
  contextMessages:[]
};

function response(request:ChatRequest,content:string):ChatResponse{
  return {
    apiVersion:"1",schemaVersion:"1",requestId:request.requestId,
    conversationId:request.context.conversationId,providerId:"fake.chat",model:request.model,
    message:{id:request.requestId+":assistant",role:"assistant",content},finishReason:"stop"
  };
}

async function newService(result:string|Error){
  const broker=new MemoryBrokerImpl({
    store:new InMemoryMemoryStore(),validator:new StandardContractValidator(),audit:new InMemoryAuditService(),events:new InMemoryEventBus(),
    characterExists:async id=>id==="character.a",
    conversationExists:async (characterId,conversationId)=>characterId==="character.a"&&conversationId==="conversation.a"
  });
  const runtime={
    async chat(request:ChatRequest):Promise<ChatResponse>{
      if(result instanceof Error)throw result;
      return response(request,result);
    }
  };
  return {service:new MemoryExtractionService(runtime,broker,{validator:new StandardContractValidator()}),broker};
}

async function main(){
  const authority={actorId:"seed",actorType:"system" as const,trusted:true,capabilities:["memory.create","memory.write.auto"] as const};

  {
    const {service,broker}=await newService(JSON.stringify({memories:[]}));
    equal((await service.process(requestBase)).length,0,"empty extraction returns no memories");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"empty result does not persist");
  }

  {
    const result=JSON.stringify({memories:[
      {type:"preference",content:"User prefers aviation examples.",tags:["aviation"],importance:80,confidence:95,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"},
      {type:"fact",content:"User moved to Nuremberg.",tags:["location"],importance:90,confidence:90,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"},
      {type:"relationship",content:"User regularly discusses projects with a colleague.",tags:["relationship"],importance:60,confidence:70,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]});
    const {service,broker}=await newService(result);
    equal((await service.process(requestBase)).length,3,"multiple candidates persist");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",status:"active",limit:10})).length,3,"all candidates stay in current conversation");
  }

  {
    const result=JSON.stringify({memories:[
      {type:"fact",content:"User lives in Berlin.",tags:["home"],importance:80,confidence:90,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]});
    const {service,broker}=await newService(result);
    await service.process(requestBase);
    equal((await service.process(requestBase)).length,0,"same turn is idempotent");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"Berlin",status:"active"})).length,1,"exact duplicate is not created twice");
  }

  {
    const broker=new MemoryBrokerImpl({
      store:new InMemoryMemoryStore(),validator:new StandardContractValidator(),audit:new InMemoryAuditService(),events:new InMemoryEventBus(),
      characterExists:async()=>true,conversationExists:async()=>true
    });
    await broker.create("character.a",{
      id:"old",conversationId:"conversation.a",type:"fact",content:"User lives in Berlin and prefers local cafés.",tags:["home","location"],
      importance:80,confidence:80,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto",metadata:{}
    },authority);
    const runtime={
      async chat(request:ChatRequest):Promise<ChatResponse>{
        return response(request,JSON.stringify({memories:[
          {type:"fact",content:"User lives in Nuremberg and prefers local cafés.",tags:["home","location"],importance:90,confidence:95,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
        ]}));
      }
    };
    const service=new MemoryExtractionService(runtime,broker,{validator:new StandardContractValidator()});
    equal((await service.process(requestBase)).length,1,"changed fact produces replacement");
    equal((await broker.get("character.a","conversation.a","old"))?.status,"superseded","old fact is superseded");
  }

  {
    const {service,broker}=await newService("{malformed");
    equal((await service.process(requestBase)).length,0,"malformed provider response is skipped");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"malformed result is not persisted");
  }

  {
    const secretResult=JSON.stringify({memories:[
      {type:"fact",content:"API key: sk-12345678901234567890",tags:["secret"],importance:100,confidence:100,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]});
    const {service,broker}=await newService(secretResult);
    equal((await service.process(requestBase)).length,0,"secret candidate is rejected");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"secret candidate never reaches persistence");
  }

  {
    const {service,broker}=await newService(new Error("provider offline"));
    equal((await service.process(requestBase)).length,0,"provider failure is isolated");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"provider failure creates no memory");
  }

  {
    const {service}=await newService(JSON.stringify({memories:[
      {type:"fact",content:"Cross conversation memory.",tags:["scope"],importance:80,confidence:80,source:"conversation",sourceReference:"conversation.b",mutationPolicy:"auto"}
    ]}));
    equal((await service.process(requestBase)).length,0,"candidate from another conversation is rejected");
  }

  ok(true,"automatic memory extraction suite reached completion");
  console.log("PASS automatic memory extraction tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
