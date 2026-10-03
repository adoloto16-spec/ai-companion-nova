import type {
  AssembledContext,
  ChatMessage,
  ContextBuildRequest,
  ContextCandidate,
  ContextEngine as ContextEngineContract,
  ContextSource,
  ContextZone,
  CoreBookActivation,
  CoreBookEntry,
  CoreBookEntryId,
  CharacterId,
  MemoryBroker,
  MemoryItem,
  MemorySearchQuery,
  Retriever
} from "../../contracts/src/index";
import {
  CONTEXT_API_VERSION,
  CONTEXT_SCHEMA_VERSION,DEFAULT_APP_SETTINGS
} from "../../contracts/src/index";

export interface TokenEstimator {
  estimate(text:string):number;
}

export class DeterministicApproxTokenEstimator implements TokenEstimator {
  estimate(text:string):number {
    const codePoints=[...text].length;
    return Math.max(1,Math.ceil(codePoints/4));
  }
}

export interface ContextCandidateSource {
  readonly source:ContextSource;
  collect(request:ContextBuildRequest):Promise<readonly ContextCandidate[]>;
}

export interface CoreBookCandidateReader {
  listCoreBookEntries(characterId:CharacterId):Promise<readonly CoreBookEntry[]>;
}

export interface MemoryCandidateReader {
  search(query:MemorySearchQuery):Promise<readonly MemoryItem[]>;
  get?(characterId:CharacterId,conversationId:string,memoryId:string):Promise<MemoryItem|undefined>;
}

function diagnosticErrorMessage(error:unknown):string{
  if(error instanceof Error)return error.message;
  if(typeof error==="string")return error;
  if(error&&typeof error==="object"){
    const record=error as Record<string,unknown>;
    for(const key of ["message","reason","error"]){
      const value=record[key];
      if(typeof value==="string"&&value.trim())return value;
      if(value&&typeof value==="object"){
        const nested=value as Record<string,unknown>;
        for(const nestedKey of ["message","reason"]){
          const nestedValue=nested[nestedKey];
          if(typeof nestedValue==="string"&&nestedValue.trim())return nestedValue;
        }
      }
    }
  }
  return "Unknown memory retrieval error";
}

const DEFAULT_MEMORY_CANDIDATE_LIMIT=DEFAULT_APP_SETTINGS.memory.candidateLimit;
type DynamicNumber=number|(()=>number);

export class MemoryCandidateSource implements ContextCandidateSource {
  readonly source:ContextSource="memory";
  constructor(
    private readonly reader:MemoryCandidateReader,
    private readonly estimator:TokenEstimator=new DeterministicApproxTokenEstimator(),
    private readonly maxResults:DynamicNumber=DEFAULT_MEMORY_CANDIDATE_LIMIT,
    private readonly retriever?:Retriever,
    private readonly diagnostics?:Pick<DiagnosticsStore,"recordError">
  ){
    if(typeof maxResults==="number"&&(!Number.isInteger(maxResults)||maxResults<1))throw new Error("maxResults must be a positive integer.");
  }

