import type {
  ChatRequest,ChatTraceStore,ChatTurnTrace,DiagnosticsLogLevel,DiagnosticsStore,ErrorDiagnostic,Logger
} from "../../contracts/src/index";

const REDACTIONS:[
  RegExp,string
][]=[
  [/authorization\s*:\s*bearer\s+\S+/gi,"Authorization: Bearer [REDACTED]"],
  [/\bbearer\s+[A-Za-z0-9._-]{16,}\b/gi,"Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g,"[REDACTED_API_KEY]"],
  [/api[_ -]?key\s*[:=]\s*\S+/gi,"apiKey: [REDACTED]"],
  [/password\s*[:=]\s*\S+/gi,"password: [REDACTED]"],
  [/secret\s*[:=]\s*\S+/gi,"secret: [REDACTED]"]
];

export function redactDiagnosticText(value:string):string{
  let next=value;
  for(const [pattern,replacement] of REDACTIONS)next=next.replace(pattern,replacement);
  return next;
}

function sanitizeRecord(value:unknown):unknown{
  if(typeof value==="string")return redactDiagnosticText(value);
  if(Array.isArray(value))return value.map(sanitizeRecord);
  if(value&&typeof value==="object"){
    const source=value as Record<string,unknown>;
    return Object.fromEntries(Object.entries(source).map(([key,item])=>{
      if(/^(apiKey|api[_-]?key|authorization|bearer|password|secret|credential|credentialReference)$/i.test(key))return [key,"[REDACTED]"];
      return [key,sanitizeRecord(item)];
    }));
  }
  return value;
}

function sanitizeChatRequest(request:ChatRequest):ChatRequest{
  return {
    ...request,
    ...(request.context?{
      context:{
        ...request.context,
        messages:request.context.messages.map(message=>({
          ...message,
          content:redactDiagnosticText(message.content),
          ...(message.metadata?{metadata:sanitizeRecord(message.metadata) as Record<string,unknown>}: {})
        })),
        ...(request.context.metadata?{metadata:sanitizeRecord(request.context.metadata) as Record<string,unknown>}: {})
      }
    }:{}),
    ...(request.metadata?{metadata:sanitizeRecord(request.metadata) as Record<string,unknown>}: {}),
    ...(request.generation?.responseFormat?.type==="json"
      ?{generation:{...request.generation,responseFormat:{type:"json",schema:sanitizeRecord(request.generation.responseFormat.schema) as Record<string,unknown>}}}
      :{})
  };
}

function cloneCandidate(candidate:any):any{
  return sanitizeRecord(candidate);
}

function cloneTrace(trace:ChatTurnTrace):ChatTurnTrace{
  return sanitizeRecord(trace) as ChatTurnTrace;
}

export class InMemoryDiagnosticsStore implements DiagnosticsStore{
  private readonly errors:ErrorDiagnostic[]=[];
  private maxEntries:number;
  constructor(maxEntries=100){this.maxEntries=maxEntries;}
  setMaxEntries(maxEntries:number):void{
    this.maxEntries=Math.max(1,Math.floor(maxEntries));
    if(this.errors.length>this.maxEntries)this.errors.splice(0,this.errors.length-this.maxEntries);
  }
  recordError(source:string,code:string,message:string,metadata?:Record<string,unknown>):void{
    this.errors.push({
      timestamp:new Date().toISOString(),
      source:redactDiagnosticText(source),
      code:redactDiagnosticText(code),
      message:redactDiagnosticText(message),
      ...(metadata?{metadata:sanitizeRecord(metadata) as Record<string,unknown>}: {})
    });
    if(this.errors.length>this.maxEntries)this.errors.splice(0,this.errors.length-this.maxEntries);
  }
  recentErrors(limit=Math.min(20,this.maxEntries)):readonly ErrorDiagnostic[]{
    return this.errors.slice(-Math.max(1,limit)).reverse().map(item=>sanitizeRecord(item) as unknown as ErrorDiagnostic);
  }
}

export class InMemoryChatTraceStore implements ChatTraceStore{
  private readonly traces:ChatTurnTrace[]=[];
  private level:DiagnosticsLogLevel="normal";
  private maxEntries=100;

  configure(level:DiagnosticsLogLevel,maxEntries:number):void{
    this.level=level;
    this.maxEntries=Math.max(1,Math.floor(maxEntries));
    if(this.traces.length>this.maxEntries)this.traces.splice(0,this.traces.length-this.maxEntries);
  }

  start(trace:Pick<ChatTurnTrace,"turnId"|"requestId"|"characterId"|"conversationId"|"timestamp">):void{
    if(this.level==="off")return;
    this.traces.push({...trace,status:"started"});
    if(this.traces.length>this.maxEntries)this.traces.splice(0,this.traces.length-this.maxEntries);
  }

  update(turnId:string,patch:Partial<Omit<ChatTurnTrace,"turnId"|"requestId"|"characterId"|"conversationId"|"timestamp">>):void{
    if(this.level==="off")return;
    let index=this.traces.findIndex(item=>item.turnId===turnId);
    if(index<0){
      if(patch.status!=="failed"&&patch.status!=="interrupted")return;
      return;
    }
    const current=this.traces[index]!;
    const memoryPatch=patch.memoryExtraction;
    const next:ChatTurnTrace={
      ...current,
      ...patch,
      ...(patch.finalRequest?{finalRequest:sanitizeChatRequest(patch.finalRequest)}:{}),
      ...(patch.contextBuild?{
        contextBuild:{
          ...patch.contextBuild,
          includedCandidates:patch.contextBuild.includedCandidates.map(cloneCandidate),
          omittedCandidates:patch.contextBuild.omittedCandidates.map(cloneCandidate)
        }
      }:current.contextBuild?{contextBuild:current.contextBuild}:{}),
      ...(memoryPatch?{
        memoryExtraction:{
          started:memoryPatch.started??current.memoryExtraction?.started??false,
          ...(memoryPatch.status!==undefined?{status:memoryPatch.status}:current.memoryExtraction?.status!==undefined?{status:current.memoryExtraction.status}:{}),
          ...(memoryPatch.requestId!==undefined?{requestId:redactDiagnosticText(memoryPatch.requestId)}:current.memoryExtraction?.requestId!==undefined?{requestId:current.memoryExtraction.requestId}:{}),
          ...(memoryPatch.providerId!==undefined?{providerId:redactDiagnosticText(memoryPatch.providerId)}:current.memoryExtraction?.providerId!==undefined?{providerId:current.memoryExtraction.providerId}:{}),
          ...(memoryPatch.model!==undefined?{model:redactDiagnosticText(memoryPatch.model)}:current.memoryExtraction?.model!==undefined?{model:current.memoryExtraction.model}:{}),
          ...(memoryPatch.conversationId!==undefined?{conversationId:redactDiagnosticText(memoryPatch.conversationId)}:current.memoryExtraction?.conversationId!==undefined?{conversationId:current.memoryExtraction.conversationId}:{}),
          ...(memoryPatch.contextMessageCount!==undefined?{contextMessageCount:memoryPatch.contextMessageCount}:current.memoryExtraction?.contextMessageCount!==undefined?{contextMessageCount:current.memoryExtraction.contextMessageCount}:{}),
          candidates:(memoryPatch.candidates??current.memoryExtraction?.candidates??[]).map(cloneCandidate),
          accepted:(memoryPatch.accepted??current.memoryExtraction?.accepted??[]).map(cloneCandidate),
          rejected:(memoryPatch.rejected??current.memoryExtraction?.rejected??[]).map(cloneCandidate),
          duplicate:(memoryPatch.duplicate??current.memoryExtraction?.duplicate??[]).map(cloneCandidate),
          superseded:memoryPatch.superseded??current.memoryExtraction?.superseded??[],
          created:memoryPatch.created??current.memoryExtraction?.created??[],
          ...(memoryPatch.failed!==undefined?{failed:redactDiagnosticText(memoryPatch.failed)}:current.memoryExtraction?.failed!==undefined?{failed:current.memoryExtraction.failed}:{})
        }
      }:current.memoryExtraction?{memoryExtraction:current.memoryExtraction}:{})
    };
    this.traces[index]=cloneTrace(next);
  }

  recent(limit=Math.min(20,this.maxEntries)):readonly ChatTurnTrace[]{
    const result=this.traces.slice(-Math.max(1,limit)).reverse();
    if(this.level==="errors")return result.filter(item=>item.status==="failed"||item.status==="interrupted");
    if(this.level==="off")return [];
    return result.map(cloneTrace);
  }

  clear():void{this.traces.length=0;}
}

export const createConsoleLogger=():Logger=>({
  debug(message,metadata){console.debug(redactDiagnosticText(message),sanitizeRecord(metadata));},
  info(message,metadata){console.info(redactDiagnosticText(message),sanitizeRecord(metadata));},
  warn(message,metadata){console.warn(redactDiagnosticText(message),sanitizeRecord(metadata));},
  error(message,metadata){console.error(redactDiagnosticText(message),sanitizeRecord(metadata));}
});

export const createMemoryConfig=()=>{
  const values=new Map<string,unknown>();
  return {
    get:<T>(key:string)=>values.get(key) as T|undefined,
    set:async<T>(key:string,value:T)=>{values.set(key,value);}
  };
};
