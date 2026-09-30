import type {
  AssembledContext,ChatErrorCode,ChatGenerationOptions,ChatMessage,ChatRequest,ChatResponse,ChatStreamEvent,MemoryExtractionRequest,
  ChatStreamHandlers,ChatStreamOptions,ChatUsage,CharacterId,ContextBuildRequest,ContextBudget,ModelProfile,Unsubscribe
} from "../../contracts/src/index";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION} from "../../contracts/src/index";

export interface ChatRuntimeBoundary{
  chat(request:ChatRequest,providerPresetId?:string):Promise<ChatResponse>;
  stream?(request:ChatRequest,handlers:ChatStreamHandlers,options?:ChatStreamOptions,providerPresetId?:string):Promise<ChatResponse>;
  getChatModel?(providerId?:string):Promise<string>;
  getChatModelForPreset?(providerPresetId:string):Promise<string>;
  getActiveProviderPresetId?():string|undefined;
}

export type ChatSessionStatus="idle"|"streaming"|"interrupted"|"completed"|"error";

export interface ConversationSnapshot{
  conversationId:string;
  characterId:CharacterId;
  messages:readonly ChatMessage[];
  sending:boolean;
  status:ChatSessionStatus;
  error?:string;
  errorCode?:ChatErrorCode;
}

export type ChatActionResult=
  | {status:"sent";response:ChatResponse}
  | {status:"interrupted";message:ChatMessage}
  | {status:"rejected";reason:"empty"|"busy"|"no-continuation"|"no-regeneration"|"no-retry"}
  | {status:"error";code:ChatErrorCode;message:string};

export type ChatSubmitResult=ChatActionResult;

const CHAT_ERROR_CODES=new Set<ChatErrorCode>(["INVALID_REQUEST","PROVIDER_NOT_FOUND","PROVIDER_UNAVAILABLE","PROVIDER_ERROR","INVALID_RESPONSE","UNSUPPORTED"]);
const USER_MESSAGES:Record<ChatErrorCode,string>={
  INVALID_REQUEST:"The message could not be sent.",
  PROVIDER_NOT_FOUND:"No chat provider is available. Check provider settings.",
  PROVIDER_UNAVAILABLE:"The chat provider is unavailable. Check provider settings or try again.",
  PROVIDER_ERROR:"The chat provider could not complete the request.",
  INVALID_RESPONSE:"The chat provider returned an invalid response.",
  UNSUPPORTED:"This chat request is not supported."
};
let requestSequence=0;

function defaultRequestId():string{
  requestSequence+=1;
  return "chat-"+Date.now()+"-"+requestSequence;
}
function cloneMessage(message:ChatMessage):ChatMessage{
  return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})};
}
function readChatErrorCode(error:unknown):ChatErrorCode|undefined{
  if(!error||typeof error!=="object"||!("chatError" in error))return undefined;
  const candidate=(error as {chatError?:unknown}).chatError;
  if(!candidate||typeof candidate!=="object"||!("code" in candidate))return undefined;
  const code=(candidate as {code?:unknown}).code;
  return typeof code==="string"&&CHAT_ERROR_CODES.has(code as ChatErrorCode)?code as ChatErrorCode:undefined;
}
function userMessageForError(error:unknown):{code:ChatErrorCode;message:string}{
  const code=readChatErrorCode(error)??"PROVIDER_ERROR";
  return {code,message:USER_MESSAGES[code]};
}
function isAbortError(error:unknown):boolean{
  return Boolean(error&&typeof error==="object"&&"name" in error&&(error as {name?:unknown}).name==="AbortError");
}
function streamStatus(message:ChatMessage):"complete"|"interrupted"|"streaming"|undefined{
  const value=message.metadata?.streamStatus;
  if(value==="complete"||value==="interrupted"||value==="streaming")return value;
  return message.role==="assistant"?"complete":undefined;
}
function withStreamMetadata(message:ChatMessage,status:"complete"|"interrupted"|"streaming",extra:Record<string,unknown>={}):ChatMessage{
  return {
    ...cloneMessage(message),
    metadata:{...(message.metadata??{}),streamStatus:status,...extra}
  };
}
function appendWithoutDuplicate(existing:string,incoming:string):string{
  if(!incoming)return existing;
  if(existing.endsWith(incoming))return existing;
  if(existing.length>0&&incoming.startsWith(existing))return incoming;
  const maxOverlap=Math.min(existing.length,incoming.length,4096);
  for(let length=maxOverlap;length>0;length--){
    if(existing.slice(-length)===incoming.slice(0,length))return existing+incoming.slice(length);
  }
  return existing+incoming;
}