  async collect(request:ContextBuildRequest):Promise<readonly ContextCandidate[]> {
    const maxResults=typeof this.maxResults==="function"?this.maxResults():this.maxResults;
    if(!Number.isInteger(maxResults)||maxResults<1)throw new Error("memory candidate limit must be a positive integer.");
    const latestUserMessage=[...request.messages].reverse().find(message=>message.role==="user");
    const query=latestUserMessage?.content.trim();
    if(!query)return [];

    let results:readonly MemoryItem[];
    if(this.retriever){
      let retrieval;
      try{
        retrieval=await this.retriever.search({
          apiVersion:CONTEXT_API_VERSION,
          schemaVersion:CONTEXT_SCHEMA_VERSION,
          characterId:request.characterId,
          conversationId:request.conversationId,
          query,
          sources:["memory"],
          limit:maxResults,
          filters:{status:"active"}
        });
      }catch(error){
        this.diagnostics?.recordError(
          "context-memory",
          "RETRIEVAL_FAILED",
          diagnosticErrorMessage(error),
          {characterId:request.characterId,conversationId:request.conversationId,query,sources:["memory"]}
        );
        throw error;
      }
      if(retrieval.degraded){
        const error=new Error(retrieval.error??"Retrieval returned a degraded result.");
        this.diagnostics?.recordError(
          "context-memory",
          "RETRIEVAL_DEGRADED",
          error.message,
          {characterId:request.characterId,conversationId:request.conversationId,query,sources:["memory"]}
        );
        throw error;
      }
      const canonical=await Promise.all(retrieval.candidates
        .filter(candidate=>candidate.source==="memory"&&candidate.characterId===request.characterId&&candidate.conversationId===request.conversationId)
        .map(candidate=>this.reader.get?.(request.characterId,request.conversationId,candidate.sourceId)));
      results=canonical.filter((item):item is MemoryItem=>Boolean(item));
    }else{
      try{
        results=await this.reader.search({characterId:request.characterId,conversationId:request.conversationId,query,status:"active",limit:maxResults});
      }catch(error){
        this.diagnostics?.recordError(
          "context-memory",
          "MEMORY_STORE_SEARCH_FAILED",
          diagnosticErrorMessage(error),
          {characterId:request.characterId,conversationId:request.conversationId,query}
        );
        throw error;
      }
    }

    return results
      .filter(item=>item.characterId===request.characterId && item.conversationId===request.conversationId && item.status==="active")
      .map((item,index)=>{
        const relevance=Math.max(10,100-index*10);
        const retentionPriority=item.importance;
        const selectionScore=
          40+
          Math.round(relevance*0.25)+
          Math.round(item.importance*0.5)+
          Math.round(item.confidence*0.25);
        return {
          id:"memory:"+item.id,
          source:"memory",
          referenceId:item.id,
          characterId:item.characterId,
          content:item.content,
          role:"user",
          eligible:true,
          reason:
            "deterministic memory search result #"+String(index+1)+
            "; importance is the primary retention input, confidence is a secondary tie-break input; placementWeight is unused",
          estimatedTokens:this.estimator.estimate(item.content),
          zone:"retrieved_memory",
          relevance,
          activationStrength:0,
          retentionPriority,
          placementWeight:0,
          recency:0,
          selectionScore
        } satisfies ContextCandidate;
      });
  }
}

const RECENT_CONVERSATION_MESSAGES=DEFAULT_APP_SETTINGS.context.recentConversationMessages;

function cloneMetadata(metadata?:Record<string,unknown>):Record<string,unknown>|undefined {
  return metadata===undefined?undefined:{...metadata};
}

function validateNonNegativeInteger(value:number,label:string):void {
  if(!Number.isInteger(value)||value<0)throw new Error(label+" must be a non-negative integer.");
}

function validateRequest(request:ContextBuildRequest):void {
  if(request.apiVersion!==CONTEXT_API_VERSION||request.schemaVersion!==CONTEXT_SCHEMA_VERSION)throw new Error("Unsupported Context Engine contract version.");
  if(!request.characterId.trim())throw new Error("Context characterId must not be empty.");
  if(!request.conversationId.trim())throw new Error("Context conversationId must not be empty.");
  for(const [label,value] of Object.entries(request.budget)){
    validateNonNegativeInteger(value,label);
  }
}

function candidateScore(relevance:number,activationStrength:number,retentionPriority:number,recency:number):number {
  return relevance+activationStrength+retentionPriority+recency;
}

function sourceRank(source:ContextSource):number {
  if(source==="core_book")return 0;
  if(source==="memory")return 1;
  return 2;
}

function stableCompare(a:{candidate:ContextCandidate;index:number},b:{candidate:ContextCandidate;index:number}):number {
  return b.candidate.selectionScore-a.candidate.selectionScore ||
    b.candidate.retentionPriority-a.candidate.retentionPriority ||
    sourceRank(a.candidate.source)-sourceRank(b.candidate.source) ||
    a.index-b.index;
}

function activationDescription(activation:CoreBookActivation):string {
  switch(activation.kind){
    case "always": return "always activation";
    case "keyword": return "keyword activation";
    case "regex": return "regex activation";
    case "semantic": return "semantic activation is reserved in v1";
    case "model_search": return "model_search activation is reserved in v1";
  }
}

export class ConversationCandidateSource implements ContextCandidateSource {
  readonly source:ContextSource="conversation";
  constructor(
    private readonly estimator:TokenEstimator=new DeterministicApproxTokenEstimator(),
    private readonly recentMessageCount:DynamicNumber=RECENT_CONVERSATION_MESSAGES
  ){
    if(typeof recentMessageCount==="number"&&(!Number.isInteger(recentMessageCount)||recentMessageCount<1))throw new Error("recentMessageCount must be a positive integer.");
  }

