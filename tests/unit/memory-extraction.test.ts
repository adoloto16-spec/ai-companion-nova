import {InMemoryAuditService,InMemoryEventBus,MemoryBrokerImpl,MemoryExtractionService} from "../../core/src";
import {StandardContractValidator} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

const requestBase={
  apiVersion:"1" as const,schemaVersion:"1",characterId:"character.a",conversationId:"conversation.a",turnId:"turn-1",model:"fake-memory-extractor",
  userMessage:{id:"u1",role:"user" as const,content:"I prefer aviation examples and I moved to Nuremberg."},
  assistantMessage:{id:"a1",role:"assistant" as const,content:"Understood."},
  contextMessages:[] as const
};

async function createService(result:string|Error){
  const store=new InMemoryMemoryStore();
  const broker=new MemoryBrokerImpl({
    store,validator:new StandardContractValidator(),audit:new InMemoryAuditService(),events:new InMemoryEventBus(),
    characterExists:async id=>id==="character.a",
    conversationExists:async (characterId,conversationId)=>characterId==="character.a"&&conversationId==="conversation.a"
  });
  const runtime={async chat(request:{requestId:string;conversationId?:string;model:string}){
    if(result instanceof Error)throw result;
    return {
      apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.conversationId??"conversation.a",
      providerId:"fake.chat",model:request.model,
      message:{id:request.requestId+":assistant",role:"assistant" as const,content:result},
      finishReason:"stop" as const
    };
  }};
  return {service:new MemoryExtractionService(runtime,broker,{validator:new StandardContractValidator()}),broker};
}

async function main(){
  {
    const {service,broker}=await createService(JSON.stringify({memories:[]}));
    const created=await service.process(requestBase);
    equal(created.length,0,"empty extraction returns no memories");
  }
  {
    const payload=JSON.stringify({memories:[
      {type:"preference",content:"User prefers aviation examples.",tags:["aviation"],importance:80,confidence:95,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"},
      {type:"fact",content:"User moved to Nuremberg.",tags:["location"],importance:90,confidence:90,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"},
      {type:"relationship",content:"User regularly discusses projects with a colleague.",tags:["relationship"],importance:60,confidence:70,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]});
    const {service,broker}=await createService(payload);
    const created=await service.process(requestBase);
    equal(created.length,3,"multiple valid candidates persist");
    const found=await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",status:"active",limit:10});
    equal(found.length,3,"broker stores extracted candidates only in current conversation");
  }
  {
    const {service,broker}=await createService(JSON.stringify({memories:[
      {type:"fact",content:"User lives in Berlin.",tags:["home"],importance:80,confidence:90,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}
    ]}));
    await service.process(requestBase);
    const again=await service.process(requestBase);
    equal(again.length,0,"same turn does not duplicate memory");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"Berlin",status:"active"})).length,1,"duplicate is prevented deterministically");
  }
  {
    const existingBrokerStore=new InMemoryMemoryStore();
    const events=new InMemoryEventBus();
    const broker=new MemoryBrokerImpl({
      store:existingBrokerStore,validator:new StandardContractValidator(),audit:new InMemoryAuditService(),events,
      characterExists:async()=>true,conversationExists:async()=>true
    });
    await broker.create("character.a",{id:"old",conversationId:"conversation.a",type:"fact",content:"User lives in Berlin and prefers local cafés.",tags:["home","location"],importance:80,confidence:80,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto",metadata:{}} ,{
      actorId:"seed",actorType:"system",trusted:true,capabilities:["memory.create","memory.write.auto"]
    });
    const runtime={async chat(request:{requestId:string;conversationId?:string;model:string})=>({
      apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.conversationId??"conversation.a",providerId:"fake.chat",model:request.model,
      message:{id:request.requestId+":assistant",role:"assistant" as const,content:JSON.stringify({memories:[{type:"fact",content:"User lives in Nuremberg and prefers local cafés.",tags:["home","location"],importance:90,confidence:95,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}]} )},
      finishReason:"stop" as const
    })};
    const service=new MemoryExtractionService(runtime,broker,{validator:new StandardContractValidator()});
    const replaced=await service.process(requestBase);
    equal(replaced.length,1,"changed fact produces replacement");
    equal((await broker.get("character.a","conversation.a","old"))?.status,"superseded","old fact is superseded");
  }
  {
    const {service,broker}=await createService("{malformed");
    equal((await service.process(requestBase)).length,0,"malformed provider response is skipped");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"malformed result never persists memory");
  }
  {
    const payload=JSON.stringify({memories:[{type:"fact",content:"API key: sk-12345678901234567890",tags:["secret"],importance:100,confidence:100,source:"conversation",sourceReference:"conversation.a",mutationPolicy:"auto"}]});
    const {service,broker}=await createService(payload);
    equal((await service.process(requestBase)).length,0,"secret candidate is rejected");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"secret candidate never reaches persistence");
  }
  {
    const {service,broker}=await createService(new Error("provider offline"));
    equal((await service.process(requestBase)).length,0,"provider failure is isolated from chat");
    equal((await broker.search({characterId:"character.a",conversationId:"conversation.a",query:"",limit:10})).length,0,"provider failure creates no memory");
  }
  console.log("PASS automatic memory extraction tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
