import type {
  AudioChunk,ChatProvider,ChatRequest,EmbeddingProvider,HealthStatus,ModelInfo,
  ProviderCapabilities,STTProvider,STTRequest,TTSProvider,TTSRequest,Transcript,VisionProvider,VisionRequest,VisionResult
} from "../../../contracts/src/index";

export class FakeChatProvider implements ChatProvider{
  id="fake.chat";
  metadata(){return {id:this.id,kind:"chat" as const,displayName:"Fake Chat Provider",version:"1.0.0",description:"Deterministic offline provider used by Foundation tests."};}
  capabilities():ProviderCapabilities{return {streaming:false,toolCalling:true};}
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
