import type {
  AgentOutputMode,AppSettings,CharacterId,ChatRequest,ChatResponse,Clock,DiagnosticsStore,EmbeddingProvider,EventBus,
  MemoryBroker,MemoryItem,MemorySemanticIndexState,MemorySemanticIndexStore,MemorySemanticVectorRecord,SchemaValidator
} from "../../contracts/src/index";
import {MEMORY_SEMANTIC_INDEX_API_VERSION,MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION,STANDARD_SCHEMAS} from "../../contracts/src/index";
import {AgentOutputRunner,assertAgentCandidateId} from "./agent-output";

export const MEMORY_JUDGE_RELATIONS=[
  "duplicate",
  "new_supersedes_candidate",
  "candidate_supersedes_new",
  "distinct",
  "uncertain"
] as const;
export type MemoryJudgeRelation=typeof MEMORY_JUDGE_RELATIONS[number];

export interface MemoryJudgeDecision{candidateId:string;relation:MemoryJudgeRelation;}
export interface SemanticMemoryCandidate{memory:MemoryItem;similarity:number;}
export interface SemanticMemorySelection{
  candidates:readonly SemanticMemoryCandidate[];
  staleOrMissingRecordCount:number;
}
export interface SemanticDedupExecution{
  status:"completed"|"skipped"|"failed";
  reason?:string;
  candidateCount:number;
  candidateIds:readonly string[];
  similarityScores:Readonly<Record<string,number>>;
  configuredMode?:AgentOutputMode;
  effectiveMode?:"structured"|"plain";
  decisions?:readonly MemoryJudgeDecision[];
  mutation?:{action:"archive_new"|"archive_candidates"|"none";memoryIds:readonly string[];result:"applied"|"blocked"|"none"};
}

export interface MemorySemanticDeduplicationOptions{
  settings:()=>AppSettings;
  broker:Pick<MemoryBroker,"list"|"get"|"archive">;
  indexStore:MemorySemanticIndexStore;
  embeddingProvider:()=>Promise<EmbeddingProvider|undefined>;
  judgeRuntime:{chat(request:ChatRequest,providerPresetId?:string):Promise<ChatResponse>};
  getChatModelForPreset:(providerPresetId:string)=>Promise<string>;
  validator:SchemaValidator;
  diagnostics?:DiagnosticsStore;
  events?:EventBus;
  listCharacterIds:()=>Promise<readonly CharacterId[]>;
  clock?:Clock;
  source?:string;
}

export const DEFAULT_SEMANTIC_DEDUP_THRESHOLD=0.88;
export const DEFAULT_SEMANTIC_DEDUP_LIMIT=5;

function isFiniteVector(value:unknown):value is readonly number[]{
  return Array.isArray(value)&&value.length>0&&value.every(item=>typeof item==="number"&&Number.isFinite(item));
}
export function cosineSimilarity(vectorA:readonly number[],vectorB:readonly number[]):number|undefined{
  if(!isFiniteVector(vectorA)||!isFiniteVector(vectorB)||vectorA.length!==vectorB.length)return undefined;
  let dot=0;
  let normA=0;
  let normB=0;
  for(let i=0;i<vectorA.length;i++){
    const a=vectorA[i]!;
    const b=vectorB[i]!;
    dot+=a*b;
    normA+=a*a;
    normB+=b*b;
  }
  if(!Number.isFinite(dot)||!Number.isFinite(normA)||!Number.isFinite(normB)||normA<=0||normB<=0)return undefined;
  const result=dot/(Math.sqrt(normA)*Math.sqrt(normB));
  return Number.isFinite(result)?Math.min(1,Math.max(-1,result)):undefined;
}

export function normalizeMemoryContentForHash(content:string):string{
  return content.normalize("NFKC").replace(/\s+/gu," ").trim();
}

export function deterministicContentHash(content:string):string{
  const normalized=normalizeMemoryContentForHash(content);
  let hash=14695981039346656037n;
  const prime=1099511628211n;
  const mask=18446744073709551615n;
  for(let i=0;i<normalized.length;i++){
    hash=(hash^BigInt(normalized.charCodeAt(i)))*prime&mask;
  }
  return hash.toString(16).padStart(16,"0");
}

