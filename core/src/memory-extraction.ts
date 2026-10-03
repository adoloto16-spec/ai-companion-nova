import type {
  ChatMessage,ChatRequest,ChatResponse,DiagnosticsStore,MemoryBroker,MemoryCandidate,MemoryCreateInput,MemoryExtractionRequest,MemoryExtractionResult,MemoryItem,MemoryMutationAuthority,SchemaValidator
} from "../../contracts/src/index";
import {MEMORY_EXTRACTION_API_VERSION,MEMORY_EXTRACTION_SCHEMA_VERSION,STANDARD_SCHEMAS,StandardContractValidator} from "../../contracts/src/index";

export interface MemoryExtractionChatRuntime{
  chat(request:ChatRequest,providerPresetId?:string):Promise<ChatResponse>;
}
export interface MemoryExtractionServiceOptions{
  validator?:SchemaValidator;
  diagnostics?:DiagnosticsStore;
  traceStore?:import("../../contracts/src/index").ChatTraceStore;
  source?:string;
}

const EXTRACTION_SYSTEM_PROMPT=[
  "You are a conservative long-term memory extractor for an AI companion.",
  "Return JSON only with this shape: {\"memories\":[...]}." ,
  "Keep only durable, user-grounded information that is useful after this conversation ends.",
  "Prefer explicit user preferences, stable facts, relationships, meaningful events or experiences, goals, and durable instructions.",
  "Do not store casual chatter, transient details, speculation, assistant-generated claims, prompt text, credentials, secrets, or transcript fragments.",
  "Return an empty memories array when nothing is clearly worth retaining.",
  "Each candidate must use source \"conversation\", mutationPolicy \"auto\", and the provided conversation id as sourceReference.",
  "Scores are integers from 0 to 100.",
  "Never infer a fact solely from the assistant response."
].join("\n");

const SECRET_PATTERNS=[
  /authorization\s*:\s*bearer\s+\S+/i,
  /\bbearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /api[_ -]?key\s*[:=]\s*\S+/i,
  /password\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i
];
function safeText(value:string):string{
  return value
    .replace(/authorization\s*:\s*bearer\s+\S+/gi,"Authorization: Bearer [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._-]{16,}\b/gi,"Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g,"[REDACTED]")
    .replace(/api[_ -]?key\s*[:=]\s*\S+/gi,"api-key=[REDACTED]")
    .replace(/password\s*[:=]\s*\S+/gi,"password=[REDACTED]")
    .replace(/secret\s*[:=]\s*\S+/gi,"secret=[REDACTED]");
}
function containsSecret(value:string):boolean{return SECRET_PATTERNS.some(pattern=>pattern.test(value));}
function normalizedContentKey(value:string):string{
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim().replace(/\s+/g," ");
}
function tokens(value:string):string[]{return normalizedContentKey(value).split(" ").filter(Boolean);}
function sharedTag(candidate:MemoryCandidate,item:MemoryItem):boolean{
  const tags=new Set(item.tags.map(tag=>tag.toLocaleLowerCase()));
  return candidate.tags.some(tag=>tags.has(tag.toLocaleLowerCase()));
}
function sameSubjectShape(candidate:MemoryCandidate,item:MemoryItem):boolean{
  if(candidate.type!==item.type)return false;
  const a=tokens(candidate.content),b=tokens(item.content);
  const prefixLength=Math.min(4,a.length,b.length);
  if(prefixLength<4)return false;
  if(a.slice(0,prefixLength).join(" ")!==b.slice(0,prefixLength).join(" "))return false;
  return sharedTag(candidate,item);
}
function cloneMessage(message:ChatMessage):ChatMessage{
  return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})};
}

function extractFirstJsonObject(value:string):string|undefined{
  const trimmed=value.trim();
  if(!trimmed)return undefined;
  const fenced=/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(trimmed);
  const source=fenced?.[1]?.trim()??trimmed;
  const start=source.indexOf("{");
  if(start<0)return undefined;

  let depth=0;
  let inString=false;
  let escaped=false;
  for(let index=start;index<source.length;index++){
    const character=source[index];
    if(inString){
      if(escaped){escaped=false;continue;}
      if(character==="\\"){escaped=true;continue;}
      if(character==="\""){inString=false;}
      continue;
    }
    if(character==="\""){inString=true;continue;}
    if(character==="{"){depth++;continue;}
    if(character==="}"){depth--;if(depth===0)return source.slice(start,index+1);}
  }
  return undefined;
}

function parseMemoryExtractionResult(value:string):unknown|undefined{
  const candidates:string[]=[];
  const trimmed=value.trim();
  if(trimmed)candidates.push(trimmed);
  const extracted=extractFirstJsonObject(value);
  if(extracted&&extracted!==trimmed)candidates.push(extracted);
  for(const candidate of candidates){
    try{
      const parsed=JSON.parse(candidate);
      if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed;
    }catch{
      // Keep extraction conservative: do not attempt repair or inference.
    }
  }
  return undefined;
}