export class ConversationSession{
  readonly conversationId:string;
  readonly characterId:CharacterId;
  private readonly messages:ChatMessage[]=[];
  constructor(conversationId:string,characterId:CharacterId){
    if(!conversationId.trim())throw new Error("Conversation id must not be empty.");
    if(!characterId.trim())throw new Error("Character id must not be empty.");
    this.conversationId=conversationId;
    this.characterId=characterId;
  }
  addMessage(message:ChatMessage):void{this.messages.push(cloneMessage(message))}
  replaceMessage(id:string,message:ChatMessage):void{
    const index=this.messages.findIndex(item=>item.id===id);
    if(index<0)throw new Error("Conversation message was not found.");
    this.messages[index]=cloneMessage(message);
  }
  removeMessage(id:string):void{
    const index=this.messages.findIndex(item=>item.id===id);
    if(index>=0)this.messages.splice(index,1);
  }
  getMessages():readonly ChatMessage[]{return this.messages.map(cloneMessage)}
  clear():void{this.messages.length=0}
}

export interface ChatContextBuilderBoundary{
  buildContext(request:ContextBuildRequest):Promise<AssembledContext>;
}
export interface ChatSessionMemoryExtractionBoundary{
  onCompletedTurn(input:{request:MemoryExtractionRequest;providerPresetId?:string}):Promise<void>;
}
export interface ChatSessionControllerOptions{
  requestIdFactory?:()=>string;
  contextBuilder?:ChatContextBuilderBoundary;
  contextBudget?:ContextBudget;
  memoryExtraction?:ChatSessionMemoryExtractionBoundary;
}
const DEFAULT_CHAT_CONTEXT_BUDGET:ContextBudget={
  availableContextTokens:4096,
  reservedOutputTokens:1024,
  systemOverheadTokens:0,
  safetyMarginTokens:128
};

type RunMode="submit"|"continue"|"regenerate"|"retry";
interface ActiveRun{
  id:number;
  mode:RunMode;
  requestId:string;
  assistantId:string;
  abortController:AbortController;
  stopRequested:boolean;
  originalAssistant?:ChatMessage;
  promise:Promise<ChatActionResult>;
}

export class ChatSessionController{
  private readonly listeners=new Set<(snapshot:ConversationSnapshot)=>void>();
  private readonly requestIdFactory:()=>string;
  private readonly contextBuilder?:ChatContextBuilderBoundary;
  private readonly contextBudget:ContextBudget;
  private readonly memoryExtraction?:ChatSessionMemoryExtractionBoundary;
  private modelProfile?:ModelProfile;
  private sending=false;
  private status:ChatSessionStatus="idle";
  private error?:string;
  private errorCode?:ChatErrorCode;
  private activeRun?:ActiveRun;
  private runSequence=0;

  constructor(
    private readonly session:ConversationSession,
    private readonly runtime:ChatRuntimeBoundary,
    options:ChatSessionControllerOptions={}
  ){
    this.requestIdFactory=options.requestIdFactory??defaultRequestId;
    this.contextBuilder=options.contextBuilder;
    this.contextBudget=options.contextBudget??DEFAULT_CHAT_CONTEXT_BUDGET;
    this.memoryExtraction=options.memoryExtraction;
    const messages=session.getMessages();
    const lastAssistant=[...messages].reverse().find(message=>message.role==="assistant");
    this.status=lastAssistant
      ?streamStatus(lastAssistant)==="interrupted"?"interrupted":"completed"
      :"idle";
  }

  setModelProfile(profile:ModelProfile|undefined):void{
    if(profile&&profile.characterId!==this.session.characterId)throw new Error("Model profile character scope does not match the conversation.");
    this.modelProfile=profile;
    this.notify();
  }
  getModelProfile():ModelProfile|undefined{return this.modelProfile}
  getSnapshot():ConversationSnapshot{
    return {
      conversationId:this.session.conversationId,
      characterId:this.session.characterId,
      messages:this.session.getMessages(),
      sending:this.sending,
      status:this.status,
      ...(this.error?{error:this.error}:{}),
      ...(this.errorCode?{errorCode:this.errorCode}: {})
    };
  }
  subscribe(listener:(snapshot:ConversationSnapshot)=>void):Unsubscribe{
    this.listeners.add(listener);
    return ()=>{this.listeners.delete(listener)};
  }
  clear():void{
    if(this.sending)return;
    this.session.clear();
    this.error=undefined;
    this.errorCode=undefined;
    this.status="idle";
    this.notify();
  }