export function compareSemanticCandidates(a:SemanticMemoryCandidate,b:SemanticMemoryCandidate):number{
  return b.similarity-a.similarity||a.memory.id.localeCompare(b.memory.id);
}

export function selectTopSemanticCandidates(
  newMemory:MemoryItem,
  memories:readonly MemoryItem[],
  vectors:ReadonlyMap<string,readonly number[]>,
  threshold:number,
  limit:number
):SemanticMemoryCandidate[]{
  const nextLimit=Math.max(0,Math.floor(limit));
  if(nextLimit===0)return [];
  const result:SemanticMemoryCandidate[]=[];
  const newVector=vectors.get(newMemory.id);
  if(!newVector)return [];
  for(const memory of memories){
    if(memory.id===newMemory.id||memory.characterId!==newMemory.characterId||memory.status!=="active")continue;
    const candidateVector=vectors.get(memory.id);
    if(!candidateVector)continue;
    const similarity=cosineSimilarity(newVector,candidateVector);
    if(similarity===undefined||similarity<threshold)continue;
    result.push({memory,similarity});
  }
  result.sort(compareSemanticCandidates);
  return result.slice(0,nextLimit);
}

function safeText(value:string):string{
  return value
    .replace(/authorization\s*:\s*bearer\s+\S+/gi,"Authorization: Bearer [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._-]{16,}\b/gi,"Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gi,"[REDACTED]")
    .replace(/api[_ -]?key\s*[:=]\s*\S+/gi,"api-key=[REDACTED]")
    .replace(/password\s*[:=]\s*\S+/gi,"password=[REDACTED]")
    .replace(/secret\s*[:=]\s*\S+/gi,"secret=[REDACTED]");
}

function parseStructuredJudge(value:unknown):{decisions:MemoryJudgeDecision[]}|never{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Memory Judge structured response is not an object.");
  const decisions=(value as Record<string,unknown>).decisions;
  if(!Array.isArray(decisions))throw new Error("Memory Judge structured response is missing decisions.");
  const parsed:MemoryJudgeDecision[]=[];
  const seen=new Set<string>();
  for(const item of decisions){
    if(!item||typeof item!=="object"||Array.isArray(item))throw new Error("Memory Judge decision is invalid.");
    const candidateId=(item as Record<string,unknown>).candidateId;
    const relation=(item as Record<string,unknown>).relation;
    if(typeof candidateId!=="string"||!candidateId.trim())throw new Error("Memory Judge candidateId is invalid.");
    if(!MEMORY_JUDGE_RELATIONS.includes(relation as MemoryJudgeRelation))throw new Error("Memory Judge relation is invalid.");
    const id=candidateId.trim();
    if(seen.has(id))throw new Error("Memory Judge returned duplicate candidate ids.");
    seen.add(id);
    parsed.push({candidateId:id,relation:relation as MemoryJudgeRelation});
  }
  return {decisions:parsed};
}

function parsePlainJudge(content:string):{decisions:MemoryJudgeDecision[]}|never{
  const trimmed=content.trim();
  if(!trimmed||trimmed.toLocaleUpperCase()==="NO_ARCHIVE")return {decisions:[]};
  const lines=trimmed.split(/\r?\n/gu).map(line=>line.trim()).filter(Boolean);
  const parsed:MemoryJudgeDecision[]=[];
  const seen=new Set<string>();
  for(const line of lines){
    const parts=line.split("|");
    if(parts.length!==2)throw new Error("Memory Judge plain response must use 'candidateId | relation' lines.");
    const candidateId=parts[0]!.trim();
    const relation=parts[1]!.trim();
    if(!candidateId||!MEMORY_JUDGE_RELATIONS.includes(relation as MemoryJudgeRelation))throw new Error("Memory Judge plain response contains an invalid decision.");
    if(seen.has(candidateId))throw new Error("Memory Judge returned duplicate candidate ids.");
    seen.add(candidateId);
    parsed.push({candidateId,relation:relation as MemoryJudgeRelation});
  }
  return {decisions:parsed};
}

