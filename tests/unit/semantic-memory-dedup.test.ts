import {
  cosineSimilarity,
  deterministicContentHash,
  MemorySemanticDeduplicator,
  selectTopSemanticCandidates
} from "../../core/src";
import type {
  AppSettings,ChatRequest,ChatResponse,EmbeddingProvider,HealthStatus,MemoryItem,ProviderCapabilities
} from "../../contracts/src";
import {StandardContractValidator,defaultAppSettings} from "../../contracts/src";
import {
  InMemoryAuditService,InMemoryDiagnosticsStore,InMemoryEventBus,MemoryBrokerImpl
} from "../../core/src";
import {InMemoryMemorySemanticIndexStore,InMemoryMemoryStore} from "../../host/memory/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}
function close(actual:number|undefined,expected:number,label:string){if(actual===undefined||Math.abs(actual-expected)>1e-9)throw new Error(label+" expected "+expected+" got "+String(actual));}

class FakeEmbeddingProvider implements EmbeddingProvider{
  readonly id="fake.embeddings";
  calls:string[][]=[];
  constructor(private readonly vectorFor:(text:string)=>readonly number[]){}
  capabilities():ProviderCapabilities{return {embeddings:true};}
  dimensions():number{return 3;}
  async embed(texts:string[]):Promise<number[][]>{this.calls.push([...texts]);return texts.map(text=>[...this.vectorFor(text)]);}
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["embeddings"]};}
}
class FakeJudgeRuntime{
  calls:ChatRequest[]=[];
  constructor(private output:()=>string){}
  async chat(request:ChatRequest):Promise<ChatResponse>{
    this.calls.push(request);
    return {
      apiVersion:"1",schemaVersion:"1",requestId:request.requestId,
      conversationId:request.context.conversationId,providerId:"fake.judge",model:request.model,
      message:{role:"assistant",content:this.output()},
      finishReason:"stop"
    };
  }
}
function baseSettings(outputMode:"structured"|"plain"="structured"):AppSettings{
  const settings=defaultAppSettings();
  settings.semanticDedup={
    ...settings.semanticDedup,
    enabled:true,
    embeddingProviderPresetId:"preset.embedding",
    embeddingModel:"fake-embedding",
    candidateSimilarityThreshold:0.55,
    candidateLimit:5,
    judge:{
      ...settings.semanticDedup.judge,
      enabled:true,
      providerPresetId:"preset.judge",
      model:"fake-judge",
      outputMode,
      prompt:settings.semanticDedup.judge.prompt
    }
  };
  return settings;
}
function memory(id:string,content:string,characterId="character.a",status:"active"|"archived"="active"):MemoryItem{
  return {
    id,characterId,originConversationId:null,type:"fact",content,tags:[],importance:50,confidence:80,
    createdAt:"2026-10-01T00:00:00.000Z",updatedAt:"2026-10-01T00:00:00.000Z",
    validFrom:null,validUntil:null,source:"user",sourceReference:null,mutationPolicy:"auto",status,
    archiveReason:status==="archived"?"manual":null,metadata:{}
  };
}
async function fixture(output:()=>string,vectorFor?:(text:string)=>readonly number[]){
  const store=new InMemoryMemoryStore();
  const audit=new InMemoryAuditService();
  const events=new InMemoryEventBus();
  const diagnostics=new InMemoryDiagnosticsStore(200);
  const broker=new MemoryBrokerImpl({
    store,validator:new StandardContractValidator(),audit,events,
    clock:{now:()=>new Date().toISOString()},
    characterExists:async id=>id==="character.a"||id==="character.b"
  });
  const embeddings=new FakeEmbeddingProvider(vectorFor??(text=>text.includes("aviation")?[0,1,0]:text.includes("programming")?[0.8,0.6,0]:text.includes("dark-blue")?[0.98,0.2,0]:[1,0,0]));
  const judge=new FakeJudgeRuntime(output);
  const settings=baseSettings("structured");
  const indexStore=new InMemoryMemorySemanticIndexStore();
  const service=new MemorySemanticDeduplicator({
    settings:()=>settings,
    broker,
    indexStore,
    embeddingProvider:async()=>embeddings,
    judgeRuntime:judge,
    getChatModelForPreset:async()=> "fake-judge",
    validator:new StandardContractValidator(),
    diagnostics,
    events,
    listCharacterIds:async()=>["character.a","character.b"],
    source:"memory-semantic-deduplication"
  });
  service.start();
  return {store,broker,events,diagnostics,embeddings,judge,indexStore,settings,service};
}

