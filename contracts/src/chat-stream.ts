import type {ApiVersion,ChatError,ChatFinishReason,ChatUsage} from "./index";

export const CHAT_STREAM_API_VERSION:ApiVersion="1";
export const CHAT_STREAM_SCHEMA_VERSION="1";

export interface ChatStreamEnvelope{
  apiVersion:ApiVersion;
  schemaVersion:string;
  requestId:string;
  conversationId:string;
  providerId:string;
  model:string;
}

export interface ChatStreamDelta extends ChatStreamEnvelope{
  type:"delta";
  text:string;
}

export interface ChatStreamUsage extends ChatStreamEnvelope{
  type:"usage";
  usage:ChatUsage;
}

export interface ChatStreamDone extends ChatStreamEnvelope{
  type:"completed";
  finishReason:ChatFinishReason;
  usage?:ChatUsage;
}

export interface ChatStreamError extends ChatStreamEnvelope{
  type:"error";
  error:ChatError;
}

export type ChatStreamEvent=ChatStreamDelta|ChatStreamUsage|ChatStreamDone|ChatStreamError;

export interface ChatStreamHandlers{
  onEvent(event:ChatStreamEvent):void|Promise<void>;
}

export interface ChatStreamOptions{
  signal?:AbortSignal;
}