function redactJudgeInput(value:string):string{return safeText(value);}

function buildJudgeInput(newMemory:MemoryItem,candidates:readonly SemanticMemoryCandidate[]):string{
  return [
    "NEW MEMORY",
    "id: "+safeText(newMemory.id),
    "content: "+redactJudgeInput(newMemory.content),
    "",
    "CANDIDATES",
    ...candidates.map(candidate=>[
      "candidateId: "+safeText(candidate.memory.id),
      "content: "+redactJudgeInput(candidate.memory.content)
    ].join("\n\n"))
  ].join("\n");
}

function validateCandidateDecisions(
  decisions:readonly MemoryJudgeDecision[],
  allowedIds:readonly string[]
):void{
  const allowed=new Set(allowedIds);
  for(const decision of decisions)assertAgentCandidateId(decision.candidateId,allowed);
  if(decisions.length===0)return;
  if(decisions.length!==allowedIds.length)throw new Error("Memory Judge must decide every supplied candidate or return NO_ARCHIVE.");
  const actual=new Set(decisions.map(decision=>decision.candidateId));
  if(actual.size!==allowedIds.length||allowedIds.some(id=>!actual.has(id)))throw new Error("Memory Judge candidate decisions do not exactly match the supplied candidate ids.");
}

function aggregateDecisions(decisions:readonly MemoryJudgeDecision[]):{action:"archive_new"|"archive_candidates"|"none";ids:string[];reason?:string}{
  const hasArchiveNew=decisions.some(item=>item.relation==="duplicate"||item.relation==="candidate_supersedes_new");
  const oldIds=decisions.filter(item=>item.relation==="new_supersedes_candidate").map(item=>item.candidateId);
  if(hasArchiveNew&&oldIds.length>0)return {action:"none",ids:[],reason:"conflicting_judge_decisions"};
  if(hasArchiveNew)return {action:"archive_new",ids:[]};
  if(oldIds.length>0)return {action:"archive_candidates",ids:[...oldIds]};
  return {action:"none",ids:[]};
}

function validIndexState(state:MemorySemanticIndexState|undefined,characterId:CharacterId):MemorySemanticIndexState{
  const empty={
    apiVersion:MEMORY_SEMANTIC_INDEX_API_VERSION,
    schemaVersion:MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION,
    characterId,
    records:[]
  };
  if(!state||state.apiVersion!==MEMORY_SEMANTIC_INDEX_API_VERSION||state.schemaVersion!==MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION||state.characterId!==characterId||!characterId.trim())return empty;
  const records:MemorySemanticVectorRecord[]=[];
  const ids=new Set<string>();
  for(const record of state.records){
    if(ids.has(record.memoryId))continue;
    if(!record.characterId||record.characterId!==characterId||!record.memoryId.trim()||!record.contentHash||!record.embeddingProviderId||!record.embeddingModel||!record.updatedAt)continue;
    if(!Number.isInteger(record.dimensions)||record.dimensions<=0||!isFiniteVector(record.vector)||record.vector.length!==record.dimensions)continue;
    ids.add(record.memoryId);
    records.push({...record,vector:[...record.vector]});
  }
  records.sort((a,b)=>a.memoryId.localeCompare(b.memoryId));
  return {apiVersion:MEMORY_SEMANTIC_INDEX_API_VERSION,schemaVersion:MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION,characterId,records};
}

export class MemorySemanticDeduplicator{
  private readonly outputRunner:AgentOutputRunner;
  private readonly unsubs:(()=>void)[]=[];
  private readonly inFlight=new Set<string>();
  constructor(private readonly options:MemorySemanticDeduplicationOptions){
    this.outputRunner=new AgentOutputRunner(options.judgeRuntime,options.validator);
  }

