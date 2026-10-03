import {
  AutomaticMemoryAgent,
  InMemoryAuditService,
  InMemoryEventBus,
  MemoryBrokerImpl,
  createDeterministicContextEngine,
  InMemoryChatTraceStore
} from "../../core/src";
import {defaultAppSettings,StandardContractValidator} from "../../contracts/src";
import type {ChatRequest,ChatResponse} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import {InMemoryConversationStore,createConversationTemplate} from "../../host/conversations/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const validator=new StandardContractValidator();
  const memoryStore=new InMemoryMemoryStore();
  const conversationStore=new InMemoryConversationStore();
  const broker=new MemoryBrokerImpl({
    store:memoryStore,
    validator,
    audit:new InMemoryAuditService(),
    events:new InMemoryEventBus(),
    characterExists:async id=>id==="character.a",
    conversationExists:async(characterId,conversationId)=>characterId==="character.a"&&Boolean(await conversationStore.get(characterId,conversationId))
  });
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
    settings:()=>({...defaultAppSettings(),memoryAgent:{enabled:true,providerPresetId:"preset.memory",model:"memory-model"}}),
    broker,runtime,traceStore
  });
  const created=await agent.process({
    apiVersion:"1",schemaVersion:"1",characterId:"character.a",conversationId:conversation!.id,turnId:"integration-turn-1",
    userMessage:{role:"user",content:"My favorite color is green."},
    assistantMessage:{role:"assistant",content:"Understood."},
    contextMessages:[]
  });
  ok(Boolean(created),"completed turn creates long-term memory");

  await conversationStore.clear("character.a",conversation!.id);
  equal((await broker.search({characterId:"character.a",conversationId:conversation!.id,query:"green",status:"active",limit:10})).length,1,"clearing conversation messages preserves long-term memory");

  const other=createConversationTemplate("character.a",{title:"Second conversation"});
  await conversationStore.save(other);
  equal((await broker.search({characterId:"character.a",conversationId:other.id,query:"green",status:"active",limit:10})).length,0,"memory is not visible in another conversation");

  const contextEngine=createDeterministicContextEngine(
    {listCoreBookEntries:async()=>[]},
    {memoryBroker:broker,recentMessageCount:()=>8,memoryCandidateLimit:()=>8}
  );
  const assembled=await contextEngine.build({
    apiVersion:"1",schemaVersion:"1",characterId:"character.a",conversationId:conversation!.id,
    messages:[{role:"user",content:"What is my favorite color?"}],
    budget:{availableContextTokens:4096,reservedOutputTokens:512,systemOverheadTokens:0,safetyMarginTokens:64}
  });
  equal(assembled.includedCandidates.filter(candidate=>candidate.source==="memory").length,1,"same conversation memory becomes eligible to Context Engine");
  ok(!JSON.stringify(assembled.includedCandidates).includes(other.id),"context assembly never includes other conversation id");

  console.log("PASS Automatic Memory Agent integration pipeline");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
