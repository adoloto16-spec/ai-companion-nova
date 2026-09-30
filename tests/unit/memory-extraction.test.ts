import {InMemoryAuditService,MemoryBrokerImpl,MemoryExtractionService} from "../../core/src";
import {StandardContractValidator,type ChatRequest,type ChatResponse,type MemoryExtractionRequest} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

const authority={actorId:"automatic-memory-extractor",actorType:"system" as const,trusted:true,capabilities:["memory.create","memory.write.auto"],moduleId:"memory-extraction"};
function request(requestId:string):MemoryExtractionRequest{
  return {
    requestId,model:"fake-memory-model",apiVersion:"1",schemaVersion:"1",characterId:"character.nova",conversationId:"conversation.nova.a",
    userMessage:{id:requestId+":user",role:"user",content:"I prefer aviation examples."},
    assistantMessage:{id:requestId+":assistant",role:"assistant",content:"I will use aviation examples."},
    contextMessages:[{id:"previous",role:"user",content:"We were discussing examples."}]
  };
}
function responseFor(requestId:string,content:string):ChatResponse{
  return {apiVersion:"1",schemaVersion:"1",requestId:requestId+":memory-extraction",conversationId:"conversation.nova.a",providerId:"fake.chat",model:"fake-memory-model",message:{id:requestId+":response",role:"assistant",content},finishReason:"stop"};
}
function createExtractor(){
  const store=new InMemoryMemoryStore();
  const broker=new MemoryBrokerImpl({
    store,
    validator:new StandardContractValidator(),
    audit:new InMemoryAuditService(),
    characterExists:async id=>id==="character.nova"
  });
  const errors:string[]=[];
  const extractor=new MemoryExtractionService({
    validator:new StandardContractValidator(),
    memoryBroker:broker,
    authority,
    diagnostics:{recordError:(_source,_code,message)=>errors.push(message)}
  });
  return {store,broker,extractor,errors};
}

