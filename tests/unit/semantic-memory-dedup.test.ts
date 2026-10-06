import {
  cosineSimilarity,
  deterministicContentHash,
  isContentTokenSubset,
  MemorySemanticDeduplicator,
  parsePlainJudge,
  parseStructuredJudge,
  validateJudgeArchiveSelections,
  normalizeMemoryContentTokens,
  selectTopSemanticCandidates
} from "../../core/src";
import type {
  AppSettings,ChatRequest,ChatResponse,EmbeddingProvider,HealthStatus,MemoryItem,ProviderCapabilities
} from "../../contracts/src";
import {StandardContractValidator,defaultAppSettings,defaultModelProfile,migrateAppSettings} from "../../contracts/src";
import {ChatSessionController,ConversationSession,InMemoryAuditService,InMemoryDiagnosticsStore,InMemoryEventBus,MemoryBrokerImpl,SettingsManager} from "../../core/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src/index";
import type {HttpClient} from "../../providers/chat/openai-compatible/src/index";
import {InMemoryMemorySemanticIndexStore,InMemoryMemoryStore} from "../../host/memory/src";
import {IpcSettingsStore,InMemorySettingsStore} from "../../host/settings/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}
function throws(fn:()=>unknown,label:string){let threw=false;try{fn()}catch{threw=true}ok(threw,label)}
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
  constructor(private readonly output:(request:ChatRequest)=>string){}
  async chat(request:ChatRequest):Promise<ChatResponse>{
    this.calls.push(request);
    return {
      apiVersion:"1",schemaVersion:"1",requestId:request.requestId,
      conversationId:request.context.conversationId,providerId:"fake.judge",model:request.model,
      message:{role:"assistant",content:this.output(request)},
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
async function fixture(output:(request:ChatRequest)=>string,vectorFor?:(text:string)=>readonly number[],withEmbeddings=true){
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
    embeddingProvider:async()=>withEmbeddings?embeddings:undefined,
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

async function judgeParserProtocolTest(){
  equal(parsePlainJudge(" \n NO_ARCHIVE \n "),{archive:[]},"plain NO_ARCHIVE");
  equal(parsePlainJudge(" \n 1 \n\n 3 \n "),{archive:["1","3"]},"plain candidate positions");
  equal(parsePlainJudge(" NEW \n 1 \n "),{archive:["NEW","1"]},"plain NEW plus candidate position");
  equal(parseStructuredJudge({archive:["NEW","1","3"]}),{archive:["NEW","1","3"]},"structured archive selections");
  equal(parseStructuredJudge({archive:[]}),{archive:[]},"structured empty archive");
  throws(()=>parsePlainJudge("1, 2"),"reject comma-separated output");
  throws(()=>parsePlainJudge("Archive 1"),"reject explanation prefix");
  throws(()=>parsePlainJudge("Candidate 1"),"reject candidate prose");
  throws(()=>parsePlainJudge("I choose 1"),"reject explanation text");
  throws(()=>parsePlainJudge("1. archive"),"reject decorated number");
  throws(()=>parsePlainJudge("NO_ARCHIVE\n1"),"reject mixed NO_ARCHIVE output");
  throws(()=>parsePlainJudge("1\n1"),"reject duplicate plain selection");
  throws(()=>parsePlainJudge("NEW\nNEW"),"reject duplicate NEW");
  throws(()=>parseStructuredJudge({archive:["1","1"]}),"reject duplicate structured selection");
  throws(()=>parseStructuredJudge({archive:["candidate-1"]}),"reject non-position structured selection");
  throws(()=>validateJudgeArchiveSelections(["99"],2),"reject out-of-range candidate number");
}

async function vectorMathTest(){
  close(cosineSimilarity([1,0],[1,0]),1,"identical vector similarity");
  close(cosineSimilarity([1,0],[0,1]),0,"orthogonal vector similarity");
  equal(cosineSimilarity([1],[1,0]),undefined,"dimension mismatch");
  equal(cosineSimilarity([NaN,0],[1,0]),undefined,"NaN is invalid");
  equal(cosineSimilarity([Infinity,0],[1,0]),undefined,"Infinity is invalid");
  equal(cosineSimilarity([],[]),undefined,"empty vector is invalid");
  equal(deterministicContentHash(" User   likes blue.\n"),deterministicContentHash("User likes blue."),"content hash normalizes cache whitespace");
}

async function containmentUnitTest(){
  equal(normalizeMemoryContentTokens("Пользователь живет, в Берлине. Пользователь"),["пользователь","живет","в","берлине"],"Russian token normalization and duplicate removal");
  ok(isContentTokenSubset("Пользователь живет в Берлине.","Пользователь живет в Берлине и увлекается программированием."),"short NEW is subset of long candidate");
  ok(!isContentTokenSubset("Пользователь живет в Берлине и увлекается программированием.","Пользователь живет в Берлине."),"long record is not subset of short record");
  ok(isContentTokenSubset("Пользователь живет в Берлине.","В Берлине живет пользователь, который увлекается программированием."),"word-order differences do not break set containment");
  ok(!isContentTokenSubset("User likes blue.","User likes blue in Berlin and codes."),"one-to-three meaningful tokens never qualify as containment");
  ok(!isContentTokenSubset("User studies aviation in Berlin.","User studies programming in Berlin."),"same topic with distinct useful information is not containment");
  ok(isContentTokenSubset("User lives in Berlin. Berlin Berlin.","User lives in Berlin and codes in Berlin."),"duplicate tokens do not change containment");
}

async function candidateSelectionTest(){
  const newMemory=memory("new","User lives in Berlin and enjoys programming.");
  const containment=memory("containment","User lives in Berlin.");
  const semantic=memory("semantic","User enjoys software development and tooling today.");
  const distinct=memory("distinct","User studies aviation.");
  const vectors=new Map<string,readonly number[]>([
    ["new",[1,0,0]],["containment",[0,1,0]],["semantic",[0.9,0.43,0]],["distinct",[0,0.1,0]]
  ]);
  const selected=selectTopSemanticCandidates(newMemory,[containment,semantic,distinct,newMemory],vectors,0.88,1);
  equal(selected.map(item=>item.memory.id),["containment"],"containment candidate has priority over semantic candidate at shared candidate limit");
  ok(selected[0]?.containmentMatch===true,"selected candidate is marked as containment");
  const duplicate=selectTopSemanticCandidates(newMemory,[containment],new Map([
    ["new",[1,0,0]],["containment",[1,0,0]]
  ]),0.88,5);
  equal(duplicate.map(item=>item.memory.id),["containment"],"candidate matching cosine and containment appears once");
  equal(selectTopSemanticCandidates(newMemory,[containment,semantic],vectors,0.88,1).length,1,"existing candidate limit remains enforced");
}

async function belowThresholdContainmentReachesJudgeTest(){
  const f=await fixture(()=>JSON.stringify({archive:["1"]}),text=>text.includes("extended")?[1,0,0]:[0,1,0]);
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const newer=await f.broker.create("character.a",{id:"new",type:"fact",content:"User lives in Berlin and extended programming work.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(newer.status,"active","containment-selected NEW remains active when Judge archives candidate");
  equal((await f.broker.get("character.a","old"))?.status,"archived","below-threshold cosine plus containment still reaches Judge");
  equal(f.judge.calls.length,1,"Judge was called for containment-only candidate");
  ok(f.judge.calls[0]?.context.messages[1]?.content.includes("1. content: User lives in Berlin."),"Judge request uses the production candidate numbering format");
  ok(!f.judge.calls[0]?.context.messages[1]?.content.includes("id: old"),"Judge request does not expose real memory IDs");
  const diagnostics=JSON.stringify(f.diagnostics.recentErrors());
  ok(diagnostics.includes('"number":1')&&diagnostics.includes('"memoryId":"old"')&&diagnostics.includes('"containmentMatch":true')&&diagnostics.includes('"judgeSelections":["1"]'),"Judge diagnostics contain candidate number, real ID, containment, and selection");
  ok(diagnostics.includes('"archiveMapping"'),"Judge diagnostics contain number-to-real-ID mapping");
  ok(f.diagnostics.recentErrors().some(error=>error.code==="SEMANTIC_DEDUP_JUDGE_STARTED"),"Judge started diagnostic is emitted");
  ok(f.diagnostics.recentErrors().some(error=>error.code==="SEMANTIC_DEDUP_JUDGE_COMPLETED"),"Judge completed diagnostic is emitted");
}

async function structuredArchiveTest(){
  const f=await fixture(()=>JSON.stringify({archive:["1"]}));
  await f.broker.create("character.a",{id:"candidate",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await f.broker.create("character.a",{id:"new",type:"fact",content:"User lives in Berlin and programming.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.get("character.a","candidate"))?.status,"archived","structured candidate position archives candidate");
  equal((await f.broker.get("character.a","new"))?.status,"active","structured candidate position leaves new active");
}

async function structuredNoArchiveTest(){
  const f=await fixture(()=>JSON.stringify({archive:[]}));
  await f.broker.create("character.a",{id:"candidate",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await f.broker.create("character.a",{id:"new",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.get("character.a","candidate"))?.status,"active","empty structured archive does nothing");
  equal((await f.broker.get("character.a","new"))?.status,"active","empty structured candidate position leaves new active");
  equal(f.judge.calls.length,1,"empty structured decision is parsed");
}

async function plainArchiveTest(){
  const f=await fixture(()=> "1");
  f.settings.semanticDedup={...f.settings.semanticDedup,judge:{...f.settings.semanticDedup.judge,outputMode:"plain"}};
  await f.broker.create("character.a",{id:"candidate",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await f.broker.create("character.a",{id:"new",type:"fact",content:"User lives in Berlin and programming.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.get("character.a","candidate"))?.status,"archived","plain candidate position archives candidate");
  equal((await f.broker.get("character.a","new"))?.status,"active","plain candidate position leaves new active");
}

async function plainNoArchiveTest(){
  const f=await fixture(()=> "NO_ARCHIVE");
  f.settings.semanticDedup={...f.settings.semanticDedup,judge:{...f.settings.semanticDedup.judge,outputMode:"plain"}};
  await f.broker.create("character.a",{id:"candidate",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await f.broker.create("character.a",{id:"new",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.get("character.a","candidate"))?.status,"active","plain NO_ARCHIVE does nothing");
  equal((await f.broker.get("character.a","new"))?.status,"active","plain NO_ARCHIVE leaves new active");
  equal(f.judge.calls.length,1,"plain NO_ARCHIVE is parsed");
}

async function invalidCandidateNumberNoMutationTest(){
  const f=await fixture(()=>JSON.stringify({archive:["99"]}));
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const newer=await f.broker.create("character.a",{id:"new",type:"fact",content:"User likes blue and programming.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(newer.status,"active","invalid Judge number blocks mutation of new memory");
  equal((await f.broker.get("character.a","old"))?.status,"active","invalid Judge number keeps candidate active");
  ok(f.diagnostics.recentErrors().some(error=>error.code==="MUTATION_BLOCKED"),"invalid Judge number is diagnosed as blocked mutation");
}

async function malformedOutputNoMutationTest(){
  const f=await fixture(()=>JSON.stringify({decisions:[{candidateId:"old",relation:"duplicate"}]}));
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const newer=await f.broker.create("character.a",{id:"new",type:"fact",content:"User likes blue and programming.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(newer.status,"active","old relation structured output is rejected");
  equal((await f.broker.get("character.a","old"))?.status,"active","malformed old relation output performs no mutation");
  ok(f.diagnostics.recentErrors().some(error=>error.code==="SEMANTIC_DEDUP_FAILED"||error.code==="AGENT_STRUCTURED_SCHEMA_INVALID"),"malformed relation output is diagnosed");
}

async function allRecordsMutationBlockedTest(){
  const f=await fixture(()=>JSON.stringify({archive:["1","NEW"]}));
  await f.broker.create("character.a",{id:"old",type:"fact",content:"User likes blue.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const newer=await f.broker.create("character.a",{id:"new",type:"fact",content:"User likes blue and programming.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(newer.status,"active","Judge cannot archive every supplied record");
  equal((await f.broker.get("character.a","old"))?.status,"active","all-record archive attempt leaves candidate active");
  ok(f.diagnostics.recentErrors().some(error=>error.code==="MUTATION_BLOCKED"),"all-record archive attempt is blocked");
}

async function equalInformationTest(){
  const f=await fixture(()=>JSON.stringify({archive:["1"]}));
  await f.broker.create("character.a",{id:"candidate",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  const newer=await f.broker.create("character.a",{id:"new",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(newer.status,"active","equal information leaves the Judge-selected record active");
  equal((await f.broker.get("character.a","candidate"))?.status,"archived","equal information can archive either one by Judge choice");
  equal((await f.broker.list("character.a")).filter(item=>item.status==="active").length,1,"equal information leaves exactly one active");
}

async function subsetDirectionTest(){
  const first=await fixture(()=>JSON.stringify({archive:["NEW"]}));
  await first.broker.create("character.a",{id:"long",type:"fact",content:"User lives in Berlin and works remotely from home.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await first.broker.create("character.a",{id:"new",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await first.broker.get("character.a","new"))?.status,"archived","when NEW is a subset of candidate, NEW is archived");
  equal((await first.broker.get("character.a","long"))?.status,"active","larger candidate remains active");

  const second=await fixture(()=>JSON.stringify({archive:["1"]}));
  await second.broker.create("character.a",{id:"candidate",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await second.broker.create("character.a",{id:"new",type:"fact",content:"User lives in Berlin and works remotely from home.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await second.broker.get("character.a","candidate"))?.status,"archived","when candidate is a subset of NEW, candidate is archived");
  equal((await second.broker.get("character.a","new"))?.status,"active","larger NEW remains active");
}

async function manualLikeSequentialScenarioTest(){
  const f=await fixture(request=>{
    const input=request.context.messages[1]?.content??"";
    const lines=input.split(/\r?\n/gu);
    const newContent=lines.find(line=>line.startsWith("content: "))?.slice("content: ".length)??"";
    const candidates:ReadonlyArray<{number:string;content:string}>=lines.reduce<Array<{number:string;content:string}>>((acc,line)=>{
      const match=line.match(/^(\d+)\. content: (.*)$/u);
      if(match)acc.push({number:match[1]!,content:match[2]??""});
      return acc;
    },[]);
    const archive=candidates.flatMap(candidate=>{
      if(isContentTokenSubset(newContent,candidate.content))return ["NEW"];
      if(isContentTokenSubset(candidate.content,newContent))return [candidate.number];
      return [];
    });
    return JSON.stringify({archive});
  });
  await f.broker.create("character.a",{id:"real-memory-1",type:"fact",content:"Пользователь живет в Берлине.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.list("character.a")).filter(item=>item.status==="active").map(item=>item.id),["real-memory-1"],"after step 1 one record is active");
  await f.broker.create("character.a",{id:"real-memory-2",type:"fact",content:"Пользователь живет в Берлине и увлекается программированием.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.list("character.a")).filter(item=>item.status==="active").map(item=>item.id),["real-memory-2"],"after step 2 the more complete record is active");
  equal((await f.broker.get("character.a","real-memory-1"))?.status,"archived","after step 2 real memory 1 is archived");
  await f.broker.create("character.a",{id:"real-memory-3",type:"fact",content:"Пользователь живет в Берлине и увлекается программированием. Ему интересны IT-компании, стартапы и митапы в Берлине.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal((await f.broker.list("character.a")).filter(item=>item.status==="active").map(item=>item.id),["real-memory-3"],"after step 3 the most complete record is active");
  equal((await f.broker.get("character.a","real-memory-2"))?.status,"archived","after step 3 real memory 2 is archived");
  equal((await f.broker.get("character.a","real-memory-1"))?.status,"archived","after step 3 real memory 1 stays archived");
  ok(f.judge.calls.every(call=>call.context.messages.some(message=>message.role==="system"&&message.content===baseSettings().semanticDedup.judge.prompt)),"Fake Judge uses the production Judge prompt");
}


async function judgeModelFallsBackToPresetTest(){
  const f=await fixture(()=>JSON.stringify({archive:["1"]}));
  f.settings.semanticDedup={...f.settings.semanticDedup,judge:{...f.settings.semanticDedup.judge,model:""}};
  await f.broker.create("character.a",{id:"candidate-real-id",type:"fact",content:"User lives in Berlin.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  await f.broker.create("character.a",{id:"new-real-id",type:"fact",content:"User lives in Berlin and programming.",source:"user",mutationPolicy:"auto"},{actorId:"u",actorType:"user",trusted:true,capabilities:[]});
  equal(f.judge.calls[0]?.model,"fake-judge","Judge resolves model from configured preset when local model is blank");
  equal((await f.broker.get("character.a","candidate-real-id"))?.status,"archived","resolved Judge still applies archive mutation");
}

async function settingsV5PersistenceTest(){
  const validator=new StandardContractValidator();
  const store=new InMemorySettingsStore(validator);
  const manager=new SettingsManager(store,validator);
  await manager.initialize();
  const settings=defaultAppSettings();
  settings.memoryAgent={
    ...settings.memoryAgent,
    enabled:false,
    providerPresetId:"preset.memory",
    model:"ministral-3b-2512",
    outputMode:"plain",
    prompt:"custom prompt",
    promptBackup:"previous prompt",
    defaultPromptVersion:"7"
  };
  const migrated=migrateAppSettings(JSON.parse(JSON.stringify(settings)));
  equal(migrated.memoryAgent.providerPresetId,"preset.memory","schema v5 migration preserves provider preset");
  equal(migrated.memoryAgent.model,"ministral-3b-2512","schema v5 migration preserves model");
  equal(migrated.memoryAgent.enabled,false,"schema v5 migration preserves enabled flag");
  equal(migrated.memoryAgent.outputMode,"plain","schema v5 migration preserves output mode");
  equal(migrated.memoryAgent.prompt,"custom prompt","schema v5 migration preserves prompt");
  equal(migrated.memoryAgent.promptBackup,"previous prompt","schema v5 migration preserves prompt backup");
  equal(migrated.memoryAgent.defaultPromptVersion,"7","schema v5 migration preserves prompt version");
  await manager.set(settings);
  const reloadedManager=new SettingsManager(store,validator);
  const reloaded=await reloadedManager.initialize();
  equal(reloaded.memoryAgent.providerPresetId,"preset.memory","SettingsManager save/reload preserves provider preset");
  equal(reloaded.memoryAgent.model,"ministral-3b-2512","SettingsManager save/reload preserves model");
}

async function legacySettingsMigrationTest(){
  const migrated=migrateAppSettings({schemaVersion:"0",contextBudget:8192,recentMessages:12,memoryCandidateLimit:5,diagnosticsLevel:"debug"});
  equal(migrated.context.availableContextTokens,8192,"legacy context budget migrates");
  equal(migrated.context.recentConversationMessages,12,"legacy recent message count migrates");
  equal(migrated.memory.candidateLimit,5,"legacy memory limit migrates");
  equal(migrated.diagnostics.logLevel,"debug","legacy diagnostics level migrates");
}

// Exercise the real MemoryCreated subscriber path with containment as the only candidate source.
class FakeJudgeHttpClient implements HttpClient{
  calls:{url:string;body?:string}[]=[];
  // Emulate the existing OpenAI-compatible transport while capturing the real Judge request.
  async request(request:{url:string;method:"GET"|"POST";headers:Readonly<Record<string,string>>;body?:string;signal?:AbortSignal}):Promise<{status:number;body:string}>{
    this.calls.push({url:request.url,body:request.body});
    if(request.method==="POST"&&request.url.endsWith("/chat/completions")){
      return {
        status:200,
        body:JSON.stringify({
          id:"fake-judge-response",
          model:"fake-judge",
          choices:[{message:{role:"assistant",content:JSON.stringify({archive:["1"]})},finish_reason:"stop"}]
        })
      };
    }
    return {status:404,body:""};
  }
}

// Exercise the FoundationRuntime wiring, persistence-backed settings interface, public Memory API, provider adapter, and event lifecycle.
async function productionRuntimeSmokePathTest(){
  const validator=new StandardContractValidator();
  let persistedSettings:AppSettings|undefined;
  const settingsStore=new IpcSettingsStore(async(command,args)=>{
    if(command==="get_app_settings")return persistedSettings;
    if(command==="save_app_settings"){persistedSettings=(args as {settings:AppSettings}).settings;return undefined;}
    throw new Error("unexpected settings command: "+command);
  },validator);
  const httpClient=new FakeJudgeHttpClient();
  const judgePreset={
    presetId:"preset.judge",
    configuration:{
      apiVersion:"1",schemaVersion:"1",providerId:"openai-compatible",enabled:true,
      baseUrl:"https://judge.invalid/v1",model:"fake-judge",credentialReference:null
    }
  } as const;
  const runtime=await createFoundationRuntime({
    settingsStore,
    httpClient,
    providerPresetConfigurations:[judgePreset],
    activeProviderPresetId:"preset.judge"
  });
  const currentSettings=runtime.getSettings();
  const enabledSettings:AppSettings={
    ...currentSettings,
    semanticDedup:{
      ...currentSettings.semanticDedup,
      enabled:true,
      embeddingProviderPresetId:null,
      embeddingModel:"",
      judge:{
        ...currentSettings.semanticDedup.judge,
        enabled:true,
        providerPresetId:"preset.judge",
        model:"fake-judge",
        outputMode:"structured",
        prompt:currentSettings.semanticDedup.judge.prompt
      }
    }
  };
  const initialDiagnostics=(await runtime.diagnostics()).recentErrors;
  const initialRuntimeReady=initialDiagnostics.find(entry=>entry.code==="SEMANTIC_DEDUP_RUNTIME_READY");
  equal(initialRuntimeReady?.metadata?.semanticDedupEnabled,false,"production runtime diagnostics expose the default disabled state");
  equal(initialRuntimeReady?.metadata?.memoryCreatedSubscribers,1,"production runtime diagnostics prove one MemoryCreated subscriber");
  await runtime.start();
  const applied=await runtime.updateSettings(enabledSettings);
  equal(applied.semanticDedup.enabled,true,"runtime SettingsManager sees Semantic Dedup enabled immediately after save");
  equal(applied.semanticDedup.judge.providerPresetId,"preset.judge","runtime settings preserve Judge preset");
  equal(applied.semanticDedup.judge.model,"fake-judge","runtime settings preserve Judge model");
  equal(applied.semanticDedup.judge.outputMode,"structured","runtime settings preserve Judge output mode");
  const reloaded=new SettingsManager(settingsStore,validator);
  const persisted=await reloaded.initialize();
  equal(persisted.semanticDedup.enabled,true,"settings store round-trip preserves Semantic Dedup enabled");
  equal(persisted.semanticDedup.judge.providerPresetId,"preset.judge","settings store round-trip preserves Judge preset");

  try{
    const character=await runtime.getActiveCharacter();
    const exactDuplicateContent="Личность проживает в Берлине и увлекается программированием.";
    const oldMemory=await runtime.createMemory(character.id,{
      id:"old-real-id",originConversationId:null,type:"fact",content:exactDuplicateContent,
      tags:[],importance:70,confidence:80,validFrom:null,validUntil:null,
      source:"user",sourceReference:null,mutationPolicy:"auto",metadata:{}
    });
    const newMemory=await runtime.createMemory(character.id,{
      id:"new-real-id",originConversationId:null,type:"fact",content:exactDuplicateContent,
      tags:[],importance:70,confidence:80,validFrom:null,validUntil:null,
      source:"user",sourceReference:null,mutationPolicy:"auto",metadata:{}
    });
    equal(oldMemory.content,exactDuplicateContent,"OLD uses the required exact duplicate content");
    equal(newMemory.content,exactDuplicateContent,"NEW uses the required exact duplicate content");
    const oldAfter=await runtime.getMemory(character.id,oldMemory.id);
    const newAfter=await runtime.getMemory(character.id,newMemory.id);
    const active=await runtime.listMemory(character.id);
    equal(oldAfter?.status,"archived","FoundationRuntime production path archives OLD");
    equal(newAfter?.status,"active","FoundationRuntime production path keeps NEW active");
    equal(active.filter(item=>item.status==="active").length,1,"FoundationRuntime production path leaves one active memory");
    equal(httpClient.calls.length,1,"FoundationRuntime production path invokes Judge provider exactly once");
    const request=JSON.parse(httpClient.calls[0]?.body??"{}") as {messages?:Array<{role:string;content:string}>;model?:string;response_format?:unknown};
    equal(request.model,"fake-judge","FoundationRuntime passes configured Judge model to provider");
    ok(request.messages?.some(message=>message.role==="user"&&message.content.includes("NEW MEMORY")&&message.content.includes("content: Личность проживает в Берлине и увлекается программированием.")&&message.content.includes("1. content: Личность проживает в Берлине и увлекается программированием.")),"FoundationRuntime sends the exact duplicate content as NEW and candidate 1");
    ok(!JSON.stringify(request.messages).includes("old-real-id"),"FoundationRuntime Judge request does not expose real memory IDs");
    const persistedAfter=await runtime.listMemory(character.id);
    equal(persistedAfter.filter(item=>item.status==="active").map(item=>item.id),["new-real-id"],"FoundationRuntime canonical list confirms OLD archived and NEW active");

    const diagnostics=(await runtime.diagnostics()).recentErrors;
    const codes=diagnostics.map(entry=>entry.code);
    ok(codes.includes("SEMANTIC_DEDUP_RUNTIME_READY"),"diagnostics records semantic dedup runtime wiring");
    ok(codes.includes("SEMANTIC_DEDUP_SETTINGS_APPLIED"),"diagnostics records runtime settings after save");
    ok(codes.includes("SEMANTIC_DEDUP_EVENT_RECEIVED"),"diagnostics proves MemoryCreated reached the deduplicator");
    ok(codes.includes("SEMANTIC_DEDUP_STARTED"),"diagnostics records dedup start");
    ok(codes.includes("SEMANTIC_DEDUP_CANDIDATES_SELECTED"),"diagnostics records candidate selection");
    ok(codes.includes("SEMANTIC_DEDUP_JUDGE_STARTED"),"diagnostics records Judge start");
    ok(codes.includes("SEMANTIC_DEDUP_JUDGE_COMPLETED"),"diagnostics records Judge completion");
    ok(codes.includes("SEMANTIC_DEDUP_JUDGE_OUTPUT_PARSED"),"diagnostics records parsed Judge output");
    ok(codes.includes("SEMANTIC_DEDUP_MUTATION_APPLIED"),"diagnostics records applied mutation");
    const combined=JSON.stringify(diagnostics);
    ok(!combined.includes("Chat request failed contract validation."),"diagnostics contain no contract validation failure");
    ok(combined.includes('"containmentMatch":true'),"diagnostics record containment match");
    ok(combined.includes('"judgeSelections":["1"]'),"diagnostics record Judge selection");
    ok(combined.includes('"selection":"1"')&&combined.includes('"memoryId":"old-real-id"'),"diagnostics record number-to-real-ID mapping");
    ok(combined.includes('"mutationResult":"applied"'),"diagnostics record mutation result");
  }finally{
    await runtime.stop();
  }
}

class ChatJudgeIsolationHttpClient implements HttpClient{
  mainStreamCalls=0;
  judgeCalls=0;
  private blockMainUntilJudge=false;
  private mainStreamStartedResolver:(()=>void)|undefined;
  private judgeStartedResolver:(()=>void)|undefined;
  private mainStreamStartedPromise=new Promise<void>(resolve=>{this.mainStreamStartedResolver=resolve;});
  private judgeStartedPromise=new Promise<void>(resolve=>{this.judgeStartedResolver=resolve;});

  waitForMainStreamStart():Promise<void>{return this.mainStreamStartedPromise;}
  prepareConcurrentJudgeFailure():void{
    this.blockMainUntilJudge=true;
    this.mainStreamStartedPromise=new Promise<void>(resolve=>{this.mainStreamStartedResolver=resolve;});
    this.judgeStartedPromise=new Promise<void>(resolve=>{this.judgeStartedResolver=resolve;});
  }
  async request(request:{url:string;method:"GET"|"POST";headers:Readonly<Record<string,string>>;body?:string;signal?:AbortSignal}):Promise<{status:number;body:string}>{
    if(request.method==="POST"&&request.url.endsWith("/chat/completions")&&request.url.startsWith("https://judge.invalid/")){
      this.judgeCalls+=1;
      this.judgeStartedResolver?.();
      return {
        status:400,
        body:JSON.stringify({message:"deliberate Judge failure",type:"invalid_request",code:"judge_failure"})
      };
    }
    throw new Error("unexpected HTTP request: "+request.method+" "+request.url);
  }
  async stream(request:{url:string;method:"GET"|"POST";headers:Readonly<Record<string,string>>;body?:string;signal?:AbortSignal}):Promise<{
    status:number;
    body:AsyncIterable<string>;
  }>{
    if(request.method!=="POST"||!request.url.endsWith("/chat/completions")||!request.url.startsWith("https://main.invalid/")){
      throw new Error("unexpected streaming HTTP request: "+request.method+" "+request.url);
    }
    this.mainStreamCalls+=1;
    this.mainStreamStartedResolver?.();
    if(this.blockMainUntilJudge)await this.judgeStartedPromise;
    const body:AsyncIterable<string>={
      async *[Symbol.asyncIterator](){
        yield "data: "+JSON.stringify({id:"main-chat-response",model:"main-chat-model",choices:[{delta:{content:"ordinary chat success"},finish_reason:"stop"}]})+"\n\n";
        yield "data: [DONE]\n\n";
      }
    };
    return {status:200,body};
  }
}

function makeProductionChatController(
  runtime:Awaited<ReturnType<typeof createFoundationRuntime>>,
  characterId:string,
  providerPresetId:string,
  model:string
):ChatSessionController{
  const session=new ConversationSession("chat-regression-conversation",characterId);
  const controller=new ChatSessionController(session,{
    chat:(request,preset)=>runtime.chat(request,preset),
    stream:(request,handlers,options,preset)=>runtime.stream(request,handlers,options,preset),
    getChatModel:providerId=>runtime.getChatModel(providerId),
    getChatModelForPreset:providerPresetId=>runtime.getChatModelForPreset(providerPresetId),
    getActiveProviderPresetId:()=>runtime.getActiveProviderPresetId()
  });
  controller.setModelProfile({
    ...defaultModelProfile(characterId),
    providerPresetId,
    model,
  });
  return controller;
}

async function productionChatJudgeFailureIsolationRegressionTest(){
  const httpClient=new ChatJudgeIsolationHttpClient();
  const mainConfiguration={
    apiVersion:"1",schemaVersion:"1",providerId:"openai-compatible",enabled:true,
    baseUrl:"https://main.invalid/v1",model:"main-chat-model",credentialReference:null
  } as const;
  const judgeConfiguration={
    apiVersion:"1",schemaVersion:"1",providerId:"openai-compatible",enabled:true,
    baseUrl:"https://judge.invalid/v1",model:"judge-model",credentialReference:null
  } as const;
  const runtime=await createFoundationRuntime({
    providerConfiguration:mainConfiguration,
    httpClient,
    providerPresetConfigurations:[
      {presetId:"preset.main",configuration:mainConfiguration},
      {presetId:"preset.judge",configuration:judgeConfiguration}
    ],
    activeProviderPresetId:"preset.main"
  });
  await runtime.start();
  try{
    const character=await runtime.getActiveCharacter();
    const initialProviderConfiguration=JSON.stringify(runtime.getProviderConfiguration());
    const initialActivePresetId=runtime.getActiveProviderPresetId();
    const initialChatModel=runtime.getActiveChatModel();

    const disabledController=makeProductionChatController(runtime,character.id,"preset.main","main-chat-model");
    const disabledResult=await disabledController.submit("ordinary chat request","main-chat-model");
    equal(disabledResult.status,"sent","ordinary Chat succeeds with Semantic Dedup disabled");

    const currentSettings=runtime.getSettings();
    const enabledSettings:AppSettings={
      ...currentSettings,
      semanticDedup:{
        ...currentSettings.semanticDedup,
        enabled:true,
        embeddingProviderPresetId:null,
        embeddingModel:"",
        judge:{
          ...currentSettings.semanticDedup.judge,
          enabled:true,
          providerPresetId:"preset.judge",
          model:"judge-model",
          prompt:currentSettings.semanticDedup.judge.prompt
        }
      }
    };
    const saved=await runtime.updateSettings(enabledSettings);
    equal(saved.semanticDedup.enabled,true,"Semantic Dedup settings are saved");
    equal(saved.semanticDedup.judge.enabled,true,"Judge is enabled in saved settings");
    equal(saved.semanticDedup.judge.providerPresetId,"preset.judge","saved Judge preset remains separate");

    const enabledController=makeProductionChatController(runtime,character.id,"preset.main","main-chat-model");
    const enabledResult=await enabledController.submit("ordinary chat request","main-chat-model");
    equal(enabledResult.status,"sent","same ordinary Chat succeeds with Semantic Dedup enabled");

    equal(JSON.stringify(runtime.getProviderConfiguration()),initialProviderConfiguration,"Semantic Dedup settings do not mutate main provider configuration");
    equal(runtime.getActiveProviderPresetId(),initialActivePresetId,"Semantic Dedup settings do not mutate active provider preset");
    equal(runtime.getActiveChatModel(),initialChatModel,"Semantic Dedup settings do not mutate active Chat model");

    const oldMemory=await runtime.createMemory(character.id,{
      id:"chat-isolation-old",
      originConversationId:null,
      type:"fact",
      content:"User lives in Berlin and enjoys programming.",
      tags:[],importance:70,confidence:80,validFrom:null,validUntil:null,
      source:"user",sourceReference:null,mutationPolicy:"auto",metadata:{}
    });
    equal(oldMemory.status,"active","baseline memory remains active before concurrent regression scenario");

    httpClient.prepareConcurrentJudgeFailure();
    const concurrentController=makeProductionChatController(runtime,character.id,"preset.main","main-chat-model");
    const chatPromise=concurrentController.submit("ordinary chat request","main-chat-model");
    await httpClient.waitForMainStreamStart();

    const memoryPromise=runtime.createMemory(character.id,{
      id:"chat-isolation-new",
      originConversationId:null,
      type:"fact",
      content:"User lives in Berlin and enjoys programming.",
      tags:[],importance:70,confidence:80,validFrom:null,validUntil:null,
      source:"user",sourceReference:null,mutationPolicy:"auto",metadata:{}
    });

    const [concurrentChatResult,newMemory]=await Promise.all([chatPromise,memoryPromise]);
    equal(concurrentChatResult.status,"sent","main Chat completes while Judge deliberately fails concurrently");
    equal(newMemory.status,"active","Memory creation completes despite Judge failure");
    equal(httpClient.judgeCalls,1,"deliberate Judge failure occurs exactly once");
    equal(httpClient.mainStreamCalls,3,"all ordinary Chat requests use the main streaming path");

    const diagnostics=(await runtime.diagnostics()).recentErrors;
    ok(diagnostics.some(entry=>entry.source==="memory-semantic-deduplication"&&entry.code==="SEMANTIC_DEDUP_FAILED"),"Judge failure is recorded as semantic dedup failure");
    ok(!diagnostics.some(entry=>entry.source==="chat-session"&&entry.code==="PROVIDER_ERROR"),"Judge failure is not recorded as main Chat PROVIDER_ERROR");
    equal(JSON.stringify(runtime.getProviderConfiguration()),initialProviderConfiguration,"Judge failure does not mutate main provider configuration");
    equal(runtime.getActiveProviderPresetId(),initialActivePresetId,"Judge failure does not mutate active provider preset");
    equal(runtime.getActiveChatModel(),initialChatModel,"Judge failure does not mutate active Chat model");
    const providers=(await runtime.diagnostics()).providers.filter(provider=>provider.roles.includes("chat"));
    equal(providers.filter(provider=>provider.id==="openai-compatible").length,1,"Judge provider is not registered in the global ProviderRegistry");
    equal((await runtime.getMemory(character.id,"chat-isolation-old"))?.status,"active","failed Judge does not archive existing memory");
    equal((await runtime.getMemory(character.id,"chat-isolation-new"))?.status,"active","failed Judge does not archive new memory");
  }finally{
    await runtime.stop();
  }
}

async function main(){
  await judgeParserProtocolTest();
  await vectorMathTest();
  await containmentUnitTest();
  await candidateSelectionTest();
  await productionRuntimeSmokePathTest();
  await productionChatJudgeFailureIsolationRegressionTest();
  await belowThresholdContainmentReachesJudgeTest();
  await structuredArchiveTest();
  await structuredNoArchiveTest();
  await plainArchiveTest();
  await plainNoArchiveTest();
  await invalidCandidateNumberNoMutationTest();
  await malformedOutputNoMutationTest();
  await allRecordsMutationBlockedTest();
  await equalInformationTest();
  await subsetDirectionTest();
  await manualLikeSequentialScenarioTest();
  await judgeModelFallsBackToPresetTest();
  await settingsV5PersistenceTest();
  await legacySettingsMigrationTest();
  console.log("PASS Semantic memory deduplication and settings regression tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