  start():void{
    if(!this.options.events)return;
    this.unsubs.push(this.options.events.subscribe<{characterId:string;memoryId:string}>("MemoryCreated",event=>this.onMemoryCreated(event.payload)));
    this.unsubs.push(this.options.events.subscribe<{characterId:string;memoryId:string}>("MemoryUpdated",event=>this.onMemoryUpdated(event.payload)));
    this.unsubs.push(this.options.events.subscribe<{characterId:string;memoryId:string}>("MemoryArchived",event=>this.onMemoryArchived(event.payload)));
    this.unsubs.push(this.options.events.subscribe<{characterId:string;memoryId:string}>("MemoryRestored",event=>this.onMemoryRestored(event.payload)));
    this.unsubs.push(this.options.events.subscribe<{characterId:string;memoryId:string}>("MemoryDeleted",event=>this.onMemoryDeleted(event.payload)));
    this.unsubs.push(this.options.events.subscribe<{characterId:string;memoryId:string;previousMemoryId:string}>("MemorySuperseded",event=>this.onMemorySuperseded(event.payload)));
  }

  stop():void{while(this.unsubs.length)this.unsubs.pop()!();this.inFlight.clear();}

  async rebuildAll():Promise<void>{
    for(const characterId of await this.options.listCharacterIds())await this.rebuildCharacter(characterId);
  }

  async rebuildCharacter(characterId:CharacterId):Promise<void>{
    const settings=this.options.settings();
    if(!settings.semanticDedup.enabled)return;
    try{
      const provider=await this.options.embeddingProvider();
      const model=settings.semanticDedup.embeddingModel.trim();
      if(!provider||!model)return;
      const memories=await this.options.broker.list(characterId);
      await this.reconcileIndex(characterId,memories,provider,model);
    }catch(error){
      this.recordFailure("INDEX_REBUILD_FAILED",error,characterId);
    }
  }