export class MemoryExtractionService{
  private readonly validator:SchemaValidator;
  private readonly diagnostics?:DiagnosticsStore;
  private readonly traceStore?:import("../../contracts/src/index").ChatTraceStore;
  private readonly source:string;
  private readonly inFlight=new Set<string>();
  constructor(private readonly runtime:MemoryExtractionChatRuntime,private readonly broker:MemoryBroker,options:MemoryExtractionServiceOptions={}){
    this.validator=options.validator??new StandardContractValidator();
    this.diagnostics=options.diagnostics;
    this.traceStore=options.traceStore;
    this.source=options.source??"memory-extraction";
  }

  async process(request:MemoryExtractionRequest):Promise<readonly MemoryItem[]>{
    const requestWithVersions={...request,apiVersion:MEMORY_EXTRACTION_API_VERSION,schemaVersion:MEMORY_EXTRACTION_SCHEMA_VERSION};
    const requestValidation=this.validator.validate(requestWithVersions,STANDARD_SCHEMAS["memory-extraction-request"]!);
    if(!requestValidation.valid){this.recordFailure("INVALID_REQUEST","Memory extraction request was rejected by contract validation.");return [];}
    const key=request.characterId+"\0"+request.conversationId+"\0"+request.turnId;
    if(this.inFlight.has(key))return [];
    this.inFlight.add(key);
    this.traceStore?.update(request.turnId,{memoryExtraction:{started:true,status:"started",requestId:"memory-extraction:"+request.turnId,providerId:request.providerId??"default",model:request.model,conversationId:request.conversationId,contextMessageCount:Math.min(8,request.contextMessages.length),candidates:[],accepted:[],rejected:[],duplicate:[],superseded:[],created:[]}});
    try{
      let active=await this.broker.search({characterId:request.characterId,conversationId:request.conversationId,query:"",status:"active",limit:100});
      if(active.some(item=>item.metadata?.turnId===request.turnId))return [];

      const result=await this.extract(request);
      if(!result)return [];
      this.traceStore?.update(request.turnId,{memoryExtraction:{candidates:[...result.memories],accepted:[],rejected:[],duplicate:[],superseded:[],created:[]}});

      const created:MemoryItem[]=[];
      const accepted:MemoryCandidate[]=[];
      const rejected:{candidate:MemoryCandidate;reason:string}[]=[];
      const duplicate:MemoryCandidate[]=[];
      const superseded:{candidate:MemoryCandidate;memoryId:string}[]=[];
      const createdTrace:{candidate:MemoryCandidate;memoryId:string}[]=[];
      for(const candidate of result.memories){
        if(!this.safeCandidate(candidate,request.conversationId)){
          rejected.push({candidate,reason:"candidate failed source, scope, mutation policy, score, or secret validation"});
          this.traceStore?.update(request.turnId,{memoryExtraction:{candidates:[...result.memories],accepted:[...accepted],rejected:[...rejected],duplicate:[...duplicate],superseded:[...superseded],created:[...createdTrace]}});
          continue;
        }
        const keyContent=normalizedContentKey(candidate.content);
        if(active.some(item=>normalizedContentKey(item.content)===keyContent)){
          duplicate.push(candidate);
          this.traceStore?.update(request.turnId,{memoryExtraction:{candidates:[...result.memories],accepted:[...accepted],rejected:[...rejected],duplicate:[...duplicate],superseded:[...superseded],created:[...createdTrace]}});
          continue;
        }

        const replacementTarget=active.find(item=>sameSubjectShape(candidate,item));
        if(replacementTarget){
          try{
            const replacement=await this.broker.supersede(request.characterId,request.conversationId,replacementTarget.id,this.toCreateInput(candidate,request),this.authority());
            created.push(replacement);
            accepted.push(candidate);
            superseded.push({candidate,memoryId:replacement.id});
            createdTrace.push({candidate,memoryId:replacement.id});
            active=[...active.filter(item=>item.id!==replacementTarget.id),replacement];
          }catch{
            this.recordFailure("PERSISTENCE_SKIPPED","Memory replacement was not authorized or could not be persisted.");
          }
          this.traceStore?.update(request.turnId,{memoryExtraction:{candidates:[...result.memories],accepted:[...accepted],rejected:[...rejected],duplicate:[...duplicate],superseded:[...superseded],created:[...createdTrace]}});
          continue;
        }
        try{
          const item=await this.broker.create(request.characterId,this.toCreateInput(candidate,request),this.authority());
          created.push(item);
          accepted.push(candidate);
          createdTrace.push({candidate,memoryId:item.id});
          active=[...active,item];
        }catch{
          this.recordFailure("PERSISTENCE_SKIPPED","Memory candidate could not be persisted.");
        }
        this.traceStore?.update(request.turnId,{memoryExtraction:{candidates:[...result.memories],accepted:[...accepted],rejected:[...rejected],duplicate:[...duplicate],superseded:[...superseded],created:[...createdTrace]}});
      }
      return created;
    }catch{
      this.traceStore?.update(request.turnId,{memoryExtraction:{status:"failed",failed:"Automatic memory extraction failed; chat remains successful."}});
      this.recordFailure("EXTRACTION_FAILED","Automatic memory extraction failed; chat remains successful.",{
        requestId:"memory-extraction:"+request.turnId,
        providerId:request.providerId??"default",
        model:request.model,
        conversationId:request.conversationId,
        contextMessageCount:request.contextMessages.length
      });
      return [];
    }finally{
      this.inFlight.delete(key);
    }
  }

