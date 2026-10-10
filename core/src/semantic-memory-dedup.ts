import {resolvePromptText} from "../../contracts/src";
import type {
  AgentOutputMode,AppSettings,CharacterId,ChatRequest,ChatResponse,Clock,DiagnosticsStore,EmbeddingProvider,EventBus,
  MemoryBroker,MemoryItem,MemorySemanticIndexState,MemorySemanticIndexStore,MemorySemanticVectorRecord,SchemaValidator,JsonSchema
} from "../../contracts/src/index";
import {MEMORY_SEMANTIC_INDEX_API_VERSION,MEMORY_SEMANTIC_INDEX_SCHEMA_VERSION,STANDARD_SCHEMAS} from "../../contracts/src/index";
import {AgentOutputRunner} from "./agent-output";
import {SEMANTIC_SEARCH_RECORD_PREFIX,replaceMemorySemanticIndexPartition,withMemorySemanticIndexLock} from "./semantic-index-lock";

export interface SemanticMemoryCandidate{
  memory:MemoryItem;
  similarity:number;
  containmentMatch:boolean;
}
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
  archiveIds?:readonly string[];
  mutation?:{archiveIds:readonly string[];result:"applied"|"blocked"|"none"};
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

/** Normalize text into deterministic meaningful Unicode tokens before comparing content sets. */
export function normalizeMemoryContentTokens(content:string):readonly string[]{
  const normalized=content.normalize("NFKC").toLowerCase();
  // Unicode letters/numbers preserve Russian and English words while punctuation becomes a separator.
  const tokens=normalized.match(/[\p{L}\p{N}]+/gu)??[];
  return [...new Set(tokens)];
}

/** Check content containment using unique token sets; fewer than four meaningful tokens never qualify as a subset. */
export function isContentTokenSubset(subset:string,container:string):boolean{
  const subsetTokens=normalizeMemoryContentTokens(subset);
  if(subsetTokens.length<4)return false;
  const containerTokens=new Set(normalizeMemoryContentTokens(container));
  return subsetTokens.every(token=>containerTokens.has(token));
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

/** Stable ordering makes containment candidates consume the existing shared candidate limit first. */
export function compareSemanticCandidates(a:SemanticMemoryCandidate,b:SemanticMemoryCandidate):number{
  return Number(b.containmentMatch)-Number(a.containmentMatch)||b.similarity-a.similarity||a.memory.id.localeCompare(b.memory.id);
}

/** Select candidates by cosine OR bidirectional containment; containment only affects candidate selection and never archives directly. */
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
  for(const memory of memories){
    if(memory.id===newMemory.id||memory.characterId!==newMemory.characterId||memory.status!=="active")continue;
    const candidateVector=vectors.get(memory.id);
    const similarity=candidateVector&&newVector?cosineSimilarity(newVector,candidateVector):undefined;
    const semanticMatch=similarity!==undefined&&similarity>=threshold;
    const containmentMatch=isContentTokenSubset(newMemory.content,memory.content)||isContentTokenSubset(memory.content,newMemory.content);
    if(!semanticMatch&&!containmentMatch)continue;
    result.push({memory,similarity:similarity??0,containmentMatch});
  }
  result.sort(compareSemanticCandidates);
  return result.slice(0,nextLimit);
}

const MEMORY_JUDGE_PROVIDER_SCHEMA:JsonSchema={
  type:"object",
  additionalProperties:false,
  required:["archive"],
  properties:{
    archive:{
      type:"array",
      items:{type:"string"}
    }
  }
};

const PROVIDER_FAILURE_DETAIL_KEYS=["providerId","providerPresetId","model","baseUrlHost","chatTransport","httpStatus","durationMs","category","timeoutMs","providerResponse"] as const;