  async submit(content:string,model:string):Promise<ChatSubmitResult>{
    const text=content.trim();
    if(!text)return {status:"rejected",reason:"empty"};
    if(this.sending)return {status:"rejected",reason:"busy"};
    const requestId=this.requestIdFactory();
    const userMessage:ChatMessage={id:requestId+":user",role:"user",content:text};
    this.session.addMessage(userMessage);
    return this.startRun("submit",requestId,model,userMessage);
  }

  async stop():Promise<ChatActionResult>{
    const active=this.activeRun;
    if(!active||!this.sending)return {status:"rejected",reason:"busy"};
    active.stopRequested=true;
    active.abortController.abort();
    return active.promise;
  }

  async continue(model:string):Promise<ChatActionResult>{
    if(this.sending)return {status:"rejected",reason:"busy"};
    const {assistant,user}=this.lastTurn();
    if(!assistant||!user||!assistant.id||streamStatus(assistant)!=="interrupted")return {status:"rejected",reason:"no-continuation"};
    return this.startRun("continue",this.requestIdFactory(),model,user,assistant);
  }

  async regenerate(model:string):Promise<ChatActionResult>{
    if(this.sending)return {status:"rejected",reason:"busy"};
    const {assistant,user}=this.lastTurn();
    const interrupted=assistant?streamStatus(assistant)==="interrupted":false;
    const complete=assistant?streamStatus(assistant)==="complete":false;
    if(!assistant||!user||!assistant.id||(!complete&&!interrupted))return {status:"rejected",reason:"no-regeneration"};
    return this.startRun("regenerate",this.requestIdFactory(),model,user,assistant);
  }

  async retry(model:string):Promise<ChatActionResult>{
    if(this.sending||this.status!=="error")return {status:"rejected",reason:this.sending?"busy":"no-retry"};
    const {assistant,user}=this.lastTurn();
    if(!user||!user.id)return {status:"rejected",reason:"no-retry"};
    return this.startRun("retry",this.requestIdFactory(),model,user,assistant&&assistant.id?assistant:undefined);
  }

  private lastTurn():{assistant?:ChatMessage;user?:ChatMessage}{
    const messages=this.session.getMessages();
    const assistant=[...messages].reverse().find(message=>message.role==="assistant");
    if(!assistant)return {user:[...messages].reverse().find(message=>message.role==="user")};
    const assistantIndex=messages.findIndex(message=>message.id===assistant.id);
    const user=assistantIndex>0?[...messages.slice(0,assistantIndex)].reverse().find(message=>message.role==="user"):undefined;
    return {assistant,user};
  }

  private startRun(
    mode:RunMode,
    requestId:string,
    model:string,
    userMessage:ChatMessage,
    assistantMessage?:ChatMessage
  ):Promise<ChatActionResult>{
    const active:ActiveRun={
      id:++this.runSequence,
      mode,
      requestId,
      assistantId:assistantMessage?.id??requestId+":assistant",
      abortController:new AbortController(),
      stopRequested:false,
      ...(assistantMessage?{originalAssistant:cloneMessage(assistantMessage)}:{}),
      promise:Promise.resolve({status:"error",code:"PROVIDER_ERROR",message:"Chat run did not start."})
    };
    this.activeRun=active;
    this.sending=true;
    this.status="streaming";
    this.error=undefined;
    this.errorCode=undefined;
    this.notify();
    const promise=this.run(active,model,userMessage,assistantMessage);
    active.promise=promise;
    return promise;
  }

