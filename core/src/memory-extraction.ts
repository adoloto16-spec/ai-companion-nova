import type {
  ChatMessage,ChatRequest,ChatResponse,MemoryBroker,MemoryCandidate,MemoryCreateInput,MemoryExtractionRequest,MemoryExtractionResult,
  MemoryItem,MemoryMutationAuthority,SchemaValidator
} from "../../contracts/src/index";
import {
  CHAT_API_VERSION,CHAT_SCHEMA_VERSION,MEMORY_EXTRACTION_API_VERSION,MEMORY_EXTRACTION_SCHEMA_VERSION,
  STANDARD_SCHEMAS
} from "../../contracts/src/index";
import {AiRuntimeError} from "./ai-runtime";

export interface MemoryExtractionChatBoundary{
  chat(request:ChatRequest):Promise<ChatResponse>;
}

export interface MemoryExtractionDiagnostics{
  recordError(source:string,code:string,message:string,metadata?:Record<string,unknown>):void;
}

export interface MemoryExtractionServiceOptions{
  validator?:SchemaValidator;
  clock?:()=>string;
  diagnostics?:MemoryExtractionDiagnostics;
  memoryBroker:MemoryBroker;
  authority:MemoryMutationAuthority;
}

export interface MemoryExtractionApplyResult{
  requestId:string;
  createdMemoryIds:readonly string[];
  supersededMemoryIds:readonly string[];
  skipped:number;
}

const MAX_CONTEXT_MESSAGES=8;
const MAX_EXTRACTED_CANDIDATES=8;
const MAX_MEMORY_KEY_LENGTH=120;