function extractProviderFailureDetails(error:unknown):Record<string,unknown>|undefined{
  if(!error||typeof error!=="object")return undefined;
  const record=error as Record<string,unknown>;
  const chatError=record.chatError;
  const source=chatError&&typeof chatError==="object"&&!Array.isArray(chatError)
    ?chatError as Record<string,unknown>
    :record;
  const details=source.details;
  if(!details||typeof details!=="object"||Array.isArray(details))return undefined;
  const safe:Record<string,unknown>={};
  const detailRecord=details as Record<string,unknown>;
  for(const key of PROVIDER_FAILURE_DETAIL_KEYS){
    if(detailRecord[key]!==undefined)safe[key]=detailRecord[key];
  }
  return Object.keys(safe).length>0?safe:undefined;
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

/** Parse the structured Judge contract: archive contains only NEW or candidate position strings. */
export function parseStructuredJudge(value:unknown):{archive:string[]}{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Memory Judge structured response is not an object.");
  const archive=(value as Record<string,unknown>).archive;
  if(!Array.isArray(archive))throw new Error("Memory Judge structured response is missing archive.");
  const parsed:string[]=[];
  const seen=new Set<string>();
  for(const item of archive){
    if(typeof item!=="string")throw new Error("Memory Judge archive selection is invalid.");
    const selection=item.trim();
    if(selection!=="NEW"&&!/^[1-9]\d*$/u.test(selection))throw new Error("Memory Judge archive selection is invalid.");
    if(seen.has(selection))throw new Error("Memory Judge returned duplicate archive selections.");
    seen.add(selection);
    parsed.push(selection);
  }
  return {archive:parsed};
}

/** Parse only NO_ARCHIVE or one NEW/candidate position per non-empty line; all other prose is rejected. */
export function parsePlainJudge(content:string):{archive:string[]}{
  const lines=content.split(/\r?\n/gu).map(line=>line.trim()).filter(Boolean);
  if(lines.length===0)throw new Error("Memory Judge plain response is empty.");
  if(lines.length===1&&lines[0]==="NO_ARCHIVE")return {archive:[]};
  const parsed:string[]=[];
  const seen=new Set<string>();
  for(const selection of lines){
    if(selection==="NO_ARCHIVE"||selection==="")throw new Error("Memory Judge plain response contains an invalid command.");
    if(selection!=="NEW"&&!/^\d+$/u.test(selection))throw new Error("Memory Judge plain response contains invalid output.");
    if(seen.has(selection))throw new Error("Memory Judge returned duplicate archive selections.");
    seen.add(selection);
    parsed.push(selection);
  }
  return {archive:parsed};
}

/** Build the compact Judge request using candidate positions so the model never has to reproduce real memory IDs. */
function buildJudgeInput(newMemory:MemoryItem,candidates:readonly SemanticMemoryCandidate[]):string{
  return [
    "NEW MEMORY",
    "content: "+safeText(newMemory.content),
    "",
    "CANDIDATES",
    ...candidates.map((candidate,index)=>[
      (index+1)+". content: "+safeText(candidate.memory.content)
    ].join("\n"))
  ].join("\n");
}

/** Validate Judge positions before mapping them to real memory IDs and block an all-record mutation. */
export function validateJudgeArchiveSelections(selections:readonly string[],candidateCount:number):void{
  const seen=new Set<string>();
  for(const selection of selections){
    if(seen.has(selection))throw new Error("Memory Judge returned duplicate archive selections.");
    seen.add(selection);
    if(selection==="NEW")continue;
    if(!/^[1-9]\d*$/u.test(selection))throw new Error("Memory Judge returned an invalid archive selection.");
    const candidateNumber=Number(selection);
    if(!Number.isSafeInteger(candidateNumber)||candidateNumber<1||candidateNumber>candidateCount){
      throw new Error("Memory Judge referenced a candidate number outside the provided range.");
    }
  }
  if(selections.includes("NEW")&&selections.length===candidateCount+1){
    throw new Error("Memory Judge attempted to archive every supplied record.");
  }
}

/** Convert validated Judge positions to the real IDs owned by Core; the model never receives this mapping. */
export function mapJudgeArchiveSelections(
  selections:readonly string[],
  newMemoryId:string,
  candidates:readonly SemanticMemoryCandidate[]
):string[]{
  return selections.map(selection=>{
    if(selection==="NEW")return newMemoryId;
    const candidateNumber=Number(selection);
    const candidate=candidates[candidateNumber-1];
    if(!candidate)throw new Error("Memory Judge candidate mapping failed after validation.");
    return candidate.memory.id;
  });
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

function makeIndexRecord(memory:MemoryItem,provider:EmbeddingProvider,model:string,vector:readonly number[],now:string):MemorySemanticVectorRecord{
  if(!isFiniteVector(vector))throw new Error("Embedding provider returned an invalid vector.");
  return {memoryId:memory.id,characterId:memory.characterId,contentHash:deterministicContentHash(memory.content),embeddingProviderId:provider.id,embeddingModel:model,dimensions:vector.length,vector:[...vector],updatedAt:now};
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
    this.recordDiagnostic("SEMANTIC_DEDUP_SUBSCRIBED","semantic memory deduplication subscribed to MemoryCreated",{memoryCreated:true});
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

  async deduplicateMemory(memoryId:string,characterId:CharacterId,options:{forceJudge?:boolean}={}):Promise<SemanticDedupExecution>{
    const key=characterId+"\0"+memoryId;
    if(this.inFlight.has(key)){
      this.recordDiagnostic("SEMANTIC_DEDUP_SKIPPED","deduplication_already_in_flight",{characterId,memoryId});
      return {status:"skipped",reason:"deduplication_already_in_flight",candidateCount:0,candidateIds:[],similarityScores:{}};
    }
    this.inFlight.add(key);
    try{
      const settings=this.options.settings();
      this.recordDiagnostic("SEMANTIC_DEDUP_STARTED","semantic memory deduplication started",{
        characterId,
        memoryId,
        semanticDedupEnabled:settings.semanticDedup.enabled,
        judgeEnabled:settings.semanticDedup.judge.enabled,
        judgeProviderPresetId:settings.semanticDedup.judge.providerPresetId??null,
        judgeModel:settings.semanticDedup.judge.model,
        judgeOutputMode:settings.semanticDedup.judge.outputMode
      });
      if(!settings.semanticDedup.enabled&&!options.forceJudge)return this.skip("semantic_deduplication_disabled",characterId);
      const newMemory=await this.options.broker.get(characterId,memoryId);
      if(!newMemory)return this.skip("new_memory_not_found",characterId);
      if(newMemory.status!=="active")return this.skip("new_memory_not_active",characterId);
      const memories=await this.options.broker.list(characterId);

      // Embeddings are an optional semantic candidate source; deterministic containment must still run without them.
      let provider:EmbeddingProvider|undefined;
      if(settings.semanticDedup.enabled){
        try{provider=await this.options.embeddingProvider();}
        catch(error){this.recordFailure("EMBEDDING_PROVIDER_RESOLUTION_FAILED",error,characterId,{memoryId});}
      }
      const model=settings.semanticDedup.enabled?settings.semanticDedup.embeddingModel.trim():"";
      let vectors:ReadonlyMap<string,readonly number[]>=new Map();
      let staleOrMissing=0;
      if(provider&&model){
        try{
          const indexed=await this.ensureVectors(characterId,memories,provider,model,newMemory);
          vectors=indexed.vectors;
          staleOrMissing=indexed.staleOrMissing;
        }catch(error){
          // A semantic index failure must not suppress the deterministic containment candidate path.
          this.recordFailure("EMBEDDING_CANDIDATE_DISCOVERY_FAILED",error,characterId,{memoryId});
        }
      }
      const selected=selectTopSemanticCandidates(
        newMemory,
        memories,
        vectors,
        settings.semanticDedup.candidateSimilarityThreshold,
        settings.semanticDedup.candidateLimit
      );
      const scores=Object.fromEntries(selected.map(candidate=>[candidate.memory.id,candidate.similarity]));
      const containmentCandidates=selected.filter(candidate=>candidate.containmentMatch).map(candidate=>candidate.memory.id);
      const candidateDiagnostics=selected.map((candidate,index)=>({
        number:index+1,
        memoryId:candidate.memory.id,
        content:safeText(candidate.memory.content).slice(0,240),
        containmentMatch:candidate.containmentMatch,
        similarity:candidate.similarity
      }));
      this.recordDiagnostic("SEMANTIC_DEDUP_CANDIDATES_SELECTED","semantic deduplication candidate scan",{
        characterId,
        embeddingProvider:provider?.id??null,
        embeddingModel:model||null,
        candidateCount:selected.length,
        candidateIds:selected.map(item=>item.memory.id),
        candidateDiagnostics,
        containmentCandidates,
        similarityScores:scores,
        staleOrMissingRecordCount:staleOrMissing,
        threshold:settings.semanticDedup.candidateSimilarityThreshold,
        candidateLimit:settings.semanticDedup.candidateLimit
      });
      if(selected.length===0)return {status:"completed",candidateCount:0,candidateIds:[],similarityScores:scores};
      const judge=this.options.settings().semanticDedup.judge;
      if(!judge.enabled)return this.skip("memory_judge_disabled",characterId,selected,scores);
      const presetId=judge.providerPresetId?.trim()??"";
      if(!presetId)return this.skip("memory_judge_provider_not_configured",characterId,selected,scores);
      const modelName=judge.model.trim()||await this.options.getChatModelForPreset(presetId);
      if(!modelName.trim())return this.skip("memory_judge_model_not_configured",characterId,selected,scores);
      const chatRequest:ChatRequest={
        apiVersion:"1",
        schemaVersion:"1",
        requestId:"memory-judge:"+memoryId,
        model:modelName,
        context:{
          conversationId:"memory-judge:"+memoryId,
          messages:[
            {role:"system",content:resolvePromptText(settings.prompts,"memory-judge.system")},
            {role:"user",content:buildJudgeInput(newMemory,selected)}
          ]
        }
      };
      this.recordDiagnostic("SEMANTIC_DEDUP_JUDGE_STARTED","memory judge started",{
        characterId,
        candidateDiagnostics,
        containmentCandidates,
        similarityScores:scores,
        judgePresetId:presetId,
        model:modelName
      });
      const schema=STANDARD_SCHEMAS["memory-judge-decision"]!;
      const execution=await this.outputRunner.run({
        outputMode:judge.outputMode,
        request:chatRequest,
        providerPresetId:presetId,
        schemaName:"memory-judge-decision",
        schema,
        providerSchema:MEMORY_JUDGE_PROVIDER_SCHEMA,
        validator:this.options.validator,
        parseStructured:parseStructuredJudge,
        parsePlain:parsePlainJudge,
        diagnostics:this.options.diagnostics,
        source:this.options.source??"memory-semantic-deduplication"
      });
      const judgeSelections=execution.value.archive;
      this.recordDiagnostic("SEMANTIC_DEDUP_JUDGE_COMPLETED","memory judge completed",{
        characterId,
        candidateDiagnostics,
        judgeSelections,
        configuredMode:judge.outputMode,
        effectiveMode:execution.metadata.effectiveOutputMode,
        judgePresetId:presetId,
        model:modelName
      });
      let validationError:unknown;
      let archiveIds:string[]=[];
      let archiveMapping:{selection:string;memoryId:string}[]=[];
      try{
        validateJudgeArchiveSelections(judgeSelections,selected.length);
        archiveIds=mapJudgeArchiveSelections(judgeSelections,newMemory.id,selected);
        archiveMapping=judgeSelections.map((selection,index)=>({selection,memoryId:archiveIds[index]!}));
      }catch(error){
        validationError=error;
      }
      this.recordDiagnostic("SEMANTIC_DEDUP_JUDGE_OUTPUT_PARSED","memory judge output parsed",{
        characterId,
        candidateDiagnostics,
        judgeSelections,
        archiveMapping,
        archiveIds,
        mutationResult:validationError?"blocked":archiveIds.length===0?"none":"pending"
      });
      if(validationError){
        this.recordFailure("MUTATION_BLOCKED",validationError,characterId,{judgeSelections,archiveIds});
        this.recordDiagnostic("SEMANTIC_DEDUP_MUTATION_BLOCKED","semantic Judge archive mutation blocked",{
          characterId,judgeSelections,archiveIds,mutationResult:"blocked"
        });
        return {
          status:"completed",
          reason:"mutation_blocked",
          candidateCount:selected.length,
          candidateIds:selected.map(item=>item.memory.id),
          similarityScores:scores,
          configuredMode:judge.outputMode,
          effectiveMode:execution.metadata.effectiveOutputMode,
          archiveIds:[],
          mutation:{archiveIds:[],result:"blocked"}
        };
      }
      if(archiveIds.length===0){
        return {
          status:"completed",
          candidateCount:selected.length,
          candidateIds:selected.map(item=>item.memory.id),
          similarityScores:scores,
          configuredMode:judge.outputMode,
          effectiveMode:execution.metadata.effectiveOutputMode,
          archiveIds:[],
          mutation:{archiveIds:[],result:"none"}
        };
      }
      const freshRecords:MemoryItem[]=[];
      for(const archiveId of archiveIds){
        const current=await this.options.broker.get(characterId,archiveId);
        if(!current||current.status!=="active"){
          this.recordFailure("MUTATION_BLOCKED","Judge archive target changed or is no longer active.",characterId,{archiveId});
          return {
            status:"completed",
            reason:"mutation_blocked",
            candidateCount:selected.length,
            candidateIds:selected.map(item=>item.memory.id),
            similarityScores:scores,
            configuredMode:judge.outputMode,
            effectiveMode:execution.metadata.effectiveOutputMode,
            archiveIds,
            mutation:{archiveIds,result:"blocked"}
          };
        }
        freshRecords.push(current);
      }
      const authority={
        actorId:"memory-semantic-deduplication",
        actorType:"system" as const,
        trusted:true,
        capabilities:["memory.write.auto","memory.write.suggest.apply","memory.archive.semantic"],
        moduleId:"memory-semantic-deduplication"
      };
      try{
        // Core archives exactly the validated Judge-selected active IDs; all mutation stays behind MemoryBroker.
        for(const record of freshRecords)await this.options.broker.archive(characterId,record.id,authority,"other");
        this.recordDiagnostic("SEMANTIC_DEDUP_MUTATION_APPLIED","semantic Judge archive mutation applied",{
          characterId,judgeSelections,archiveMapping,archiveIds,mutationResult:"applied"
        });
        return {
          status:"completed",
          candidateCount:selected.length,
          candidateIds:selected.map(item=>item.memory.id),
          similarityScores:scores,
          configuredMode:judge.outputMode,
          effectiveMode:execution.metadata.effectiveOutputMode,
          archiveIds,
          mutation:{archiveIds,result:"applied"}
        };
      }catch(error){
        this.recordFailure("MUTATION_BLOCKED",error,characterId,{archiveIds});
        this.recordDiagnostic("SEMANTIC_DEDUP_MUTATION_BLOCKED","semantic Judge archive mutation blocked",{
          characterId,archiveIds,mutationResult:"blocked"
        });
        return {
          status:"completed",
          reason:"mutation_blocked",
          candidateCount:selected.length,
          candidateIds:selected.map(item=>item.memory.id),
          similarityScores:scores,
          configuredMode:judge.outputMode,
          effectiveMode:execution.metadata.effectiveOutputMode,
          archiveIds,
          mutation:{archiveIds,result:"blocked"}
        };
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
    await replaceMemorySemanticIndexPartition(this.options.indexStore,characterId,
      memoryId=>!memoryId.startsWith(SEMANTIC_SEARCH_RECORD_PREFIX),nextState.records);
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
    await replaceMemorySemanticIndexPartition(this.options.indexStore,characterId,
      memoryId=>!memoryId.startsWith(SEMANTIC_SEARCH_RECORD_PREFIX),records.sort((a,b)=>a.memoryId.localeCompare(b.memoryId)));
  }

  private async onMemoryCreated(payload:{characterId:string;memoryId:string}):Promise<void>{
    this.recordDiagnostic("SEMANTIC_DEDUP_EVENT_RECEIVED","MemoryCreated received by semantic deduplicator",{characterId:payload.characterId,memoryId:payload.memoryId});
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
      await withMemorySemanticIndexLock(this.options.indexStore,async()=>{
        const current=validIndexState(await this.options.indexStore.load(characterId),characterId);
        const records=current.records.filter(record=>record.memoryId!==memoryId);
        if(records.length===current.records.length)return;
        await this.options.indexStore.save({...current,records});
      });
    }catch(error){this.recordFailure("DERIVED_INDEX_CLEANUP_FAILED",error,characterId,{memoryId});}
  }

  private skip(reason:string,characterId:CharacterId,candidates?:readonly SemanticMemoryCandidate[],scores?:Readonly<Record<string,number>>):SemanticDedupExecution{
    this.options.diagnostics?.recordError(this.options.source??"memory-semantic-deduplication","SEMANTIC_DEDUP_SKIPPED",reason,{
      characterId,
      ...(candidates?{candidateCount:candidates.length,candidateIds:candidates.map(item=>item.memory.id),similarityScores:scores??{}}:{})
    });
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
    const providerDetails=extractProviderFailureDetails(error);
    this.options.diagnostics?.recordError(this.options.source??"memory-semantic-deduplication",code,message,{
      characterId,
      ...(providerDetails??{}),
      ...metadata
    });
  }
}
