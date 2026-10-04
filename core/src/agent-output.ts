import type {
  AgentOutputMode,ChatRequest,ChatResponse,DiagnosticsStore,JsonSchema,SchemaValidator
} from "../../contracts/src/index";

export interface AgentOutputExecutionMetadata{
  configuredOutputMode:AgentOutputMode;
  effectiveOutputMode:"structured"|"plain";
  structuredAttempt:boolean;
  fallback:boolean;
  fallbackReason?:string;
  schemaName?:string;
}

export interface AgentOutputExecutionResult<T>{
  value:T;
  response:ChatResponse;
  metadata:AgentOutputExecutionMetadata;
}

export interface AgentOutputRuntime{
  chat(request:ChatRequest,providerPresetId?:string):Promise<ChatResponse>;
}

export interface AgentOutputRunnerOptions<T>{
  outputMode:AgentOutputMode;
  request:ChatRequest;
  providerPresetId?:string;
  schemaName:string;
  schema:JsonSchema;
  validator:SchemaValidator;
  parseStructured(value:unknown):T;
  parsePlain(content:string):T;
  diagnostics?:DiagnosticsStore;
  source?:string;
}

function isCapabilityUnsupported(error:unknown):boolean{
  if(!error||typeof error!=="object")return false;
  const record=error as Record<string,unknown>;
  if(record.code==="UNSUPPORTED"){
    const details=record.details;
    return !details||typeof details!=="object"||((details as Record<string,unknown>).category==="capability");
  }
  const nested=record.chatError;
  if(nested&&typeof nested==="object"){
    const chatError=nested as Record<string,unknown>;
    const details=chatError.details;
    return chatError.code==="UNSUPPORTED"&&!!details&&typeof details==="object"&&(details as Record<string,unknown>).category==="capability";
  }
  return false;
}

function redactError(error:unknown):string{
  const raw=error instanceof Error?error.message:"Agent output request failed.";
  return raw.replace(/authorization\s*:\s*bearer\s+\S+/gi,"Authorization: Bearer [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._-]{16,}\b/gi,"Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gi,"[REDACTED]");
}

export function assertAgentCandidateId(candidateId:string,allowedIds:readonly string[]):string{
  if(!allowedIds.includes(candidateId))throw new Error("Agent decision referenced an ID outside the provided candidate set.");
  return candidateId;
}

export class AgentOutputRunner{
  constructor(private readonly runtime:AgentOutputRuntime,private readonly validator:SchemaValidator){}

  async run<T>(options:AgentOutputRunnerOptions<T>):Promise<AgentOutputExecutionResult<T>>{
    const outputMode=options.outputMode;
    const source=options.source??"agent-output";
    const structuredRequest:ChatRequest={
      ...options.request,
      generation:{
        ...(options.request.generation??{}),
        responseFormat:{
          type:"json-schema",
          schema:options.schema,
          name:options.schemaName,
          strict:true
        }
      }
    };
    const plainGeneration=options.request.generation
      ?Object.fromEntries(Object.entries(options.request.generation).filter(([key])=>key!=="responseFormat"))
      :undefined;
    const plainRequest:ChatRequest={
      ...options.request,
      ...(plainGeneration?{generation:plainGeneration}:{}),
      ...(plainGeneration===undefined?{generation:undefined}:{})
    };
    const runStructured=async():Promise<AgentOutputExecutionResult<T>>=>{
      options.diagnostics?.recordError(source,"AGENT_STRUCTURED_ATTEMPT","Structured agent output requested",{
        outputMode,schemaName:options.schemaName
      });
      const response=await this.runtime.chat(structuredRequest,options.providerPresetId);
      let parsedJson:unknown;
      try{parsedJson=JSON.parse(response.message.content);}catch{
        options.diagnostics?.recordError(source,"AGENT_STRUCTURED_INVALID_JSON","Structured agent response was not valid JSON",{schemaName:options.schemaName});
        throw new Error("Structured agent response was not valid JSON.");
      }
      const schemaResult=this.validator.validate(parsedJson,options.schema);
      if(!schemaResult.valid){
        options.diagnostics?.recordError(source,"AGENT_STRUCTURED_SCHEMA_INVALID","Structured agent response failed schema validation",{schemaName:options.schemaName,errorCount:schemaResult.errors.length});
        throw new Error("Structured agent response failed schema validation.");
      }
      const value=options.parseStructured(parsedJson);
      return {
        value,response,
        metadata:{
          configuredOutputMode:outputMode,
          effectiveOutputMode:"structured",
          structuredAttempt:true,
          fallback:false,
          schemaName:options.schemaName
        }
      };
    };
    if(outputMode==="structured")return runStructured();
    if(outputMode==="plain"){
      const response=await this.runtime.chat(plainRequest,options.providerPresetId);
      const value=options.parsePlain(response.message.content);
      return {value,response,metadata:{configuredOutputMode:outputMode,effectiveOutputMode:"plain",structuredAttempt:false,fallback:false}};
    }
    try{
      return await runStructured();
    }catch(error){
      if(!isCapabilityUnsupported(error)){
        options.diagnostics?.recordError(source,"AGENT_OUTPUT_FAILED","Structured agent output failed without fallback",{
          outputMode,schemaName:options.schemaName,error:redactError(error)
        });
        throw error;
      }
      options.diagnostics?.recordError(source,"AGENT_OUTPUT_FALLBACK","Structured output unsupported; falling back to plain",{
        outputMode,schemaName:options.schemaName,fallbackReason:"UNSUPPORTED / capability"
      });
      const response=await this.runtime.chat(plainRequest,options.providerPresetId);
      const value=options.parsePlain(response.message.content);
      return {
        value,response,
        metadata:{
          configuredOutputMode:outputMode,
          effectiveOutputMode:"plain",
          structuredAttempt:true,
          fallback:true,
          fallbackReason:"UNSUPPORTED / capability"
        }
      };
    }
  }
}