async function main(){
  {
    const {broker,extractor}=createExtractor();
    let seen:ChatRequest|undefined;
    const result=await extractor.extractAndApply(request("extract-1"),{
      chat:async chatRequest=>{
        seen=chatRequest;
        return responseFor("extract-1",JSON.stringify({memories:[{
          type:"preference",content:"The user prefers aviation examples.",tags:["examples","aviation"],importance:80,confidence:95,
          source:"conversation",sourceReference:"conversation.nova.a",mutationPolicy:"auto",metadata:{memoryKey:"example-style"}
        }]}));
      }
    });
    equal(result.createdMemoryIds.length,1,"one candidate is persisted");
    equal(seen?.context.messages[0]?.role,"system","extractor uses a provider-neutral system instruction");
    equal(seen?.context.conversationId,"conversation.nova.a","extraction chat stays in the active conversation");
    const saved=await broker.get("character.nova","conversation.nova.a",result.createdMemoryIds[0]!);
    equal(saved?.source,"conversation","automatic memory provenance is conversation");
    equal(saved?.sourceReference,"conversation.nova.a","automatic memory references the conversation");
    equal(saved?.mutationPolicy,"auto","automatic memory uses auto mutation policy");
    equal(saved?.metadata.memoryKey,"example-style","stable memory key is preserved safely");
  }

  {
    const {broker,extractor}=createExtractor();
    const chat={chat:async(request:ChatRequest)=>responseFor(request.requestId.replace(":memory-extraction",""),JSON.stringify({memories:[{
      type:"preference",content:"The user likes aviation.",tags:["aviation"],importance:80,confidence:90,source:"conversation",sourceReference:"conversation.nova.a",mutationPolicy:"auto"
    }]}))};
    await extractor.extractAndApply(request("duplicate-1"),chat);
    const duplicate=await extractor.extractAndApply(request("duplicate-2"),chat);
    equal(duplicate.createdMemoryIds.length,0,"normalized duplicate is not created again");
    equal((await broker.search({characterId:"character.nova",conversationId:"conversation.nova.a",query:""})).length,1,"exact duplicate prevention keeps one active memory");
  }

  {
    const {broker,extractor}=createExtractor();
    await broker.create("character.nova","conversation.nova.a",{
      id:"existing-residence",type:"fact",content:"The user lives in Berlin.",tags:["residence"],importance:80,confidence:95,
      source:"conversation",sourceReference:"conversation.nova.a",mutationPolicy:"auto",metadata:{memoryKey:"residence"}
    },authority);
    const result=await extractor.extractAndApply({
      ...request("supersede-1"),
      userMessage:{id:"u",role:"user",content:"I live in Nuremberg now."},
      assistantMessage:{id:"a",role:"assistant",content:"Understood."}
    },{
      chat:async chatRequest=>responseFor("supersede-1",JSON.stringify({memories:[{
        type:"fact",content:"The user lives in Nuremberg.",tags:["residence"],importance:85,confidence:95,
        source:"conversation",sourceReference:"conversation.nova.a",mutationPolicy:"auto",metadata:{memoryKey:"residence"}
      }]}))
    });
    equal(result.supersededMemoryIds.length,1,"stable memory key supersedes the previous active fact");
    equal((await broker.get("character.nova","conversation.nova.a","existing-residence"))?.status,"superseded","previous memory is retained as superseded");
    equal((await broker.search({characterId:"character.nova",conversationId:"conversation.nova.a",query:""})).filter(item=>item.status==="active").length,1,"supersede leaves one active memory");
  }

  {
    const {broker,extractor,errors}=createExtractor();
    const failure=await extractor.extractAndApply(request("provider-failure"),{chat:async()=>{throw new Error("provider unavailable")}})
    equal(failure.createdMemoryIds.length,0,"provider failure creates no memory");
    equal(errors.length,1,"provider failure is diagnosed");
    equal((await broker.search({characterId:"character.nova",conversationId:"conversation.nova.a",query:""})).length,0,"provider failure leaves memory unchanged");
  }

  {
    const {broker,extractor,errors}=createExtractor();
    const malformed=await extractor.extractAndApply(request("malformed"),{chat:async()=>responseFor("malformed","not json")});
    equal(malformed.createdMemoryIds.length,0,"malformed extraction result creates no memory");
    ok(errors.some(message=>message.toLowerCase().includes("json")||message.toLowerCase().includes("response")),"malformed result is diagnosed safely");
  }

  {
    const {broker,extractor,errors}=createExtractor();
    const secret=await extractor.extractAndApply(request("secret"),{chat:async()=>responseFor("secret",JSON.stringify({memories:[{
      type:"fact",content:"API key: sk-test-secret-value-123456789",tags:["credential"],importance:100,confidence:100,
      source:"conversation",sourceReference:"conversation.nova.a",mutationPolicy:"auto"
    }]}))});
    equal(secret.createdMemoryIds.length,0,"credential-like candidate is never stored");
    equal((await broker.search({characterId:"character.nova",conversationId:"conversation.nova.a",query:""})).length,0,"credential-like candidate leaves storage empty");
    ok(errors.some(message=>message.toLowerCase().includes("credential")),"credential rejection is diagnosed without storing the secret");
  }

  {
    const {extractor,broker}=createExtractor();
    const first=await extractor.extractAndApply(request("same-turn"),{chat:async()=>responseFor("same-turn",JSON.stringify({memories:[]}))});
    const second=await extractor.extractAndApply(request("same-turn"),{chat:async()=>responseFor("same-turn",JSON.stringify({memories:[{
      type:"fact",content:"This should be ignored.",tags:["ignore"],importance:90,confidence:90,source:"conversation",sourceReference:"conversation.nova.a",mutationPolicy:"auto"
    }]}))});
    equal(first.createdMemoryIds.length,0,"empty extraction creates nothing");
    equal(second.createdMemoryIds.length,0,"same turn identity is processed only once");
    equal((await broker.search({characterId:"character.nova",conversationId:"conversation.nova.a",query:""})).length,0,"duplicate extraction cannot create a second memory");
  }

  console.log("PASS Memory extraction service unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