async function vectorMathTest(){
  close(cosineSimilarity([1,0],[1,0]),1,"identical vector similarity");
  close(cosineSimilarity([1,0],[0,1]),0,"orthogonal vector similarity");
  equal(cosineSimilarity([1],[1,0]),undefined,"dimension mismatch");
  equal(cosineSimilarity([NaN,0],[1,0]),undefined,"NaN is invalid");
  equal(cosineSimilarity([Infinity,0],[1,0]),undefined,"Infinity is invalid");
  equal(cosineSimilarity([],[]),undefined,"empty vector is invalid");
  ok(deterministicContentHash(" User   likes blue.\n")===deterministicContentHash("User likes blue."),"content hash normalizes only cache whitespace");
}

async function candidateSelectionTest(){
  const newMemory=memory("new","new");
  const memories=[
    memory("b","b"),memory("a","a"),memory("other","other","character.b"),memory("archived","archived","character.a","archived"),newMemory
  ];
  const vectors=new Map<string,readonly number[]>([
    ["new",[1,0,0]],["b",[0.8,0.6,0]],["a",[0.8,0.6,0]],["other",[0.99,0.01,0]],["archived",[0.99,0.01,0]]
  ]);
  const selected=selectTopSemanticCandidates(newMemory,memories,vectors,0.7,2);
  equal(selected.map(item=>item.memory.id),["a","b"],"candidate ordering and top-k are deterministic");
  ok(selected.every(item=>item.memory.characterId==="character.a"),"character isolation");
}

async function duplicateEventIntegrationTest(){
  const fixtureValue=await fixture(()=>JSON.stringify({decisions:[{candidateId:"old",relation:"duplicate"}]}));
  await fixtureValue.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{
    actorId:"user",actorType:"user",trusted:true,capabilities:[]
  });
  await fixtureValue.broker.create("character.a",{id:"new",type:"fact",content:"User prefers blue.",source:"user",mutationPolicy:"auto"},{
    actorId:"user",actorType:"user",trusted:true,capabilities:[]
  });
  const created=await fixtureValue.broker.get("character.a","new");
  equal(created?.status,"archived","duplicate archives NEW only");
  equal(created?.archiveReason,"duplicate","duplicate archive reason");
  equal((await fixtureValue.broker.get("character.a","old"))?.status,"active","duplicate keeps OLD active");
  equal((await fixtureValue.broker.get("character.a","new"))?.status,"archived","canonical new remains recoverable");
  equal((await fixtureValue.indexStore.load("character.a"))?.records.map(record=>record.memoryId),["old"],"archived memory vector is removed");
}

async function supersessionIntegrationTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[{candidateId:"old",relation:"new_supersedes_candidate"}]}));
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"user",actorType:"user",trusted:true,capabilities:[]});
  const created=await f.broker.create("character.a",{id:"new",type:"fact",content:"User likes blue and especially prefers dark-blue.",source:"user",mutationPolicy:"auto"},{actorId:"user",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.get("character.a","new"))?.status,"active","superset keeps NEW active");
  const old=await f.broker.get("character.a","old");
  equal(old?.status,"archived","superset archives OLD");
  equal(old?.archiveReason,"superseded","superset archive reason");
  equal(old?.supersededBy,"new","supersededBy is real NEW id");
}