  private async run(
    active:ActiveRun,
    model:string,
    userMessage:ChatMessage,
    assistantMessage?:ChatMessage
  ):Promise<ChatActionResult>{
    const rawConversationMessages=this.session.getMessages();
    let contextMessages=rawConversationMessages;
    if(assistantMessage?.id&&active.mode!=="continue"){
      contextMessages=contextMessages.filter(message=>message.id!==assistantMessage.id);
    }

    try{
      if(this.contextBuilder){
        const assembled=await this.contextBuilder.buildContext({
          apiVersion:"1",
          schemaVersion:"1",
          characterId:this.session.characterId,
          conversationId:this.session.conversationId,
          messages:contextMessages,
          budget:this.contextBudget
        });
        contextMessages=assembled.messages;
      }
      if(active.stopRequested)return this.markInterrupted(active,assistantMessage);

      const request=await this.buildRequest(active.requestId,model,contextMessages);
      const currentAssistant=assistantMessage?cloneMessage(assistantMessage):{id:active.assistantId,role:"assistant" as const,content:""};
      const generationAssistant=(active.mode==="regenerate"||active.mode==="retry")
        ?{...currentAssistant,content:""}
        :currentAssistant;
      if(active.mode==="submit"){
        this.session.addMessage(withStreamMetadata(generationAssistant,"streaming"));
      }else{
        this.session.replaceMessage(active.assistantId,withStreamMetadata(generationAssistant,"streaming"));
      }
      this.notify();

      let streamedUsage:ChatUsage|undefined;
      let finishReason:ChatResponse["finishReason"]="unknown";
      let response:ChatResponse|undefined;

      const onEvent=async(event:ChatStreamEvent)=>{
        if(active.stopRequested||this.activeRun?.id!==active.id)return;
        if(event.type==="delta"){
          const current=this.session.getMessages().find(message=>message.id===active.assistantId);
          if(!current)return;
          const content=active.mode==="continue"
            ?appendWithoutDuplicate(current.content,event.text)
            :current.content+event.text;
          this.session.replaceMessage(active.assistantId,withStreamMetadata({...current,content},"streaming"));
          this.notify();
        }else if(event.type==="usage"){
          streamedUsage=event.usage;
        }else if(event.type==="completed"){
          finishReason=event.finishReason;
          streamedUsage=event.usage??streamedUsage;
        }
      };

      if(this.runtime.stream){
        response=await this.runtime.stream(
          request,
          {onEvent},
          {signal:active.abortController.signal},
          this.modelProfile?.providerPresetId??this.runtime.getActiveProviderPresetId?.()
        );
      }else{
        response=await this.runtime.chat(
          request,
          this.modelProfile?.providerPresetId??this.runtime.getActiveProviderPresetId?.()
        );
        await onEvent({
          apiVersion:"1",
          schemaVersion:"1",
          requestId:request.requestId,
          conversationId:request.context.conversationId,
          providerId:response.providerId,
          model:response.model,
          type:"delta",
          text:response.message.content
        });
        await onEvent({
          apiVersion:"1",
          schemaVersion:"1",
          requestId:request.requestId,
          conversationId:request.context.conversationId,
          providerId:response.providerId,
          model:response.model,
          type:"completed",
          finishReason:response.finishReason,
          ...(response.usage?{usage:response.usage}: {})
        });
      }

      if(active.stopRequested)return this.markInterrupted(active,this.session.getMessages().find(message=>message.id===active.assistantId));
      if(!response)throw new Error("Chat runtime returned no response.");

      const finalMessage=this.session.getMessages().find(message=>message.id===active.assistantId);
      if(!finalMessage)throw new Error("Assistant stream message was lost.");
      const canonicalFinishReason=finishReason==="unknown"?response.finishReason:finishReason;
      const canonicalUsage=streamedUsage??response.usage;
      const canonicalMessage=withStreamMetadata(finalMessage,"complete",{
        finishReason:canonicalFinishReason,
        ...(canonicalUsage?{usage:canonicalUsage}: {})
      });
      this.session.replaceMessage(active.assistantId,canonicalMessage);
      this.status="completed";
      this.error=undefined;
      this.errorCode=undefined;
      this.notify();

      if(this.memoryExtraction){
        const extractionMessages=rawConversationMessages
          .filter(message=>message.id!==userMessage.id&&message.id!==assistantMessage?.id)
          .filter(message=>message.role==="user"||message.role==="assistant")
          .slice(-8);
        const extractionRequest:MemoryExtractionRequest={
          requestId:active.requestId,
          apiVersion:"1",
          schemaVersion:"1",
          model:request.model,
          characterId:this.session.characterId,
          conversationId:this.session.conversationId,
          userMessage:cloneMessage(userMessage),
          assistantMessage:cloneMessage(canonicalMessage),
          contextMessages:extractionMessages
        };
        const providerPresetId=this.modelProfile?.providerPresetId??this.runtime.getActiveProviderPresetId?.();
        void this.memoryExtraction.onCompletedTurn({request:extractionRequest,providerPresetId}).catch(()=>{});
      }

      this.notify();

      const canonicalResponse:ChatResponse={
        ...response,
        finishReason:canonicalFinishReason,
        message:canonicalMessage,
        ...(canonicalUsage?{usage:canonicalUsage}:{})
      };
      return {status:"sent",response:canonicalResponse};
    }catch(error){
      if(active.stopRequested||isAbortError(error)){
        return this.markInterrupted(active,this.session.getMessages().find(message=>message.id===active.assistantId));
      }
      const normalized=userMessageForError(error);
      const current=this.session.getMessages().find(message=>message.id===active.assistantId);
      if(current?.content){
        this.session.replaceMessage(active.assistantId,withStreamMetadata(current,"interrupted"));
      }else if(active.originalAssistant){
        this.session.replaceMessage(active.assistantId,active.originalAssistant);
      }else if(current){
        this.session.removeMessage(active.assistantId);
      }
      this.status="error";
      this.error=normalized.message;
      this.errorCode=normalized.code;
      this.notify();
      return {status:"error",...normalized};
    }finally{
      if(this.activeRun?.id===active.id)this.activeRun=undefined;
      this.sending=false;
      this.notify();
    }
  }