function now():string{return new Date().toISOString();}
function cloneMessage(message:ChatMessage):ChatMessage{
  return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})};
}
function normalizeText(value:string):string{
  return value.trim().replace(/\s+/g," ").toLocaleLowerCase();
}
function looksLikeSecret(value:string):boolean{
  return /(?:^|\s)bearer\s+[A-Za-z0-9._-]{12,}/i.test(value)
    ||/\b(?:sk-[A-Za-z0-9_-]{12,}|rk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/.test(value)
    ||/\b(?:api[_ -]?key|authorization)\s*[:=]\s*\S+/i.test(value);
}
function extractionSystemPrompt():string{
  return [
    "You are the Dynamic Memory extraction component for AI Companion Nova.",
    "Return JSON only. Do not use markdown fences and do not add prose.",
    "Use exactly this top-level shape: {\"memories\":[...]} .",
    "Extract only durable information explicitly stated or clearly confirmed by the user.",
    "Do not extract assistant-generated claims, guesses, transient details, casual chatter, speculative information, secrets, credentials, authorization headers, raw prompts, or transcript fragments.",
    "Return [] when there is no clearly useful long-term memory.",
    "A candidate must have type, content, tags, importance 0-100, confidence 0-100, source \"conversation\", sourceReference set to the conversationId, mutationPolicy \"auto\".",
    "Prefer concise facts, preferences, relationships, events, experiences, goals, instructions, or observations.",
    "Use stable subject tags or a concise metadata.memoryKey when a durable fact may later be updated or superseded.",
    "Do not invent dates or details that are not present in the conversation."
  ].join("\n");
}
function safeMemoryMetadata(candidate:MemoryCandidate,request:MemoryExtractionRequest):Record<string,unknown>{
  const memoryKey=candidate.metadata&&typeof candidate.metadata.memoryKey==="string"
    ?candidate.metadata.memoryKey.trim().slice(0,MAX_MEMORY_KEY_LENGTH)
    :"";
  return {
    sourceTurnId:request.requestId,
    ...(memoryKey?{memoryKey}: {})
  };
}
function parseResult(content:string,request:MemoryExtractionRequest,validator:SchemaValidator):MemoryExtractionResult{
  const trimmed=content.trim();
  const start=trimmed.indexOf("{");
  const end=trimmed.lastIndexOf("}");
  if(start<0||end<=start)throw new Error("Memory extraction response did not contain a JSON object.");
  let parsed:unknown;
  try{parsed=JSON.parse(trimmed.slice(start,end+1));}
  catch{throw new Error("Memory extraction response contained malformed JSON.");}
  const result:MemoryExtractionResult={
    ...(parsed as Record<string,unknown>),
    requestId:request.requestId,
    apiVersion:MEMORY_EXTRACTION_API_VERSION,
    schemaVersion:MEMORY_EXTRACTION_SCHEMA_VERSION,
    characterId:request.characterId,
    conversationId:request.conversationId
  } as MemoryExtractionResult;
  const validation=validator.validate(result,STANDARD_SCHEMAS["memory-extraction-result"]!);
  if(!validation.valid)throw new Error("Memory extraction result failed schema validation: "+validation.errors.join("; "));
  return result;
}
function recentConversationContext(request:MemoryExtractionRequest):readonly ChatMessage[]{
  return request.contextMessages
    .filter(message=>message.role!=="system")
    .map(cloneMessage)
    .slice(-MAX_CONTEXT_MESSAGES);
}
function candidateToInput(candidate:MemoryCandidate,request:MemoryExtractionRequest):MemoryCreateInput{
  return {
    type:candidate.type,
    content:candidate.content.trim(),
    tags:candidate.tags.map(tag=>tag.trim()).filter(Boolean).slice(0,16),
    importance:candidate.importance,
    confidence:candidate.confidence,
    source:"conversation",
    sourceReference:request.conversationId,
    mutationPolicy:"auto",
    metadata:safeMemoryMetadata(candidate,request)
  };
}
function findStableMatch(candidate:MemoryCreateInput,existing:readonly MemoryItem[]):MemoryItem|undefined{
  const inputContent=normalizeText(candidate.content);
  const memoryKey=typeof candidate.metadata?.memoryKey==="string"?String(candidate.metadata.memoryKey):"";
  if(memoryKey){
    const keyed=existing.filter(item=>item.status==="active"&&item.type===candidate.type&&item.metadata.memoryKey===memoryKey);
    if(keyed.length===1)return keyed[0];
  }
  if(candidate.tags&&candidate.tags.length>0){
    const tags=new Set(candidate.tags.map(tag=>normalizeText(tag)));
    const tagged=existing.filter(item=>{
      if(item.status!=="active"||item.type!==candidate.type)return false;
      const overlap=item.tags.filter(tag=>tags.has(normalizeText(tag))).length;
      return overlap>0;
    });
    if(tagged.length===1&&normalizeText(tagged[0]!.content)!==inputContent)return tagged[0];
  }
  return undefined;
}

export class MemoryExtractionService{
  private readonly validator:SchemaValidator;
  private readonly clock:()=>string;
  private readonly diagnostics?:MemoryExtractionDiagnostics;
  private readonly processed=new Set<string>();

  constructor(private readonly options:MemoryExtractionServiceOptions){
    this.validator=options.validator??({
      validate(value,schema){return {valid:JSON.stringify(value)!==undefined,errors:[]};}
    } as SchemaValidator);
    this.clock=options.clock??now;
    this.diagnostics=options.diagnostics;
  }

  async extractAndApply(request:MemoryExtractionRequest,chat:MemoryExtractionChatBoundary):Promise<MemoryExtractionApplyResult>{
    if(this.processed.has(request.requestId)){
      return {requestId:request.requestId,createdMemoryIds:[],supersededMemoryIds:[],skipped:0};
    }
    this.processed.add(request.requestId);
    const requestValidation=this.validator.validate(request,STANDARD_SCHEMAS["memory-extraction-request"]!);
    if(!requestValidation.valid)throw new Error("Memory extraction request failed schema validation: "+requestValidation.errors.join("; "));

    if(request.userMessage.role!=="user"||request.assistantMessage.role!=="assistant"){
      throw new Error("Memory extraction requires one user message and one assistant response.");
    }
    if(request.userMessage.content.trim().length===0||request.assistantMessage.content.trim().length===0){
      return {requestId:request.requestId,createdMemoryIds:[],supersededMemoryIds:[],skipped:1};
    }

    const chatRequest:ChatRequest={
      apiVersion:CHAT_API_VERSION,
      schemaVersion:CHAT_SCHEMA_VERSION,
      requestId:request.requestId+":memory-extraction",
      model:request.model,
      context:{
        conversationId:request.conversationId,
        messages:[
          {id:request.requestId+":system",role:"system",content:extractionSystemPrompt()},
          ...recentConversationContext(request),
          {id:request.userMessage.id??request.requestId+":user",role:"user",content:request.userMessage.content},
          {id:request.assistantMessage.id??request.requestId+":assistant",role:"assistant",content:request.assistantMessage.content}
        ]
      },
      generation:{maxTokens:700},
      metadata:{task:"memory-extraction",sourceTurnId:request.requestId}
    };

    let response:ChatResponse;
    try{
      response=await chat.chat(chatRequest);
    }catch(error){
      this.recordSafeError(request,error);
      return {requestId:request.requestId,createdMemoryIds:[],supersededMemoryIds:[],skipped:1};
    }

    if(response.message.role!=="assistant"||!response.message.content.trim()){
      this.record("INVALID_EXTRACTION_RESPONSE","Memory extraction provider returned an empty response.",request);
      return {requestId:request.requestId,createdMemoryIds:[],supersededMemoryIds:[],skipped:1};
    }

    let result:MemoryExtractionResult;
    try{
      result=parseResult(response.message.content,request,this.validator);
    }catch(error){
      this.record("INVALID_EXTRACTION_RESPONSE",error instanceof Error?error.message:"Memory extraction response was invalid.",request);
      return {requestId:request.requestId,createdMemoryIds:[],supersededMemoryIds:[],skipped:1};
    }

    const created:string[]=[];
    const superseded:string[]=[];
    let skipped=0;
    for(const rawCandidate of result.memories.slice(0,MAX_EXTRACTED_CANDIDATES)){
      try{
        const candidateValidation=this.validator.validate(rawCandidate,STANDARD_SCHEMAS["memory-candidate"]!);
        if(!candidateValidation.valid)throw new Error("Candidate failed schema validation: "+candidateValidation.errors.join("; "));
        if(looksLikeSecret(rawCandidate.content)||looksLikeSecret(rawCandidate.tags.join(" ")))throw new Error("Candidate resembles credential or authorization data.");
        if(rawCandidate.sourceReference&&looksLikeSecret(rawCandidate.sourceReference))throw new Error("Candidate source reference resembles credential data.");

        const input=candidateToInput(rawCandidate,request);
        if(input.content===undefined||normalizeText(input.content).length===0)throw new Error("Candidate content is empty.");
        const existing=await this.options.memoryBroker.search({
          characterId:request.characterId,
          conversationId:request.conversationId,
          query:"",
          status:"active",
          limit:100
        });

        const duplicate=existing.find(item=>normalizeText(item.content)===normalizeText(input.content));
        if(duplicate){skipped++;continue;}

        const stableMatch=findStableMatch(input,existing);
        if(stableMatch){
          const replacement=await this.options.memoryBroker.supersede(
            request.characterId,request.conversationId,stableMatch.id,input,this.options.authority
          );
          superseded.push(replacement.id);
          continue;
        }

        const item=await this.options.memoryBroker.create(
          request.characterId,request.conversationId,input,this.options.authority
        );
        created.push(item.id);
      }catch(error){
        skipped++;
        this.record("MEMORY_CANDIDATE_SKIPPED",error instanceof Error?error.message:"Memory candidate was skipped.",request);
      }
    }
    return {requestId:request.requestId,createdMemoryIds:created,supersededMemoryIds:superseded,skipped};
  }

  private record(code:string,message:string,request:MemoryExtractionRequest):void{
    this.diagnostics?.recordError("memory-extraction",code,message,{
      requestId:request.requestId,
      characterId:request.characterId,
      conversationId:request.conversationId
    });
  }
  private recordSafeError(request:MemoryExtractionRequest,error:unknown):void{
    const message=error instanceof AiRuntimeError?error.message:error instanceof Error?error.message:"Memory extraction failed.";
    this.record("EXTRACTION_FAILED",message,request);
  }
}