async function distinctAndUncertainTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[{candidateId:"old",relation:"distinct"}]}));
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User studies aviation.",source:"user",mutationPolicy:"auto"},{actorId:"user",actorType:"user",trusted:true,capabilities:[]});
  let newer=await f.broker.create("character.a",{id:"new",type:"fact",content:"User studies programming.",source:"user",mutationPolicy:"auto"},{actorId:"user",actorType:"user",trusted:true,capabilities:[]});
  equal(newer.status,"active","distinct keeps NEW active");
  equal((await f.broker.get("character.a","old"))?.status,"active","distinct keeps OLD active");

  f.service.stop();
  const g=await fixture(()=>JSON.stringify({decisions:[{candidateId:"old",relation:"uncertain"}]}));
  await g.broker.create("character.a",{id:"old",type:"fact",content:"User likes dark-blue.",source:"user",mutationPolicy:"auto"},{actorId:"user",actorType:"user",trusted:true,capabilities:[]});
  newer=await g.broker.create("character.a",{id:"new",type:"fact",content:"User prefers dark-blue.",source:"user",mutationPolicy:"auto"},{actorId:"user",actorType:"user",trusted:true,capabilities:[]});
  equal(newer.status,"active","uncertain keeps NEW active");
  equal((await g.broker.get("character.a","old"))?.status,"active","uncertain keeps OLD active");
}