  async deduplicateMemory(memoryId:string,characterId:CharacterId):Promise<SemanticDedupExecution>{
    const key=characterId+"\0"+memoryId;
    if(this.inFlight.has(key))return {status:"skipped",reason:"deduplication_already_in_flight",candidateCount:0,candidateIds:[],similarityScores:{}};
    this.inFlight.add(key);
    try{
      const settings=this.options.settings();
      if(!settings.semanticDedup.enabled)return {status:"skipped",reason:"semantic_deduplication_disabled",candidateCount:0,candidateIds:[],similarityScores:{}};
      const provider=await this.options.embeddingProvider();
      const model=settings.semanticDedup.embeddingModel.trim();
      if(!provider)return this.skip("embedding_provider_not_configured",characterId);
      if(!model)return this.skip("embedding_model_not_configured",characterId);
      const newMemory=await this.options.broker.get(characterId,memoryId);
      if(!newMemory)return this.skip("new_memory_not_found",characterId);
      if(newMemory.status!=="active")return this.skip("new_memory_not_active",characterId);
      const memories=await this.options.broker.list(characterId);
      const {vectors,staleOrMissing}=await this.ensureVectors(characterId,memories,provider,model,newMemory);
      const selected=selectTopSemanticCandidates(
        newMemory,
        memories,
        vectors,
        settings.semanticDedup.candidateSimilarityThreshold,
        settings.semanticDedup.candidateLimit
      );
      const scores=Object.fromEntries(selected.map(candidate=>[candidate.memory.id,candidate.similarity]));
      this.recordDiagnostic("SEMANTIC_DEDUP_STARTED","semantic deduplication candidate scan",{
        characterId,embeddingProvider:provider.id,embeddingModel:model,candidateCount:selected.length,candidateIds:selected.map(item=>item.memory.id),similarityScores:scores,
        staleOrMissingRecordCount:staleOrMissing,threshold:settings.semanticDedup.candidateSimilarityThreshold,candidateLimit:settings.semanticDedup.candidateLimit
      });
      if(selected.length===0)return {status:"completed",candidateCount:0,candidateIds:[],similarityScores:scores};
      const judge=this.options.settings().semanticDedup.judge;
      if(!judge.enabled)return this.skip("memory_judge_disabled",characterId,selected,scores);
      const presetId=judge.providerPresetId?.trim()??"";
      if(!presetId)return this.skip("memory_judge_provider_not_configured",characterId,selected,scores);
      const modelName=judge.model.trim();
      if(!modelName)return this.skip("memory_judge_model_not_configured",characterId,selected,scores);
      const chatRequest:ChatRequest={
        apiVersion:"1",
        schemaVersion:"1",
        requestId:"memory-judge:"+memoryId,
        model:modelName,
        context:{
          conversationId:"memory-judge:"+memoryId,
          messages:[
            {role:"system",content:judge.prompt.trim()},
            {role:"user",content:buildJudgeInput(newMemory,selected)}
          ]
        }
      };
      const schema=STANDARD_SCHEMAS["memory-judge-decision"]!;
      const execution=await this.outputRunner.run({
        outputMode:judge.outputMode,
        request:chatRequest,
        providerPresetId:presetId,
        schemaName:"memory-judge-decision",
        schema,
        validator:this.options.validator,
        parseStructured:parseStructuredJudge,
        parsePlain:parsePlainJudge,
        diagnostics:this.options.diagnostics,
        source:this.options.source??"memory-semantic-deduplication"
      });
      const decisions=execution.value.decisions;
      validateCandidateDecisions(decisions,selected.map(candidate=>candidate.memory.id));
      const plan=aggregateDecisions(decisions);
      this.recordDiagnostic("SEMANTIC_DEDUP_JUDGE_RESULT","memory judge result",{
        characterId,
        embeddingProvider:provider.id,
        embeddingModel:model,
        candidateCount:selected.length,
        candidateIds:selected.map(item=>item.memory.id),
        similarityScores:scores,
        judgeProvider:execution.response.providerId,
        judgeModel:execution.response.model,
        configuredMode:judge.outputMode,
        effectiveMode:execution.metadata.effectiveOutputMode,
        decisions,
        mutationPlan:plan
      });
      if(plan.reason){
        this.recordFailure("conflicting_judge_decisions",plan.reason,characterId,{decisions});
        return {status:"completed",reason:plan.reason,candidateCount:selected.length,candidateIds:selected.map(item=>item.memory.id),similarityScores:scores,configuredMode:judge.outputMode,effectiveMode:execution.metadata.effectiveOutputMode,decisions,mutation:{action:"none",memoryIds:[],result:"none"}};
      }
      if(plan.action==="none")return {status:"completed",candidateCount:selected.length,candidateIds:selected.map(item=>item.memory.id),similarityScores:scores,configuredMode:judge.outputMode,effectiveMode:execution.metadata.effectiveOutputMode,decisions,mutation:{action:"none",memoryIds:[],result:"none"}};
      const freshNew=await this.options.broker.get(characterId,memoryId);
      if(!freshNew||freshNew.status!=="active")return this.skip("canonical_new_memory_changed_before_mutation",characterId,selected,scores);
      const authority={
        actorId:"memory-semantic-deduplication",
        actorType:"system" as const,
        trusted:true,
        capabilities:["memory.write.auto","memory.write.suggest.apply","memory.archive.semantic"],
        moduleId:"memory-semantic-deduplication"
      };
      if(plan.action==="archive_new"){
        try{
          await this.options.broker.archive(characterId,memoryId,authority,"duplicate");
          return {status:"completed",candidateCount:selected.length,candidateIds:selected.map(item=>item.memory.id),similarityScores:scores,configuredMode:judge.outputMode,effectiveMode:execution.metadata.effectiveOutputMode,decisions,mutation:{action:"archive_new",memoryIds:[memoryId],result:"applied"}};
        }catch(error){
          this.recordFailure("MUTATION_BLOCKED",error,characterId,{memoryId,action:"archive_new",reason:"duplicate"});
          return {status:"completed",reason:"mutation_blocked",candidateCount:selected.length,candidateIds:selected.map(item=>item.memory.id),similarityScores:scores,configuredMode:judge.outputMode,effectiveMode:execution.metadata.effectiveOutputMode,decisions,mutation:{action:"archive_new",memoryIds:[memoryId],result:"blocked"}};
        }
      }
      const freshCandidates:MemoryItem[]=[];
      for(const candidateId of plan.ids){
        const candidate=await this.options.broker.get(characterId,candidateId);
        if(!candidate||candidate.status!=="active"){
          this.recordFailure("MUTATION_BLOCKED","Semantic Judge candidate changed or is no longer active.",characterId,{candidateId});
          return {status:"completed",reason:"canonical_candidate_changed_before_mutation",candidateCount:selected.length,candidateIds:selected.map(item=>item.memory.id),similarityScores:scores,configuredMode:judge.outputMode,effectiveMode:execution.metadata.effectiveOutputMode,decisions,mutation:{action:"archive_candidates",memoryIds:plan.ids,result:"blocked"}};
        }
        freshCandidates.push(candidate);
      }
      try{
        for(const candidate of freshCandidates){
          await this.options.broker.archive(characterId,candidate.id,authority,"superseded",memoryId);
        }
        return {status:"completed",candidateCount:selected.length,candidateIds:selected.map(item=>item.memory.id),similarityScores:scores,configuredMode:judge.outputMode,effectiveMode:execution.metadata.effectiveOutputMode,decisions,mutation:{action:"archive_candidates",memoryIds:freshCandidates.map(item=>item.id),result:"applied"}};
      }catch(error){
        this.recordFailure("MUTATION_BLOCKED",error,characterId,{candidateIds:plan.ids,action:"archive_candidates"});
        return {status:"completed",reason:"mutation_blocked",candidateCount:selected.length,candidateIds:selected.map(item=>item.memory.id),similarityScores:scores,configuredMode:judge.outputMode,effectiveMode:execution.metadata.effectiveOutputMode,decisions,mutation:{action:"archive_candidates",memoryIds:plan.ids,result:"blocked"}};
      }
    }catch(error){
      this.recordFailure("SEMANTIC_DEDUP_FAILED",error,characterId,{memoryId});
      return {status:"failed",reason:error instanceof Error?error.message:String(error),candidateCount:0,candidateIds:[],similarityScores:{}};
    }finally{
      this.inFlight.delete(key);
    }
  }