  async collect(request:ContextBuildRequest):Promise<readonly ContextCandidate[]> {
    const recentMessageCount=typeof this.recentMessageCount==="function"?this.recentMessageCount():this.recentMessageCount;
    if(!Number.isInteger(recentMessageCount)||recentMessageCount<1)throw new Error("recent message count must be a positive integer.");
    const nonSystemIndexes=request.messages
      .map((message,index)=>message.role==="system"?-1:index)
      .filter(index=>index>=0);
    const recentStart=Math.max(0,nonSystemIndexes.length-recentMessageCount);
    const recentIndexes=new Set(nonSystemIndexes.slice(recentStart));
    return request.messages.map((message,index)=>{
      const recent=recentIndexes.has(index);
      const zone:ContextZone=message.role==="system"?"system":recent?"recent_conversation":"conversation";
      const relevance=message.role==="system"?100:recent?100:60;
      const retentionPriority=message.role==="system"?100:recent?90:50;
      const recency=message.role==="system"?100:recent?Math.min(100,50+Math.round((index/(Math.max(1,request.messages.length-1)))*50)):10;
      const referenceId=message.id?.trim()||request.conversationId+":message:"+index;
      return {
        id:"conversation:"+request.conversationId+":"+index,
        source:"conversation",
        referenceId,
        characterId:request.characterId,
        content:message.content,
        role:message.role,
        ...(message.toolCallId?{toolCallId:message.toolCallId}:{}),
        ...(message.metadata?{metadata:cloneMetadata(message.metadata)}:{}),
        eligible:true,
        reason:message.role==="system"?"system conversation data is retained before ordinary context material":
          recent?"recent conversation turn is retained before older context":"older conversation turn is eligible after recent context",
        estimatedTokens:this.estimator.estimate(message.content),
        zone,
        relevance,
        activationStrength:0,
        retentionPriority,
        placementWeight:50,
        recency,
        selectionScore:candidateScore(relevance,0,retentionPriority,recency)
      } satisfies ContextCandidate;
    });
  }
}

export class CoreBookCandidateSource implements ContextCandidateSource {
  readonly source:ContextSource="core_book";
  constructor(
    private readonly reader:CoreBookCandidateReader,
    private readonly estimator:TokenEstimator=new DeterministicApproxTokenEstimator(),
    private readonly retriever?:Retriever,
    private readonly retrievalCandidateLimit:DynamicNumber=32
  ){}

  async collect(request:ContextBuildRequest):Promise<readonly ContextCandidate[]> {
    const entries=await this.reader.listCoreBookEntries(request.characterId);
    const contextText=request.messages.map(message=>message.content).join("\n");
    let retrievalIds:Set<string>|undefined;
    const latestUser=[...request.messages].reverse().find(message=>message.role==="user");
    const query=latestUser?.content.trim();
    if(this.retriever&&query){
      try{
        const retrievalCandidateLimit=typeof this.retrievalCandidateLimit==="function"?this.retrievalCandidateLimit():this.retrievalCandidateLimit;
        if(!Number.isInteger(retrievalCandidateLimit)||retrievalCandidateLimit<1)throw new Error("retrieval candidate limit must be a positive integer.");
        const result=await this.retriever.search({apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION,characterId:request.characterId,query,sources:["core_book"],limit:retrievalCandidateLimit,filters:{status:"enabled"}});
        if(!result.degraded)retrievalIds=new Set(result.candidates.filter(candidate=>candidate.source==="core_book"&&candidate.characterId===request.characterId).map(candidate=>candidate.sourceId));
      }catch{
        retrievalIds=undefined;
      }
    }
    return entries.map(entry=>{
      if(retrievalIds&&entry.activation.kind!=="always"&&!retrievalIds.has(entry.id)){
        const candidate=this.toCandidate(entry,request,contextText);
        return {...candidate,eligible:false,reason:"Core Book entry was not returned by deterministic full-text retrieval."};
      }
      return this.toCandidate(entry,request,contextText);
    });
  }