async function conflictNoMutationTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[
    {candidateId:"old1",relation:"new_supersedes_candidate"},
    {candidateId:"old2",relation:"candidate_supersedes_new"}
  ]}));
  await f.broker.create("character.a",{id:"old1",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await f.broker.create("character.a",{id:"old2",type:"fact",content:"User lives in Nuremberg.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const created=await f.broker.create("character.a",{id:"new",type:"fact",content:"User likes dark-blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(created.status,"active","conflicting judge decisions perform no mutation");
  equal((await f.broker.get("character.a","old1"))?.status,"active","conflict keeps old1");
  equal((await f.broker.get("character.a","old2"))?.status,"active","conflict keeps old2");
  ok(f.diagnostics.recentErrors().some(error=>error.code==="conflicting_judge_decisions"),"conflicting decision diagnostic");
}

async function invalidJudgeOutputTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[{candidateId:"memory-999",relation:"duplicate"}]}));
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const newMemory=await f.broker.create("character.a",{id:"new",type:"fact",content:"User prefers blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(newMemory.status,"active","invalid judge id causes no mutation");
  equal((await f.broker.get("character.a","old"))?.status,"active","invalid judge id keeps candidate active");
  ok(f.diagnostics.recentErrors().some(error=>error.code==="SEMANTIC_DEDUP_FAILED"),"invalid judge id diagnostic");
}

async function plainJudgeTest(){
  const f=await fixture(()=> "old | new_supersedes_candidate");
  f.settings.semanticDedup={...f.settings.semanticDedup,judge:{...f.settings.semanticDedup.judge,outputMode:"plain"}};
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const newer=await f.broker.create("character.a",{id:"new",type:"fact",content:"User likes blue and prefers dark-blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.get("character.a","new"))?.status,"active","plain Judge output is parsed");
  equal((await f.broker.get("character.a","old"))?.status,"archived","plain Judge relation archives OLD");
  equal((await f.broker.get("character.a","old"))?.supersededBy,"new","plain Judge provenance");
}

async function malformedPlainNoMutationTest(){
  const f=await fixture(()=> "some random text");
  f.settings.semanticDedup={...f.settings.semanticDedup,judge:{...f.settings.semanticDedup.judge,outputMode:"plain"}};
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const newer=await f.broker.create("character.a",{id:"new",type:"fact",content:"User prefers blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.get("character.a","new"))?.status,"active","malformed plain output is non-mutating");
  equal((await f.broker.get("character.a","old"))?.status,"active","malformed plain output keeps candidate");
}

async function invalidEmbeddingIsBestEffortTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[{candidateId:"old",relation:"duplicate"}]}));
  const failing={...f,service:f.service};
  f.service.stop();
  const broken=await fixture(()=>JSON.stringify({decisions:[]}),()=>{throw new Error("network down")});
  const created=await broken.broker.create("character.a",{id:"new",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(created.status,"active","embedding failure never blocks canonical create");
  ok(broken.diagnostics.recentErrors().some(error=>error.code==="SEMANTIC_DEDUP_FAILED"),"embedding failure diagnostic");
  void failing;
}

async function cacheInvalidationTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[]}));
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const afterCreate=f.embeddings.calls.length;
  await f.broker.update("character.a","old",{metadata:{edited:true}},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(f.embeddings.calls.length,afterCreate,"metadata-only edit reuses content embedding");
  await f.broker.update("character.a","old",{content:"User likes dark-blue."},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  ok(f.embeddings.calls.length>afterCreate,"content edit regenerates embedding");
}

async function multipleCandidateTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[
    {candidateId:"old1",relation:"new_supersedes_candidate"},
    {candidateId:"old2",relation:"new_supersedes_candidate"},
    {candidateId:"old3",relation:"distinct"}
  ]}),text=>text.includes("aviation")?[0.6,0.8,0]:text.includes("dark-blue")?[0.98,0.2,0]:[1,0,0]);
  await f.broker.create("character.a",{id:"old1",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await f.broker.create("character.a",{id:"old2",type:"fact",content:"User prefers dark-blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await f.broker.create("character.a",{id:"old3",type:"fact",content:"User loves aviation.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const newer=await f.broker.create("character.a",{id:"new",type:"fact",content:"User likes blue and prefers dark-blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.get("character.a","new"))?.status,"active","multiple candidate superset keeps new");
  equal((await f.broker.get("character.a","old1"))?.status,"archived","multiple candidate archives first old");
  equal((await f.broker.get("character.a","old2"))?.status,"archived","multiple candidate archives second old");
  equal((await f.broker.get("character.a","old3"))?.status,"active","distinct candidate remains active");
}

async function malformedIndexRebuildTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[]}));
  await f.indexStore.save({
    apiVersion:"1",schemaVersion:"1",characterId:"character.a",
    records:[{
      memoryId:"bad",characterId:"character.a",contentHash:"h",embeddingProviderId:"fake.embeddings",embeddingModel:"fake-embedding",
      dimensions:99,vector:[1,0,0],updatedAt:"t"
    }]
  });
  await f.broker.create("character.a",{id:"good",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  ok((await f.indexStore.load("character.a"))?.records.some(record=>record.memoryId==="good"),"invalid vector record does not poison rebuild");
  ok(!(await f.indexStore.load("character.a"))?.records.some(record=>record.memoryId==="bad"),"invalid dimension record is rebuildable");
}

async function archivedRestoreLifecycleTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[]}));
  const old=await f.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await f.broker.archive("character.a",old.id,{actorId:"u",actorType:"user",trusted:true,capabilities:[]},"manual");
  equal((await f.indexStore.load("character.a"))?.records.some(r=>r.memoryId==="old")??false,false,"archive removes derived vector");
  await f.broker.restore("character.a",old.id,{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  ok((await f.indexStore.load("character.a"))?.records.some(r=>r.memoryId==="old"),"restore regenerates derived vector");
}

async function main(){
  await vectorMathTest();
  await candidateSelectionTest();
  await duplicateEventIntegrationTest();
  await supersessionIntegrationTest();
  await distinctAndUncertainTest();
  await conflictNoMutationTest();
  await invalidJudgeOutputTest();
  await plainJudgeTest();
  await malformedPlainNoMutationTest();
  await invalidEmbeddingIsBestEffortTest();
  await cacheInvalidationTest();
  await multipleCandidateTest();
  await malformedIndexRebuildTest();
  await archivedRestoreLifecycleTest();
  console.log("PASS Semantic memory deduplication tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