  private async buildRequest(requestId:string,model:string,messages:readonly ChatMessage[]):Promise<ChatRequest>{
    const profile=this.modelProfile;
    const profileProviderId=profile?.providerId;
    const profileProviderPresetId=profile?.providerPresetId??this.runtime.getActiveProviderPresetId?.();
    let resolvedModel=model;
    if(profile?.model===undefined&&profileProviderPresetId!==undefined&&this.runtime.getChatModelForPreset){
      try{resolvedModel=await this.runtime.getChatModelForPreset(profileProviderPresetId)}catch{/* manual model remains fallback */}
    }else if(profile?.model===undefined&&profileProviderPresetId===undefined&&profileProviderId!==undefined&&this.runtime.getChatModel){
      try{resolvedModel=await this.runtime.getChatModel(profileProviderId)}catch{/* manual model remains fallback */}
    }
    const generation=profile?.generation;
    const hasGeneration=Boolean(generation&&Object.keys(generation).length>0);
    return {
      apiVersion:CHAT_API_VERSION,
      schemaVersion:CHAT_SCHEMA_VERSION,
      requestId,
      ...(profileProviderId!==undefined?{providerId:profileProviderId}: {}),
      model:profile?.model??resolvedModel,
      context:{conversationId:this.session.conversationId,messages},
      ...(hasGeneration&&generation?{generation:cloneGeneration(generation)}:{})
    };
  }

  private markInterrupted(active:ActiveRun,current?:ChatMessage):ChatActionResult{
    const original=active.originalAssistant;
    let message=current?cloneMessage(current):original?cloneMessage(original):undefined;
    if(message?.id&&active.mode==="submit"){
      if(message.content){
        this.session.replaceMessage(message.id,withStreamMetadata(message,"interrupted"));
      }else{
        this.session.removeMessage(message.id);
        message=undefined;
      }
    }else if(message?.id&&original&&message.content.length===0){
      message=cloneMessage(original);
      const messageId=message.id;
      if(messageId&&this.session.getMessages().some(item=>item.id===messageId))this.session.replaceMessage(messageId,message);
    }else if(message?.id){
      this.session.replaceMessage(message.id,withStreamMetadata(message,"interrupted"));
    }
    this.status="interrupted";
    this.error=undefined;
    this.errorCode=undefined;
    const finalMessage=this.session.getMessages().find(item=>item.id===active.assistantId);
    return {
      status:"interrupted",
      message:finalMessage??message??{id:active.assistantId,role:"assistant",content:"",metadata:{streamStatus:"interrupted"}}
    };
  }

  private notify():void{
    const snapshot=this.getSnapshot();
    for(const listener of [...this.listeners]){
      try{listener(snapshot)}catch{ /* observer failures must not break chat */ }
    }
  }
}

function cloneGeneration(generation:ChatGenerationOptions):ChatGenerationOptions{
  return {
    ...(generation.temperature===undefined?{}:{temperature:generation.temperature}),
    ...(generation.maxTokens===undefined?{}:{maxTokens:generation.maxTokens}),
    ...(generation.topP===undefined?{}:{topP:generation.topP}),
    ...(generation.responseFormat===undefined?{}:{responseFormat:generation.responseFormat.type==="text"?{type:"text"}:{type:"json",schema:{...generation.responseFormat.schema}}})
  };
}