  private async ensureVectors(
    characterId:CharacterId,
    memories:readonly MemoryItem[],
    provider:EmbeddingProvider,
    model:string,
    newMemory:MemoryItem
  ):Promise<{vectors:Map<string,readonly number[]>;staleOrMissing:number}>{
    const state=validIndexState(await this.options.indexStore.load(characterId),characterId);
    const active=memories.filter(memory=>memory.characterId===characterId&&memory.status==="active");
    const existing=new Map(state.records.map(record=>[record.memoryId,record] as const));
    const newHash=deterministicContentHash(newMemory.content);
    let newRecord=existing.get(newMemory.id);
    let newVector:readonly number[];
    const cachedNewIsValid=Boolean(
      newRecord
      &&newRecord.characterId===characterId
      &&newRecord.contentHash===newHash
      &&newRecord.embeddingProviderId===provider.id
      &&newRecord.embeddingModel===model
      &&isFiniteVector(newRecord.vector)
      &&newRecord.dimensions===newRecord.vector.length
    );
    if(cachedNewIsValid)newVector=newRecord!.vector;
    else{
      const vectors=await provider.embed([newMemory.content]);
      if(vectors.length!==1||!isFiniteVector(vectors[0]))throw new Error("Embedding provider returned an invalid new-memory vector.");
      newVector=vectors[0]!;
      const now=this.options.clock?.now()??new Date().toISOString();
      newRecord=makeIndexRecord(newMemory,provider,model,newVector,now);
    }
    const expectedDimensions=newVector.length;
    const stale=active.filter(memory=>{
      if(memory.id===newMemory.id)return false;
      const record=existing.get(memory.id);
      return !record
        ||record.characterId!==characterId
        ||record.contentHash!==deterministicContentHash(memory.content)
        ||record.embeddingProviderId!==provider.id
        ||record.embeddingModel!==model
        ||!isFiniteVector(record.vector)
        ||record.dimensions!==record.vector.length
        ||record.dimensions!==expectedDimensions;
    });
    const records=new Map<string,MemorySemanticVectorRecord>();
    if(newRecord)records.set(newMemory.id,newRecord);
    for(const memory of active){
      if(memory.id===newMemory.id)continue;
      const record=existing.get(memory.id);
      if(record
        &&record.characterId===characterId
        &&record.contentHash===deterministicContentHash(memory.content)
        &&record.embeddingProviderId===provider.id
        &&record.embeddingModel===model
        &&isFiniteVector(record.vector)
        &&record.dimensions===record.vector.length
        &&record.dimensions===expectedDimensions
      )records.set(memory.id,record);
    }
    if(stale.length>0){
      const vectors=await provider.embed(stale.map(memory=>memory.content));
      if(vectors.length!==stale.length||vectors.some(vector=>!isFiniteVector(vector)||vector.length!==expectedDimensions))throw new Error("Embedding provider returned inconsistent cached vector dimensions.");
      const now=this.options.clock?.now()??new Date().toISOString();
      for(let i=0;i<stale.length;i++)records.set(stale[i]!.id,makeIndexRecord(stale[i]!,provider,model,vectors[i]!,now));
    }
    const nextState:MemorySemanticIndexState={
      apiVersion:MEMORY_SEMANTIC_INDEX_API_VERSION,
      schemaVersion:MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION,
      characterId,
      records:[...records.values()].sort((a,b)=>a.memoryId.localeCompare(b.memoryId))
    };
    await this.options.indexStore.save(nextState);
    return {vectors:new Map(nextState.records.map(record=>[record.memoryId,record.vector] as const)),staleOrMissing:stale.length+(cachedNewIsValid?0:1)};
  }