  private async extract(request:MemoryExtractionRequest):Promise<MemoryExtractionResult|undefined>{
    const payload={
      conversationId:request.conversationId,
      turnId:request.turnId,
      contextMessages:request.contextMessages.slice(-8).map(cloneMessage),
      userMessage:cloneMessage(request.userMessage),
      assistantMessage:cloneMessage(request.assistantMessage)
    };
    const chatRequest:ChatRequest={
      apiVersion:"1",
      schemaVersion:"1",
      requestId:"memory-extraction:"+request.turnId,
      ...(request.providerId?{providerId:request.providerId}:{}),
      model:request.model,
      context:{conversationId:request.conversationId,messages:[
        {role:"system",content:EXTRACTION_SYSTEM_PROMPT},
        {role:"user",content:safeText(JSON.stringify(payload))}
      ]}
    };
    const diagnosticMetadata={
      requestId:chatRequest.requestId,
      providerId:request.providerId??"default",
      model:request.model,
      conversationId:request.conversationId,
      contextMessageCount:payload.contextMessages.length
    };
    let response:ChatResponse;
    try{response=await this.runtime.chat(chatRequest,request.providerPresetId);}
    catch{
      this.traceStore?.update(request.turnId,{memoryExtraction:{status:"failed",failed:"Provider call failed."}});
      this.recordFailure("PROVIDER_FAILURE","Memory extraction provider call failed.",diagnosticMetadata);
      return undefined;
    }
    const parsed=parseMemoryExtractionResult(response.message.content);
    if(parsed===undefined){
      this.traceStore?.update(request.turnId,{memoryExtraction:{status:"failed",failed:"Malformed provider JSON."}});
      this.recordFailure("MALFORMED_RESULT","Memory extraction returned malformed JSON.",diagnosticMetadata);
      return undefined;
    }
    const validation=this.validator.validate(parsed,STANDARD_SCHEMAS["memory-extraction-result"]!);
    if(!validation.valid){
      this.traceStore?.update(request.turnId,{memoryExtraction:{status:"failed",failed:"Provider result failed extraction schema validation."}});
      this.recordFailure("SCHEMA_VALIDATION_FAILED","Memory extraction result failed schema validation.",diagnosticMetadata);
      return undefined;
    }
    const result=parsed as MemoryExtractionResult;
    this.traceStore?.update(request.turnId,{memoryExtraction:{status:"completed",candidates:[...result.memories]}});
    return result;
  }

  private safeCandidate(candidate:MemoryCandidate,conversationId:string):boolean{
    if(candidate.source!=="conversation"||candidate.sourceReference!==conversationId||candidate.mutationPolicy!=="auto")return false;
    if(!Number.isInteger(candidate.importance)||candidate.importance<0||candidate.importance>100)return false;
    if(!Number.isInteger(candidate.confidence)||candidate.confidence<0||candidate.confidence>100)return false;
    return !containsSecret(candidate.content)&&candidate.tags.every(tag=>!containsSecret(tag));
  }
  private toCreateInput(candidate:MemoryCandidate,request:MemoryExtractionRequest):MemoryCreateInput{
    return {
      conversationId:request.conversationId,type:candidate.type,content:safeText(candidate.content),tags:candidate.tags.map(safeText),
      importance:candidate.importance,confidence:candidate.confidence,source:"conversation",sourceReference:request.conversationId,
      mutationPolicy:"auto",metadata:{origin:"automatic-memory-extraction",turnId:request.turnId}
    };
  }
  private authority():MemoryMutationAuthority{
    return {actorId:"memory-extractor",actorType:"system",trusted:true,capabilities:["memory.create","memory.write.auto"]};
  }
  private recordFailure(code:string,message:string,metadata?:Record<string,unknown>):void{this.diagnostics?.recordError(this.source,code,message,metadata);}
}
