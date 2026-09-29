import type {
  AssembledContext,ChatErrorCode,ChatMessage,ChatRequest,ChatResponse,ChatStreamEvent,ChatStreamHandlers,
  ChatStreamOptions,CharacterId,ContextBuildRequest,ContextBudget,Unsubscribe,ModelProfile
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
  if(typeof code!=="string"||!CHAT_ERROR_CODES.has(code as ChatErrorCode))return undefined;
  return code as ChatErrorCode;
}
function userMessageForError(error:unknown):{code:ChatErrorCode;message:string}{
  const code=readChatErrorCode(error)??"PROVIDER_ERROR";
  return {code,message:USER_MESSAGES[code]};
}
function isAbortError(error:unknown):boolean{
  if(error&&typeof error==="object"&&"name" in error)return (error as {name?:unknown}).name==="AbortError";
  return false;
}
function streamStatus(message:ChatMessage):"complete"|"interrupted"|"streaming"|undefined{
  const value=message.metadata?.streamStatus;
  return value==="complete"||value==="interrupted"||value==="streaming"?value:undefined;
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
  if(incoming.startsWith(existing)&&existing.length>0)return incoming;
  const maxOverlap=Math.min(existing.length,incoming.length,4096);
  for(let length=maxOverlap;length>0;length--){
    if(existing.slice(-length)===incoming.slice(0,length))return existing+incoming.slice(length);
  }
  return existing+incoming;
}

export class ConversationSession{
  readonly conversationId:string;
  private readonly messages:ChatMessage[]=[];
  readonly characterId:CharacterId;
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

export interface ChatSessionControllerOptions{
  requestIdFactory?:()=>string;
  contextBuilder?:ChatContextBuilderBoundary;
  contextBudget?:ContextBudget;
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
  assistantId:string;
  abortController:AbortController;
  stopRequested:boolean;
  promise:Promise<ChatActionResult>;
  originalAssistant?:ChatMessage;
}

export class ChatSessionController{
  private readonly listeners=new Set<(snapshot:ConversationSnapshot)=>void>();
  private readonly requestIdFactory:()=>string;
  private readonly contextBuilder?:ChatContextBuilderBoundary;
  private readonly contextBudget:ContextBudget;
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
    this.status=session.getMessages().some(message=>message.role==="assistant"&&streamStatus(message)==="interrupted")
      ?"interrupted"
      :session.getMessages().some(message=>message.role==="assistant")
        ?"completed"
        :"idle";
  }

  setModelProfile(profile:ModelProfile|undefined):void{
    if(profile&&profile.characterId!==this.session.characterId)throw new Error("Model profile character scope does not match the conversation.");
    this.modelProfile=profile;
    this.notify();
  }

  getModelProfile():ModelProfile|undefined{
    return this.modelProfile;
  }