  private async reconcileIndex(characterId:CharacterId,memories:readonly MemoryItem[],provider:EmbeddingProvider,model:string):Promise<void>{
    const active=memories.filter(memory=>memory.characterId===characterId&&memory.status==="active");
    const state=validIndexState(await this.options.indexStore.load(characterId),characterId);
    const existing=new Map(state.records.map(record=>[record.memoryId,record] as const));
    const firstValid=active.map(memory=>existing.get(memory.id)).find(record=>Boolean(record&&record.embeddingProviderId===provider.id&&record.embeddingModel===model&&isFiniteVector(record.vector)&&record.dimensions===record.vector.length));
    const expectedDimensions=firstValid?.dimensions;
    const stale=active.filter(memory=>{
      const record=existing.get(memory.id);
      return !record
        ||record.contentHash!==deterministicContentHash(memory.content)
        ||record.embeddingProviderId!==provider.id
        ||record.embeddingModel!==model
        ||!isFiniteVector(record.vector)
        ||record.dimensions!==record.vector.length
        ||(expectedDimensions!==undefined&&record.dimensions!==expectedDimensions);
    });
    const keep=active.filter(memory=>{
      const record=existing.get(memory.id);
      return Boolean(record
        &&record.contentHash===deterministicContentHash(memory.content)
        &&record.embeddingProviderId===provider.id
        &&record.embeddingModel===model
        &&isFiniteVector(record.vector)
        &&record.dimensions===record.vector.length
        &&(expectedDimensions===undefined||record.dimensions===expectedDimensions));
    }).map(memory=>existing.get(memory.id)!);
    let records=[...keep];
    if(stale.length>0){
      const vectors=await provider.embed(stale.map(memory=>memory.content));
      if(vectors.length!==stale.length||vectors.some(vector=>!isFiniteVector(vector)))throw new Error("Embedding provider returned invalid vectors during rebuild.");
      const dimensions=vectors[0]?.length??expectedDimensions??0;
      if(dimensions<=0||vectors.some(vector=>vector.length!==dimensions))throw new Error("Embedding provider returned inconsistent vector dimensions during rebuild.");
      const now=this.options.clock?.now()??new Date().toISOString();
      for(let i=0;i<stale.length;i++)records.push(makeIndexRecord(stale[i]!,provider,model,vectors[i]!,now));
    }
    await this.options.indexStore.save({
      apiVersion:MEMORY_SEMANTIC_INDEX_API_VERSION,
      schemaVersion:MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION,
      characterId,
      records:records.sort((a,b)=>a.memoryId.localeCompare(b.memoryId))
    });
  }

