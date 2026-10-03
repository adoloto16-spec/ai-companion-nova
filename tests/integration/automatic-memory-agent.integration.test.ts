import {
  AutomaticMemoryAgent,
  InMemoryAuditService,
  InMemoryEventBus,
  MemoryBrokerImpl,
  RetrievalEventIndexer,
  createDeterministicContextEngine,
  InMemoryChatTraceStore
} from "../../core/src";
import {defaultAppSettings,StandardContractValidator} from "../../contracts/src";
import type {ChatRequest,ChatResponse,MemoryStoreState,RetrievalIndexDocument} from "../../contracts/src";
import {IpcMemoryStore} from "../../host/memory/src";
import {InMemoryConversationStore,createConversationTemplate} from "../../host/conversations/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const validator=new StandardContractValidator();
  let persistedState:MemoryStoreState|undefined;
  const memoryInvoke=async(command:string,args?:Record<string,unknown>):Promise<unknown>=>{
    switch(command){
      case "get_memory_state":
        return persistedState?JSON.parse(JSON.stringify(persistedState)) as MemoryStoreState:undefined;
      case "save_memory_state":{
        const stateValue=args?.stateValue;
        if(!stateValue)throw new Error("missing stateValue in test IPC boundary");
        persistedState=JSON.parse(JSON.stringify(stateValue)) as MemoryStoreState;
        return undefined;
      }
      default:
        throw new Error("Unexpected memory IPC command: "+command);
    }
  };
  const memoryStore=new IpcMemoryStore(memoryInvoke);
  const conversationStore=new InMemoryConversationStore();
  const events=new InMemoryEventBus();
  const broker=new MemoryBrokerImpl({
    store:memoryStore,
    validator,
    audit:new InMemoryAuditService(),
    events,
    characterExists:async id=>id==="character.a",
    conversationExists:async(characterId,conversationId)=>characterId==="character.a"&&Boolean(await conversationStore.get(characterId,conversationId))
  });
  const indexed:RetrievalIndexDocument[]=[];
  const indexer=new RetrievalEventIndexer({
    events,
    coreBook:{getCoreBookEntry:async()=>undefined},
    memory:broker,
    writer:{
      upsert:async(document)=>{indexed.push(document);},
      remove:async()=>{},
      removeCharacter:async()=>{}
    }
  });
  indexer.start();
  const defaultConversation=createConversationTemplate("character.a");
  await conversationStore.save(defaultConversation);
  const conversation=await conversationStore.getActive("character.a");
  ok(Boolean(conversation),"default conversation exists");
  const traceStore=new InMemoryChatTraceStore();
  const runtime={
    async chat(request:ChatRequest):Promise<ChatResponse>{
      return {
        apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,
        providerId:"memory.fake",model:"memory-model",
        message:{role:"assistant",content:"User's favorite color is green."},
        finishReason:"stop"
      };
    },
    async getChatModelForPreset(){return "memory-model";}
  };
  const agent=new AutomaticMemoryAgent({
    settings:()=>({...defaultAppSettings(),memoryAgent:{...defaultAppSettings().memoryAgent,enabled:true,providerPresetId:"preset.memory",model:"memory-model"}}),
    broker,runtime,traceStore
  });
  const created=await agent.process({
    apiVersion:"1",schemaVersion:"1",characterId:"character.a",conversationId:conversation!.id,turnId:"integration-turn-1",
    userMessage:{role:"user",content:"My favorite color is green."},
    assistantMessage:{role:"assistant",content:"Understood."},
    contextMessages:[]
  });
  ok(Boolean(created),"completed turn creates long-term memory");
  equal(created?.status,"active","automatic memory is active");
  equal(created!.id.trim().length>0,true,"automatic memory receives a non-empty id");
  equal(created?.tags,[],"automatic memory accepts empty tags");
  equal(created?.importance,70,"automatic memory importance is deterministic");
  equal(created?.confidence,80,"automatic memory confidence is deterministic");
  equal(created?.source,"conversation","automatic memory provenance is deterministic");
  equal(created?.sourceReference,"integration-turn-1","automatic memory sourceReference is the turn id");
  equal(created?.mutationPolicy,"auto","automatic memory mutation policy is deterministic");
  ok(indexed.some(document=>document.source==="memory"&&document.sourceId===created!.id),"MemoryCreated updates the retrieval index");
  const reloadedStore=new IpcMemoryStore(memoryInvoke);
  const reloadedBroker=new MemoryBrokerImpl({
    store:reloadedStore,
    validator,
    audit:new InMemoryAuditService(),
    events:new InMemoryEventBus(),
    characterExists:async id=>id==="character.a",
    conversationExists:async(characterId,conversationId)=>characterId==="character.a"&&conversationId==="conversation.a"
  });
  equal((await reloadedBroker.get("character.a",conversation!.id,created!.id))?.status,"active","automatic memory survives a persistence reload");

  const edited=await broker.update("character.a",conversation!.id,created!.id,{
    type:"preference",content:"User prefers green aviation examples.",tags:["aviation"],importance:85,confidence:90
  },{
    actorId:"local-user",actorType:"user",trusted:true,capabilities:[]
  });
  equal(edited.type,"preference","MemoryBroker updates editable type");
  equal(edited.content,"User prefers green aviation examples.","MemoryBroker updates content");
  equal(edited.tags,["aviation"],"MemoryBroker updates tags");
  const updatedContext=await createDeterministicContextEngine({listCoreBookEntries:async()=>[]},{memoryBroker:broker,recentMessageCount:()=>8,memoryCandidateLimit:()=>8}).build({
    apiVersion:"1",schemaVersion:"1",characterId:"character.a",conversationId:conversation!.id,
    messages:[{role:"user",content:"aviation"}],
    budget:{availableContextTokens:4096,reservedOutputTokens:512,systemOverheadTokens:0,safetyMarginTokens:64}
  });
  equal(updatedContext.includedCandidates.filter(candidate=>candidate.referenceId===created!.id).length,1,"updated memory remains eligible to Context Engine");
  await conversationStore.clear("character.a",conversation!.id);
  equal((await broker.search({characterId:"character.a",conversationId:conversation!.id,query:"green",status:"active",limit:10})).length,1,"clearing conversation messages preserves long-term memory");

  const other=createConversationTemplate("character.a",{id:"conversation.b",title:"Second conversation"});
  await conversationStore.save(other);
  equal((await broker.search({characterId:"character.a",conversationId:other.id,query:"green",status:"active",limit:10})).length,0,"memory is not visible in another conversation");

  const contextEngine=createDeterministicContextEngine(
    {listCoreBookEntries:async()=>[]},
    {memoryBroker:broker,recentMessageCount:()=>8,memoryCandidateLimit:()=>8}
  );
  const assembled=await contextEngine.build({
    apiVersion:"1",schemaVersion:"1",characterId:"character.a",conversationId:conversation!.id,
    messages:[{role:"user",content:"green"}],
    budget:{availableContextTokens:4096,reservedOutputTokens:512,systemOverheadTokens:0,safetyMarginTokens:64}
  });
  equal(assembled.includedCandidates.filter(candidate=>candidate.source==="memory").length,1,"same conversation memory becomes eligible to Context Engine");
  ok(!JSON.stringify(assembled.includedCandidates).includes(other.id),"context assembly never includes other conversation id");

  await broker.archive("character.a",conversation!.id,created!.id,{actorId:"local-user",actorType:"user",trusted:true,capabilities:[]});
  equal((await broker.search({characterId:"character.a",conversationId:conversation!.id,query:"",status:"active",limit:10})).length,0,"archived memory leaves active memory list");
  equal((await broker.search({characterId:"character.a",conversationId:conversation!.id,query:"",status:"archived",limit:10})).length,1,"archived memory remains persisted");

  indexer.stop();
  console.log("PASS Automatic Memory Agent integration pipeline");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
