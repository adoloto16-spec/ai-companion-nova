import type {ChatErrorCode,ChatMessage,ChatRequest,ChatResponse,Unsubscribe} from "../../contracts/src/index";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION} from "../../contracts/src/index";

export interface ChatRuntimeBoundary{chat(request:ChatRequest):Promise<ChatResponse>}

export interface ConversationSnapshot{
  conversationId:string;
  messages:readonly ChatMessage[];
  sending:boolean;
  error?:string;
  errorCode?:ChatErrorCode;
}

export type ChatSubmitResult=
  | {status:"sent";response:ChatResponse}
  | {status:"rejected";reason:"empty"|"busy"}
  | {status:"error";code:ChatErrorCode;message:string};

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

export class ConversationSession{
  readonly conversationId:string;
  private readonly messages:ChatMessage[]=[];
  constructor(conversationId:string){
    if(!conversationId.trim())throw new Error("Conversation id must not be empty.");
    this.conversationId=conversationId;
  }
  addMessage(message:ChatMessage):void{this.messages.push(cloneMessage(message))}
  getMessages():readonly ChatMessage[]{return this.messages.map(cloneMessage)}
  clear():void{this.messages.length=0}
}

export interface ChatSessionControllerOptions{requestIdFactory?:()=>string}

export class ChatSessionController{
  private readonly listeners=new Set<(snapshot:ConversationSnapshot)=>void>();
  private readonly requestIdFactory:()=>string;
  private sending=false;
  private error?:string;
  private errorCode?:ChatErrorCode;

  constructor(
    private readonly session:ConversationSession,
    private readonly runtime:ChatRuntimeBoundary,
    options:ChatSessionControllerOptions={}
  ){
    this.requestIdFactory=options.requestIdFactory??defaultRequestId;
  }

  getSnapshot():ConversationSnapshot{
    return {
      conversationId:this.session.conversationId,
      messages:this.session.getMessages(),
      sending:this.sending,
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
    this.notify();
  }

  async submit(content:string,model:string):Promise<ChatSubmitResult>{
    const text=content.trim();
    if(!text)return {status:"rejected",reason:"empty"};
    if(this.sending)return {status:"rejected",reason:"busy"};

    const requestId=this.requestIdFactory();
    this.error=undefined;
    this.errorCode=undefined;
    this.sending=true;
    this.notify();

    this.session.addMessage({id:requestId+":user",role:"user",content:text});
    this.notify();

    const request:ChatRequest={
      apiVersion:CHAT_API_VERSION,
      schemaVersion:CHAT_SCHEMA_VERSION,
      requestId,
      model,
      context:{
        conversationId:this.session.conversationId,
        messages:this.session.getMessages()
      }
    };

    try{
      const response=await this.runtime.chat(request);
      this.session.addMessage(response.message);
      this.notify();
      return {status:"sent",response};
    }catch(error){
      const normalized=userMessageForError(error);
      this.error=normalized.message;
      this.errorCode=normalized.code;
      this.notify();
      return {status:"error",...normalized};
    }finally{
      this.sending=false;
      this.notify();
    }
  }

  private notify():void{
    const snapshot=this.getSnapshot();
    for(const listener of [...this.listeners]){
      try{listener(snapshot)}catch{ /* observer failures must not break chat */ }
    }
  }
}
