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
  source?:string;
}

const EXTRACTION_SYSTEM_PROMPT=[
  "You are a conservative long-term memory extractor for an AI companion.",
  "Return JSON only with this shape: {\\"memories\\":[...]}." ,
  "Keep only durable, user-grounded information that is useful after this conversation ends.",
  "Prefer explicit user preferences, stable facts, relationships, meaningful events or experiences, goals, and durable instructions.",
  "Do not store casual chatter, transient details, speculation, assistant-generated claims, prompt text, credentials, secrets, or transcript fragments.",
  "Return an empty memories array when nothing is clearly worth retaining.",
  "Each candidate must use source \\"conversation\\", mutationPolicy \\"auto\\", and the provided conversation id as sourceReference.",
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

export class MemoryExtractionService{
  private readonly validator:SchemaValidator;
  private readonly diagnostics?:DiagnosticsStore;
  private readonly source:string;
  private readonly inFlight=new Set<string>();
  constructor(private readonly runtime:MemoryExtractionChatRuntime,private readonly broker:MemoryBroker,options:MemoryExtractionServiceOptions={}){
    this.validator=options.validator??new StandardContractValidator();
    this.diagnostics=options.diagnostics;
    this.source=options.source??"memory-extraction";
  }

  async process(request:MemoryExtractionRequest):Promise<readonly MemoryItem[]>{
    const requestWithVersions={...request,apiVersion:MEMORY_EXTRACTION_API_VERSION,schemaVersion:MEMORY_EXTRACTION_SCHEMA_VERSION};
    const requestValidation=this.validator.validate(requestWithVersions,STANDARD_SCHEMAS["memory-extraction-request"]!);
    if(!requestValidation.valid){this.recordFailure("INVALID_REQUEST","Memory extraction request was rejected by contract validation.");return [];}
    const key=request.characterId+"\0"+request.conversationId+"\0"+request.turnId;
    if(this.inFlight.has(key))return [];
    this.inFlight.add(key);
    try{
      let active=await this.broker.search({characterId:request.characterId,conversationId:request.conversationId,query:"",status:"active",limit:100});
      if(active.some(item=>item.metadata?.turnId===request.turnId))return [];

      const result=await this.extract(request);
      if(!result)return [];

      const created:MemoryItem[]=[];
      for(const candidate of result.memories){
        if(!this.safeCandidate(candidate,request.conversationId))continue;
        const keyContent=normalizedContentKey(candidate.content);
        if(active.some(item=>normalizedContentKey(item.content)===keyContent))continue;

        const replacementTarget=active.find(item=>sameSubjectShape(candidate,item));
        if(replacementTarget){
          try{
            const replacement=await this.broker.supersede(request.characterId,request.conversationId,replacementTarget.id,this.toCreateInput(candidate,request),this.authority());
            created.push(replacement);
            active=[...active.filter(item=>item.id!==replacementTarget.id),replacement];
          }catch{
            this.recordFailure("PERSISTENCE_SKIPPED","Memory replacement was not authorized or could not be persisted.");
          }
          continue;
        }
        try{
          const item=await this.broker.create(request.characterId,this.toCreateInput(candidate,request),this.authority());
          created.push(item);
          active=[...active,item];
        }catch{
          this.recordFailure("PERSISTENCE_SKIPPED","Memory candidate could not be persisted.");
        }
      }
      return created;
    }catch{
      this.recordFailure("EXTRACTION_FAILED","Automatic memory extraction failed; chat remains successful.");
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
      ]},
      generation:{responseFormat:{type:"json"}}
    };
    let response:ChatResponse;
    try{response=await this.runtime.chat(chatRequest,request.providerPresetId);}
    catch{this.recordFailure("PROVIDER_FAILURE","Memory extraction provider call failed.");return undefined;}
    let parsed:unknown;
    try{parsed=JSON.parse(response.message.content)}catch{this.recordFailure("MALFORMED_RESULT","Memory extraction returned malformed JSON.");return undefined;}
    const validation=this.validator.validate(parsed,STANDARD_SCHEMAS["memory-extraction-result"]!);
    if(!validation.valid){this.recordFailure("MALFORMED_RESULT","Memory extraction result failed schema validation.");return undefined;}
    return parsed as MemoryExtractionResult;
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
  private recordFailure(code:string,message:string):void{this.diagnostics?.recordError(this.source,code,message);}
}