  private toCandidate(entry:CoreBookEntry,request:ContextBuildRequest,contextText:string):ContextCandidate {
    const base={
      id:"core_book:"+entry.id,
      source:"core_book" as const,
      referenceId:entry.id as CoreBookEntryId,
      characterId:entry.characterId,
      content:entry.content,
      role:"user" as const,
      eligible:false,
      reason:"",
      estimatedTokens:this.estimator.estimate(entry.content),
      zone:(entry.activation.kind==="always"?"character_core":"retrieved_core_book") as ContextZone,
      relevance:0,
      activationStrength:0,
      retentionPriority:entry.retentionPriority,
      placementWeight:entry.placementWeight,
      recency:0,
      selectionScore:0
    };

    if(entry.characterId!==request.characterId){
      return {...base,reason:"Core Book candidate is outside the requested character scope."};
    }
    if(!entry.enabled){
      return {...base,reason:"Core Book entry is disabled."};
    }

    const activation=entry.activation;
    if(activation.kind==="semantic"||activation.kind==="model_search"){
      return {...base,reason:activationDescription(activation)};
    }

    if(activation.kind==="always"){
      const relevance=50,activationStrength=100;
      return {
        ...base,
        eligible:true,
        reason:"always activation matched; placementWeight is reserved for placement only",
        relevance,activationStrength,
        selectionScore:candidateScore(relevance,activationStrength,entry.retentionPriority,0)
      };
    }

    if(activation.kind==="keyword"){
      const sourceText=activation.caseSensitive?contextText:contextText.toLowerCase();
      const matches=activation.keywords.filter(keyword=>{
        const needle=activation.caseSensitive?keyword:keyword.toLowerCase();
        return sourceText.includes(needle);
      });
      const matched=matches.length;
      const required=activation.keywords.length;
      const eligible=activation.matchMode==="all"?matched===required:matched>0;
      const relevance=Math.round((matched/required)*100);
      const activationStrength=75;
      return {
        ...base,
        eligible,
        reason:eligible
          ? "keyword activation matched "+matched+"/"+required+" keywords; placementWeight is not relevance"
          : "keyword activation did not satisfy "+activation.matchMode+" matching",
        relevance,
        activationStrength,
        selectionScore:eligible?candidateScore(relevance,activationStrength,entry.retentionPriority,0):0
      };
    }

    try{
      const regex=new RegExp(activation.pattern,activation.flags);
      regex.lastIndex=0;
      const matched=regex.test(contextText);
      const relevance=matched?100:0;
      const activationStrength=80;
      return {
        ...base,
        eligible:matched,
        reason:matched
          ? "regex activation matched; placementWeight is not relevance"
          : "regex activation did not match",
        relevance,
        activationStrength,
        selectionScore:matched?candidateScore(relevance,activationStrength,entry.retentionPriority,0):0
      };
    }catch{
      return {...base,reason:"invalid regex configuration was safely rejected for this build."};
    }
  }
}

export interface ContextEngineOptions {
  tokenEstimator?:TokenEstimator;
  recentMessageCount?:DynamicNumber;
  memoryBroker?:Pick<MemoryBroker,"search"|"get">;
  memoryCandidateLimit?:DynamicNumber;
  retrievalCandidateLimit?:DynamicNumber;
  retriever?:Retriever;
  diagnostics?:Pick<DiagnosticsStore,"recordError">;
}

export class DeterministicContextEngine implements ContextEngineContract {
  private readonly sources:readonly ContextCandidateSource[];

  constructor(
    sources:readonly ContextCandidateSource[],
    options:ContextEngineOptions={}
  ){
    if(sources.length===0)throw new Error("Context Engine requires at least one candidate source.");
    this.sources=sources;
    const recentMessageCount=typeof options.recentMessageCount==="number"?options.recentMessageCount:undefined;
    const memoryCandidateLimit=typeof options.memoryCandidateLimit==="number"?options.memoryCandidateLimit:undefined;
    const retrievalCandidateLimit=typeof options.retrievalCandidateLimit==="number"?options.retrievalCandidateLimit:undefined;
    if(recentMessageCount!==undefined&&recentMessageCount<1)throw new Error("recentMessageCount must be positive.");
    if(memoryCandidateLimit!==undefined&&memoryCandidateLimit<1)throw new Error("memoryCandidateLimit must be positive.");
    if(retrievalCandidateLimit!==undefined&&retrievalCandidateLimit<1)throw new Error("retrievalCandidateLimit must be positive.");
  }