  getSnapshot():ConversationSnapshot{
    return {
      conversationId:this.session.conversationId,
      characterId:this.session.characterId,
      messages:this.session.getMessages(),
      sending:this.sending,
      status:this.status,
      ...(this.error?{error:this.error}:{}),
      ...(this.errorCode?{errorCode:this.errorCode}:{})
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
    return this.beginRun("submit",model,userMessage);
  }

  async stop():Promise<ChatActionResult>{
    const active=this.activeRun;
    if(!active)return {status:"rejected",reason:"busy"};
    active.stopRequested=true;
    active.abortController.abort();
    return active.promise;
  }

  async continue(model:string):Promise<ChatActionResult>{
    if(this.sending)return {status:"rejected",reason:"busy"};
    const messages=this.session.getMessages();
    const assistant=[...messages].reverse().find(message=>message.role==="assistant");
    if(!assistant||streamStatus(assistant)!=="interrupted"||!assistant.id)return {status:"rejected",reason:"no-continuation"};
    const index=messages.findIndex(message=>message.id===assistant.id);
    const user=index>0?[...messages.slice(0,index)].reverse().find(message=>message.role==="user"):undefined;
    if(!user||!user.id)return {status:"rejected",reason:"no-continuation"};
    return this.beginRun("continue",model,user,assistant);
  }

  async regenerate(model:string):Promise<ChatActionResult>{
    if(this.sending)return {status:"rejected",reason:"busy"};
    const messages=this.session.getMessages();
    const assistant=[...messages].reverse().find(message=>message.role==="assistant");
    if(!assistant||streamStatus(assistant)!=="complete"&&streamStatus(assistant)!=="interrupted"||!assistant.id)return {status:"rejected",reason:"no-regeneration"};
    const index=messages.findIndex(message=>message.id===assistant.id);
    const user=index>0?[...messages.slice(0,index)].reverse().find(message=>message.role==="user"):undefined;
    if(!user||!user.id)return {status:"rejected",reason:"no-regeneration"};
    return this.beginRun("regenerate",model,user,assistant);
  }

  async retry(model:string):Promise<ChatActionResult>{
    if(this.sending)return {status:"rejected",reason:"busy"};
    if(this.status!=="error")return {status:"rejected",reason:"no-retry"};
    const messages=this.session.getMessages();
    const assistant=[...messages].reverse().find(message=>message.role==="assistant");
    const user=[...messages].reverse().find(message=>message.role==="user");
    if(!user||!user.id)return {status:"rejected",reason:"no-retry"};
    return this.beginRun("retry",model,user,assistant&&assistant.id?assistant:undefined);
  }

  private beginRun(mode:RunMode,model:string,userMessage:ChatMessage,assistantMessage?:ChatMessage):Promise<ChatActionResult>{
    const id=++this.runSequence;
    const abortController=new AbortController();
    const active:ActiveRun={
      id,
      mode,
      assistantId:assistantMessage?.id??this.requestIdFactory()+":assistant",
      abortController,
      stopRequested:false,
      promise:Promise.resolve({status:"error",code:"PROVIDER_ERROR",message:"Chat run did not start."})
    };
    active.originalAssistant=assistantMessage?cloneMessage(assistantMessage):undefined;
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

  private async run(active:ActiveRun,model:string,userMessage:ChatMessage,assistantMessage?:ChatMessage):Promise<ChatActionResult>{
    const requestId=this.requestIdFactory();
    let targetAssistant=assistantMessage?cloneMessage(assistantMessage):undefined;
    let streamedUsage:Record<string,unknown>|undefined;
    let finishReason:ChatResponse["finishReason"]="unknown";
    let completed=false;
    let receivedText=false;

    try{
      if(active.stopRequested)return this.markInterrupted(active,targetAssistant);

      let contextMessages=this.session.getMessages();
      if(active.mode!=="continue"&&targetAssistant?.id){
        contextMessages=contextMessages.filter(message=>message.id!==targetAssistant!.id);
      }
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
      if(active.stopRequested)return this.markInterrupted(active,targetAssistant);

      const profile=this.modelProfile;
      const profileProviderId=profile?.providerId;
      const profileProviderPresetId=profile?.providerPresetId??this.runtime.getActiveProviderPresetId?.();
      let resolvedModel=model;
      if(profile?.model===undefined&&profileProviderPresetId!==undefined&&this.runtime.getChatModelForPreset){
        try{resolvedModel=await this.runtime.getChatModelForPreset(profileProviderPresetId)}catch{resolvedModel=model}
      }else if(profile?.model===undefined&&profileProviderPresetId===undefined&&profileProviderId!==undefined&&this.runtime.getChatModel){
        try{resolvedModel=await this.runtime.getChatModel(profileProviderId)}catch{resolvedModel=model}
      }
      const resolvedGeneration=profile?.generation;
      const hasGeneration=Boolean(resolvedGeneration&&Object.keys(resolvedGeneration).length>0);
      const request:ChatRequest={
        apiVersion:CHAT_API_VERSION,
        schemaVersion:CHAT_SCHEMA_VERSION,
        requestId,
        ...(profile?.providerId!==undefined?{providerId:profile.providerId}:{}),
        model:profile?.model??resolvedModel,
        context:{conversationId:this.session.conversationId,messages:contextMessages},
        ...(hasGeneration&&resolvedGeneration?{generation:{...resolvedGeneration}}:{})
      };

      if(active.mode==="regenerate"&&targetAssistant?.id){
        this.session.replaceMessage(targetAssistant.id,withStreamMetadata({...targetAssistant,content:""},"streaming"));
      }else if(active.mode==="retry"&&targetAssistant?.id){
        this.session.replaceMessage(targetAssistant.id,withStreamMetadata({...targetAssistant,content:""},"streaming"));
      }else if(active.mode==="continue"&&targetAssistant?.id){
        this.session.replaceMessage(targetAssistant.id,withStreamMetadata(targetAssistant,"streaming"));
      }else{
        targetAssistant={id:active.assistantId,role:"assistant",content:""};
        this.session.addMessage(withStreamMetadata(targetAssistant,"streaming"));
      }
      active.assistantId=targetAssistant.id!;
      this.notify();

      const onEvent=async(event:ChatStreamEvent)=>{
        if(active.stopRequested||this.activeRun?.id!==active.id)return;
        if(event.type==="delta"){
          const current=this.session.getMessages().find(message=>message.id===active.assistantId);
          if(!current)return;
          const nextContent=active.mode==="continue"
            ?appendWithoutDuplicate(current.content,event.text)
            :current.content+event.text;
          receivedText=receivedText||event.text.length>0;
          this.session.replaceMessage(active.assistantId,withStreamMetadata({...current,content:nextContent},"streaming"));
          this.notify();
        }else if(event.type==="usage"){
          streamedUsage={...(event.usage as Record<string,unknown>)};
        }else if(event.type==="completed"){
          completed=true;
          finishReason=event.finishReason;
          if(event.usage)streamedUsage={...(event.usage as Record<string,unknown>)};
        }
      };

      let response:ChatResponse;
      if(this.runtime.stream){
        response=await this.runtime.stream(
          request,
          {onEvent},
          {signal:active.abortController.signal},
          profileProviderPresetId
        );
      }else{
        response=await this.runtime.chat(request,profileProviderPresetId);
        await onEvent({
          apiVersion:"1",
          schemaVersion:"1",
          requestId,
          conversationId:this.session.conversationId,
          providerId:response.providerId,
          model:response.model,
          type:"delta",
          text:response.message.content
        });
        await onEvent({
          apiVersion:"1",
          schemaVersion:"1",
          requestId,
          conversationId:this.session.conversationId,
          providerId:response.providerId,
          model:response.model,
          type:"completed",
          finishReason:response.finishReason,
          ...(response.usage?{usage:response.usage}: {})
        });
      }

      if(active.stopRequested)return this.markInterrupted(active,this.session.getMessages().find(message=>message.id===active.assistantId));
      const finalMessage=this.session.getMessages().find(message=>message.id===active.assistantId);
      if(!finalMessage)throw new Error("Assistant stream message was lost.");
      const content=finalMessage.content||response.message.content;
      finishReason=completed?finishReason:response.finishReason;
      const usage=streamedUsage??response.usage;
      const canonical=withStreamMetadata({...finalMessage,content},"complete",{
        finishReason,
        ...(usage?{usage}: {})
      });
      this.session.replaceMessage(active.assistantId,canonical);
      this.status="completed";
      this.error=undefined;
      this.errorCode=undefined;
      this.notify();
      return {status:"sent",response:{...response,message:canonical,finishReason,usage:response.usage??(usage as never)}};
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
      this.sending=false;
      if(this.activeRun?.id===active.id)this.activeRun=undefined;
      this.notify();
    }
  }

  private markInterrupted(active:ActiveRun,current?:ChatMessage):ChatActionResult{
    const message=current??(active.originalAssistant?cloneMessage(active.originalAssistant):undefined);
    if(message?.id){
      const interrupted=withStreamMetadata(message,"interrupted",{
        ...(message.content?{}:{interruptedWithoutText:true})
      });
      if(this.session.getMessages().some(item=>item.id===message.id))this.session.replaceMessage(message.id,interrupted);
      else if(message.content)this.session.addMessage(interrupted);
      if(!message.content&&active.mode==="submit")this.session.removeMessage(message.id);
    }
    const finalMessage=this.session.getMessages().find(item=>item.id===active.assistantId);
    this.status=finalMessage?"interrupted":"interrupted";
    this.error=undefined;
    this.errorCode=undefined;
    this.sending=false;
    if(this.activeRun?.id===active.id)this.activeRun=undefined;
    this.notify();
    return {status:"interrupted",message:finalMessage??{id:active.assistantId,role:"assistant",content:"",metadata:{streamStatus:"interrupted"}}};
  }

  private notify():void{
    const snapshot=this.getSnapshot();
    for(const listener of [...this.listeners]){
      try{listener(snapshot)}catch{ /* observer failures must not break chat */ }
    }
  }
}