  private async onMemoryCreated(payload:{characterId:string;memoryId:string}):Promise<void>{
    await this.deduplicateMemory(payload.memoryId,payload.characterId);
  }
  private async onMemoryUpdated(payload:{characterId:string;memoryId:string}):Promise<void>{
    const settings=this.options.settings();
    if(!settings.semanticDedup.enabled)return;
    try{
      const memory=await this.options.broker.get(payload.characterId,payload.memoryId);
      if(!memory)return;
      const provider=await this.options.embeddingProvider();
      const model=settings.semanticDedup.embeddingModel.trim();
      if(!provider||!model)return;
      const memories=await this.options.broker.list(payload.characterId);
      await this.reconcileIndex(payload.characterId,memories,provider,model);
    }catch(error){this.recordFailure("EMBEDDING_REGENERATION_FAILED",error,payload.characterId,{memoryId:payload.memoryId});}
  }
  private async onMemoryArchived(payload:{characterId:string;memoryId:string}):Promise<void>{
    await this.removeIndexRecord(payload.characterId,payload.memoryId);
  }
  private async onMemoryRestored(payload:{characterId:string;memoryId:string}):Promise<void>{
    const settings=this.options.settings();
    if(!settings.semanticDedup.enabled)return;
    try{
      const provider=await this.options.embeddingProvider();
      const model=settings.semanticDedup.embeddingModel.trim();
      if(!provider||!model)return;
      const memories=await this.options.broker.list(payload.characterId);
      await this.reconcileIndex(payload.characterId,memories,provider,model);
    }catch(error){this.recordFailure("EMBEDDING_RESTORE_FAILED",error,payload.characterId,{memoryId:payload.memoryId});}
  }
  private async onMemoryDeleted(payload:{characterId:string;memoryId:string}):Promise<void>{
    await this.removeIndexRecord(payload.characterId,payload.memoryId);
  }
  private async onMemorySuperseded(payload:{characterId:string;previousMemoryId:string;memoryId:string}):Promise<void>{
    await this.removeIndexRecord(payload.characterId,payload.previousMemoryId);
    await this.onMemoryRestored({characterId:payload.characterId,memoryId:payload.memoryId});
  }
  private async removeIndexRecord(characterId:CharacterId,memoryId:string):Promise<void>{
    try{
      const current=validIndexState(await this.options.indexStore.load(characterId),characterId);
      const records=current.records.filter(record=>record.memoryId!==memoryId);
      if(records.length===current.records.length)return;
      await this.options.indexStore.save({...current,records});
    }catch(error){this.recordFailure("DERIVED_INDEX_CLEANUP_FAILED",error,characterId,{memoryId});}
  }

  private skip(reason:string,characterId:CharacterId,candidates?:readonly SemanticMemoryCandidate[],scores?:Readonly<Record<string,number>>):SemanticDedupExecution{
    return {
      status:"skipped",reason,candidateCount:candidates?.length??0,
      candidateIds:candidates?.map(item=>item.memory.id)??[],similarityScores:scores??{}
    };
  }

  private recordDiagnostic(code:string,message:string,metadata:Record<string,unknown>):void{
    this.options.diagnostics?.recordError(this.options.source??"memory-semantic-deduplication",code,message,metadata);
  }
  private recordFailure(code:string,error:unknown,characterId:CharacterId,metadata?:Record<string,unknown>):void{
    const message=error instanceof Error?error.message:String(error);
    this.options.diagnostics?.recordError(this.options.source??"memory-semantic-deduplication",code,message,{characterId,...metadata});
  }
}
