import type {ChatContext,ChatError,ChatRequest,ChatResponse,ChatProvider,DiagnosticsStore,EventBus,HealthStatus,SchemaValidator} from "../../contracts/src/index";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,STANDARD_SCHEMAS,createEvent,StandardContractValidator} from "../../contracts/src/index";
import {ProviderRegistry} from "./providers";

export type AiRuntimeErrorCode=ChatError["code"];

export class AiRuntimeError extends Error{
  readonly code:AiRuntimeErrorCode;
  readonly chatError:ChatError;
  constructor(error:ChatError){super(error.message);this.name="AiRuntimeError";this.code=error.code;this.chatError=error;}
}

export interface AiRuntimeOptions{validator?:SchemaValidator;diagnostics?:DiagnosticsStore;events?:EventBus;clock?:()=>string}
export interface ChatContextInput{conversationId:string;messages:readonly ChatContext["messages"][number][];metadata?:Record<string,unknown>}
export const createChatContext=(input:ChatContextInput):ChatContext=>({conversationId:input.conversationId,messages:[...input.messages],...(input.metadata===undefined?{}:{metadata:{...input.metadata}})});

function readProviderChatError(error:unknown,validator:SchemaValidator):ChatError|undefined{
  if(!error||typeof error!=="object"||!("chatError" in error))return undefined;
  const candidate=(error as {chatError?:unknown}).chatError;
  if(candidate===undefined)return undefined;
  const result=validator.validate(candidate,STANDARD_SCHEMAS["chat-error"]!);
  return result.valid?candidate as ChatError:undefined;
}

export class AiRuntime{
  private readonly validator:SchemaValidator;
  private readonly clock:()=>string;
  constructor(private readonly providers:ProviderRegistry,private readonly options:AiRuntimeOptions={}){this.validator=options.validator??new StandardContractValidator();this.clock=options.clock??(()=>new Date().toISOString());}
  async health():Promise<HealthStatus>{const providers=this.providers.list("chat");if(providers.length===0)return {status:"unavailable",message:"No chat providers registered.",capabilities:["chat-runtime"]};return {status:"healthy",capabilities:["chat-runtime"]};}
  async generate(request:ChatRequest):Promise<ChatResponse>{
    const requestResult=this.validator.validate(request,STANDARD_SCHEMAS["chat-request"]!);
    if(!requestResult.valid)return this.fail({apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,code:"INVALID_REQUEST",message:"Chat request failed contract validation.",requestId:request.requestId,providerId:request.providerId,details:{errors:[...requestResult.errors]}},request.context?.conversationId);
    const provider=this.resolveProvider(request.providerId);
    if(!provider)return this.fail({apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,code:request.providerId?"PROVIDER_NOT_FOUND":"PROVIDER_UNAVAILABLE",message:request.providerId?"Requested chat provider is not registered.":"No chat provider is registered.",requestId:request.requestId,providerId:request.providerId},request.context.conversationId);
    const providerId=provider.id;
    await this.options.events?.publish(createEvent("ChatRequestStarted",{requestId:request.requestId,conversationId:request.context.conversationId,providerId,model:request.model},"ai-runtime",this.clock,request.requestId+":started"));
    try{
      const response=await provider.chat(request);
      const normalized:ChatResponse={...response,apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:request.requestId,conversationId:request.context.conversationId,providerId,model:request.model};
      const responseResult=this.validator.validate(normalized,STANDARD_SCHEMAS["chat-response"]!);
      if(!responseResult.valid)return this.fail({apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,code:"INVALID_RESPONSE",message:"Chat provider returned an invalid canonical response.",requestId:request.requestId,providerId,details:{errors:[...responseResult.errors]}},request.context.conversationId);
      await this.options.events?.publish(createEvent("ChatResponseReceived",{requestId:request.requestId,conversationId:request.context.conversationId,providerId,model:request.model,finishReason:normalized.finishReason},"ai-runtime",this.clock,request.requestId+":received"));
      return normalized;
    }catch(error){
      const providerError=readProviderChatError(error,this.validator);
      if(providerError){
        return this.fail({
          ...providerError,
          apiVersion:CHAT_API_VERSION,
          schemaVersion:CHAT_SCHEMA_VERSION,
          requestId:request.requestId,
          providerId
        },request.context.conversationId);
      }
      return this.fail({
        apiVersion:CHAT_API_VERSION,
        schemaVersion:CHAT_SCHEMA_VERSION,
        code:"PROVIDER_ERROR",
        message:"Chat provider generation failed.",
        requestId:request.requestId,
        providerId
      },request.context.conversationId);
    }
  }
  private resolveProvider(providerId?:string):ChatProvider|undefined{const registrations=this.providers.list("chat");if(providerId){const match=registrations.find(item=>item.provider.id===providerId);return match?.provider as ChatProvider|undefined;}return registrations[0]?.provider as ChatProvider|undefined;}
  private async fail(error:ChatError,conversationId?:string):Promise<never>{
    await this.options.events?.publish(createEvent("ChatRequestFailed",{requestId:error.requestId??"unknown",...(conversationId?{conversationId}:{}),...(error.providerId?{providerId:error.providerId}:{}),code:error.code},"ai-runtime",this.clock,(error.requestId??"unknown")+":failed:"+error.code)).catch(()=>undefined);
    this.options.diagnostics?.recordError("ai-runtime",error.code,error.message,{requestId:error.requestId,providerId:error.providerId,...(error.details?{details:error.details}:{})});
    throw new AiRuntimeError(error);
  }
}