  async build(request:ContextBuildRequest):Promise<AssembledContext> {
    validateRequest(request);
    const collected=await Promise.all(this.sources.map(source=>source.collect(request)));
    const candidates=collected.flat().map((candidate,index)=>({candidate,index}));
    const included=new Set<string>();
    let remaining=request.budget.availableContextTokens;

    const include=(candidate:ContextCandidate):boolean=>{
      if(!candidate.eligible)return false;
      if(candidate.estimatedTokens>remaining)return false;
      included.add(candidate.id);
      remaining-=candidate.estimatedTokens;
      return true;
    };

    // System conversation data is preserved ahead of all ordinary material.
    for(const item of candidates.filter(item=>item.candidate.zone==="system")){
      include(item.candidate);
    }

    // Preserve a contiguous recent suffix as long as it fits.
    const recent=candidates.filter(item=>item.candidate.zone==="recent_conversation").sort((a,b)=>b.index-a.index);
    for(const item of recent){
      if(!include(item.candidate))break;
    }

    // Remaining budget is shared by Core Book and older conversation. The deterministic
    // selection score is relevance + activationStrength + retentionPriority + recency.
    const pressurePool=candidates
      .filter(item=>item.candidate.eligible && !included.has(item.candidate.id) && item.candidate.zone!=="system" && item.candidate.zone!=="recent_conversation")
      .sort(stableCompare);
    for(const item of pressurePool)include(item.candidate);

    const includedCandidates=candidates.filter(item=>included.has(item.candidate.id)).map(item=>item.candidate);
    const omittedCandidates=candidates
      .filter(item=>!included.has(item.candidate.id))
      .map(item=>{
        if(!item.candidate.eligible)return {...item.candidate};
        return {...item.candidate,reason:"omitted by deterministic context budget pressure after higher-priority material was retained."};
      });

    const placed=[...includedCandidates].sort((a,b)=>{
      const zoneOrder:Record<ContextZone,number>={
        system:0,character_core:10,retrieved_core_book:20,retrieved_memory:25,conversation:30,recent_conversation:40
      };
      const zoneDifference=zoneOrder[a.zone]-zoneOrder[b.zone];
      if(zoneDifference)return zoneDifference;
      if(a.source==="core_book"&&b.source==="core_book"){
        return b.placementWeight-a.placementWeight || a.referenceId.localeCompare(b.referenceId);
      }
      // Conversation order is already deterministic in source order; keep it stable.
      return 0;
    });

    const messages=placed.map(candidate=>({
      id:candidate.referenceId,
      role:candidate.role,
      content:candidate.content,
      ...(candidate.toolCallId?{toolCallId:candidate.toolCallId}:{}),
      metadata:{
        ...(candidate.metadata??{}),
        contextSource:candidate.source,
        contextReferenceId:candidate.referenceId,
        contextZone:candidate.zone
      }
    } satisfies ChatMessage));

    const estimatedTokens=includedCandidates.reduce((sum,candidate)=>sum+candidate.estimatedTokens,0);
    return {
      apiVersion:CONTEXT_API_VERSION,
      schemaVersion:CONTEXT_SCHEMA_VERSION,
      characterId:request.characterId,
      conversationId:request.conversationId,
      messages,
      includedCandidates:includedCandidates.map(candidate=>({
        ...candidate,
        reason:candidate.source==="core_book"
          ? candidate.reason+"; selected within deterministic budget"
          : candidate.reason
      })),
      omittedCandidates,
      budget:{...request.budget},
      estimatedTokens
    };
  }
}

export function createDeterministicContextEngine(
  coreBookReader:CoreBookCandidateReader,
  options:ContextEngineOptions={}
):DeterministicContextEngine {
  const estimator=options.tokenEstimator??new DeterministicApproxTokenEstimator();
  const sources:ContextCandidateSource[]=[
    new ConversationCandidateSource(estimator,options.recentMessageCount??RECENT_CONVERSATION_MESSAGES),
    new CoreBookCandidateSource(coreBookReader,estimator,options.retriever,options.retrievalCandidateLimit??32)
  ];
  if(options.memoryBroker){
    sources.push(new MemoryCandidateSource(
      options.memoryBroker,
      estimator,
      options.memoryCandidateLimit??DEFAULT_MEMORY_CANDIDATE_LIMIT,
      options.retriever,
      options.diagnostics
    ));
  }
  return new DeterministicContextEngine(sources,options);
}

export function calculateContextBudget(
  modelContextLimit:number,
  reservedOutputTokens:number,
  systemOverheadTokens:number,
  safetyMarginTokens:number
):{
  availableContextTokens:number;
  reservedOutputTokens:number;
  systemOverheadTokens:number;
  safetyMarginTokens:number;
}{
  for(const [label,value] of Object.entries({
    modelContextLimit,reservedOutputTokens,systemOverheadTokens,safetyMarginTokens
  })){
    validateNonNegativeInteger(value,label);
  }
  const availableContextTokens=modelContextLimit-reservedOutputTokens-systemOverheadTokens-safetyMarginTokens;
  if(availableContextTokens<0)throw new Error("Context budget is negative after reserved output, system overhead, and safety margin.");
  return {availableContextTokens,reservedOutputTokens,systemOverheadTokens,safetyMarginTokens};
}
