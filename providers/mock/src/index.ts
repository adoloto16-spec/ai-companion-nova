import type {
  AudioChunk,ChatProvider,ChatRequest,EmbeddingProvider,HealthStatus,ModelInfo,
  ProviderCapabilities,STTProvider,STTRequest,TTSProvider,TTSRequest,Transcript,VisionProvider,VisionRequest,VisionResult
} from "../../../contracts/src/index";

export class FakeChatProvider implements ChatProvider{
  id="fake.chat";
  metadata(){return {id:this.id,kind:"chat" as const,displayName:"Fake Chat Provider",version:"1.0.0",description:"Deterministic offline provider used by Foundation tests."};}
  capabilities():ProviderCapabilities{return {streaming:false,toolCalling:false};}
  async listModels():Promise<ModelInfo[]>{return [{id:"fake-chat",displayName:"Fake Chat"}];}
  async chat(request:ChatRequest):Promise<import("../../../contracts/src/index").ChatResponse>{
    return {
      apiVersion:request.apiVersion,
      schemaVersion:request.schemaVersion,
      requestId:request.requestId,
      conversationId:request.context.conversationId,
      providerId:this.id,
      model:request.model,
      message:{id:request.requestId+":assistant",role:"assistant",content:"fake response"},
      finishReason:"stop",
      usage:{promptTokens:1,completionTokens:2,totalTokens:3},
      metadata:{deterministic:true}
    };
  }
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["chat"]};}
}
export class FakeStreamingChatProvider implements ChatProvider{
  readonly id="fake.streaming";
  private readonly chunks:readonly string[];
  private readonly usage:import("../../../contracts/src/index").ChatUsage|undefined;
  constructor(chunks:readonly string[]=["Hello ","from ","fake streaming."],usage:import("../../../contracts/src/index").ChatUsage={promptTokens:1,completionTokens:3,totalTokens:4}){
    this.chunks=[...chunks];
    this.usage=usage;
  }
  metadata(){return {id:this.id,kind:"chat" as const,displayName:"Fake Streaming Chat Provider",version:"1.0.0",description:"Deterministic offline streaming provider used by Foundation tests."};}
  capabilities():ProviderCapabilities{return {streaming:true,toolCalling:false};}
  async listModels():Promise<ModelInfo[]>{return [{id:"fake-streaming-chat",displayName:"Fake Streaming Chat"}];}
  async chat(request:ChatRequest):Promise<import("../../../contracts/src/index").ChatResponse>{
    return {
      apiVersion:request.apiVersion,
      schemaVersion:request.schemaVersion,
      requestId:request.requestId,
      conversationId:request.context.conversationId,
      providerId:this.id,
      model:request.model,
      message:{id:request.requestId+":assistant",role:"assistant",content:this.chunks.join("")},
      finishReason:"stop",
      ...(this.usage?{usage:this.usage}: {}),
      metadata:{deterministic:true}
    };
  }
  async stream(
    request:ChatRequest,
    handlers:import("../../../contracts/src/index").ChatStreamHandlers,
    options:import("../../../contracts/src/index").ChatStreamOptions={}
  ):Promise<import("../../../contracts/src/index").ChatResponse>{
    if(options.signal?.aborted)throw createFakeAbortError();
    let text="";
    for(const chunk of this.chunks){
      if(options.signal?.aborted)throw createFakeAbortError();
      await Promise.resolve();
      if(options.signal?.aborted)throw createFakeAbortError();
      text+=chunk;
      await handlers.onEvent({
        apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,
        providerId:this.id,model:request.model,type:"delta",text:chunk
      });
    }
    if(this.usage)await handlers.onEvent({
      apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,
      providerId:this.id,model:request.model,type:"usage",usage:this.usage
    });
    await handlers.onEvent({
      apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,
      providerId:this.id,model:request.model,type:"completed",finishReason:"stop",...(this.usage?{usage:this.usage}: {})
    });
    return {
      apiVersion:request.apiVersion,schemaVersion:request.schemaVersion,requestId:request.requestId,
      conversationId:request.context.conversationId,providerId:this.id,model:request.model,
      message:{id:request.requestId+":assistant",role:"assistant",content:text},finishReason:"stop",
      ...(this.usage?{usage:this.usage}: {}),metadata:{deterministic:true}
    };
  }
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["chat","streaming"]};}
}
function createFakeAbortError():Error{
  const error=new Error("The operation was aborted.");
  error.name="AbortError";
  return error;
}

export class FakeSTTProvider implements STTProvider{
  id="fake.stt";
  capabilities():ProviderCapabilities{return {audioInput:true};}
  async transcribe(_request:STTRequest):Promise<Transcript>{return {text:"fake transcript",confidence:1};}
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["stt"]};}
}
export class FakeTTSProvider implements TTSProvider{
  id="fake.tts";
  capabilities():ProviderCapabilities{return {streaming:true,audioOutput:true};}
  async listVoices(){return ["fake-default"];}
  async *synthesize(_request:TTSRequest):AsyncIterable<AudioChunk>{yield {data:new Uint8Array([0]),sequence:0,final:true};}
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["tts"]};}
}
export class FakeEmbeddingProvider implements EmbeddingProvider{
  id="fake.embeddings";
  capabilities():ProviderCapabilities{return {embeddings:true};}
  dimensions(){return 4;}
  async embed(texts:string[]){return texts.map(text=>[text.length,0,0,0]);}
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["embeddings"]};}
}
export class FakeVisionProvider implements VisionProvider{
  id="fake.vision";
  capabilities():ProviderCapabilities{return {vision:true};}
  async analyze(_request:VisionRequest):Promise<VisionResult>{return {text:"fake vision result"};}
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["vision"]};}
}
