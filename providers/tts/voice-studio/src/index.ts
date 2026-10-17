import type {
  TtsAudioMetadata,TtsOperationOptions,TtsPreset,TtsProvider,TtsProviderCapabilities,
  TtsProviderHealth,TtsStreamEvent,TtsSynthesisRequest
} from "../../../../contracts/src/tts";

const MAX_JSON_MESSAGE_BYTES=64*1024;
const MAX_BINARY_CHUNK_BYTES=512*1024;
const MAX_PENDING_WEBSOCKET_BYTES=8*1024*1024;
const MAX_WAV_BYTES=64*1024*1024;
const MAX_AUDIO_SAMPLE_RATE=192_000;
const MIN_AUDIO_SAMPLE_RATE=8_000;
const WS_TIMEOUT_MS=120_000;
const OPEN_TIMEOUT_MS=5_000;
const MAX_TEXT_CHARS=4_000;

export type VoiceStudioFetch=(url:string,init:RequestInit)=>Promise<Response>;
export type VoiceStudioWebSocketFactory=(url:string)=>WebSocket;

export interface VoiceStudioTtsOptions {
  fetch?:VoiceStudioFetch;
  createWebSocket?:VoiceStudioWebSocketFactory;
  requestTimeoutMs?:number;
  openTimeoutMs?:number;
}

class VoiceStudioError extends Error {
  constructor(
    message:string,
    readonly code:string,
    readonly retryable:boolean,
    readonly allowHttpFallback:boolean=false
  ){super(message);this.name="VoiceStudioError";}
}

function abortError():Error {
  const error=new Error("TTS operation was cancelled.");
  error.name="AbortError";
  return error;
}
function isRecord(value:unknown):value is Record<string,unknown>{
  return !!value&&typeof value==="object"&&!Array.isArray(value);
}
function throwIfAborted(signal:AbortSignal):void{
  if(signal.aborted)throw abortError();
}
function safeServerMessage(value:unknown):string{
  if(typeof value!=="string")return "The local speech engine returned an error.";
  const safe=value.replace(/https?:\/\/\S+/gi,"[url]")
    .replace(/(?:bearer\s+)[a-z0-9._~+/-]+=*/gi,"[credential]")
    .replace(/\b(?:token|password|secret|api[_ -]?key)\s*[:=]\s*\S+/gi,"[redacted]")
    .replace(/[\r\n\t]+/g," ").trim().slice(0,240);
  return safe||"The local speech engine returned an error.";
}
function byteLength(value:unknown):number|undefined{
  if(typeof value==="string")return value.length*2;
  if(value instanceof ArrayBuffer)return value.byteLength;
  if(ArrayBuffer.isView(value))return value.byteLength;
  if(typeof Blob!=="undefined"&&value instanceof Blob)return value.size;
  return undefined;
}
async function asBytes(value:unknown):Promise<Uint8Array>{
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  if(typeof Blob!=="undefined"&&value instanceof Blob)return new Uint8Array(await value.arrayBuffer());
  throw new VoiceStudioError("VoiceStudio sent an unsupported binary audio message.","invalid_binary_message",false);
}
function readPcmMetadata(raw:Record<string,unknown>):TtsAudioMetadata{
  const sampleRate=raw.sample_rate;
  const channels=raw.channels;
  const format=raw.format;
  if(typeof sampleRate!=="number"||!Number.isInteger(sampleRate)||sampleRate<MIN_AUDIO_SAMPLE_RATE||sampleRate>MAX_AUDIO_SAMPLE_RATE)
    throw new VoiceStudioError("VoiceStudio returned an invalid audio sample rate.","invalid_audio_metadata",false);
  if(typeof channels!=="number"||!Number.isInteger(channels)||channels<1||channels>2)
    throw new VoiceStudioError("VoiceStudio returned an unsupported channel count.","invalid_audio_metadata",false);
  if(format!=="pcm16"&&format!=="pcm16le"&&format!=="pcm_s16le")
    throw new VoiceStudioError("VoiceStudio must return PCM16 little-endian audio.","unsupported_audio_format",false);
  return {format:"pcm16le",sampleRate,channels};
}
export function validateVoiceStudioBaseUrl(raw:string):string{
  if(typeof raw!=="string"||raw.length>1024||!raw.trim())throw new VoiceStudioError("Enter a local VoiceStudio URL.","invalid_base_url",false);
  let url:URL;
  try{url=new URL(raw);}catch{throw new VoiceStudioError("VoiceStudio URL is invalid.","invalid_base_url",false);}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]","::1"].includes(host)||
     url.port!=="3900"||url.username!==""||url.password!==""||
     (url.pathname!==""&&url.pathname!=="/")||url.search!==""||url.hash!=="")
    throw new VoiceStudioError("VoiceStudio must use HTTP loopback on port 3900 without credentials, path, query, or fragment.","unsafe_base_url",false);
  return url.origin;
}
function validatePreset(preset:TtsPreset,requireVoiceProfile=false):{baseUrl:string;engine?:string}{
  if(preset.providerId!=="voice-studio")throw new VoiceStudioError("The selected TTS preset is not a VoiceStudio preset.","wrong_provider",false);
  const baseUrl=validateVoiceStudioBaseUrl(preset.baseUrl);
  if(typeof preset.speed!=="number"||!Number.isFinite(preset.speed)||preset.speed<0.5||preset.speed>2)
    throw new VoiceStudioError("VoiceStudio speed must be between 0.5 and 2.","invalid_speed",false);
  if(typeof preset.voiceProfileId!=="string"||preset.voiceProfileId.length>256||(requireVoiceProfile&&!preset.voiceProfileId.trim()))
    throw new VoiceStudioError("VoiceStudio profile ID is invalid.","invalid_voice_profile",false);
  if(typeof preset.language!=="string"||!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(preset.language))
    throw new VoiceStudioError("VoiceStudio language tag is invalid.","invalid_language",false);
  if(preset.credentialReference!==null)
    throw new VoiceStudioError("VoiceStudio does not use stored credentials; remove the credential reference.","unsupported_credentials",false);
  const options=preset.providerOptions;
  if(!options||typeof options!=="object"||Array.isArray(options))throw new VoiceStudioError("VoiceStudio preset options must be an object.","invalid_provider_options",false);
  const unknown=Object.keys(options).filter(key=>key!=="engine");
  if(unknown.length)throw new VoiceStudioError("VoiceStudio preset contains unsupported provider-specific options.","invalid_provider_options",false);
  const engine=options.engine;
  if(engine!==undefined&&(typeof engine!=="string"||engine.length>80||!/^[a-z][a-z0-9._-]*$/.test(engine)))
    throw new VoiceStudioError("VoiceStudio engine ID must be a lowercase engine identifier up to 80 characters.","invalid_provider_options",false);
  return {baseUrl,...(typeof engine==="string"&&engine.trim()?{engine}: {})};
}
function wsUrl(baseUrl:string):string{
  const url=new URL(baseUrl);
  url.protocol="ws:";
  url.pathname="/ws/tts";
  url.search="";
  url.hash="";
  return url.toString();
}
function linkedTimeout(signal:AbortSignal,timeoutMs:number):{signal:AbortSignal;dispose:()=>void}{
  const controller=new AbortController();
  const onAbort=()=>controller.abort();
  if(signal.aborted)controller.abort();else signal.addEventListener("abort",onAbort,{once:true});
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  return {signal:controller.signal,dispose:()=>{clearTimeout(timer);signal.removeEventListener("abort",onAbort);}};
}
function wavPcm16(bytes:Uint8Array):{metadata:TtsAudioMetadata;data:Uint8Array}{
  if(bytes.length<44||bytes.length>MAX_WAV_BYTES)throw new VoiceStudioError("VoiceStudio returned an invalid or oversized WAV file.","invalid_wav",false);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const ascii=(offset:number,length:number)=>String.fromCharCode(...bytes.subarray(offset,offset+length));
  if(ascii(0,4)!=="RIFF"||ascii(8,4)!=="WAVE")throw new VoiceStudioError("VoiceStudio fallback response is not a RIFF/WAVE file.","invalid_wav",false);
  let offset=12,channels=0,sampleRate=0,bits=0,formatCode=0,dataOffset=-1,dataSize=0;
  while(offset+8<=bytes.length){
    const name=ascii(offset,4),size=view.getUint32(offset+4,true),start=offset+8,end=start+size;
    if(end>bytes.length)throw new VoiceStudioError("VoiceStudio WAV chunk exceeds the response size.","invalid_wav",false);
    if(name==="fmt "){
      if(size<16)throw new VoiceStudioError("VoiceStudio WAV format chunk is incomplete.","invalid_wav",false);
      formatCode=view.getUint16(start,true);channels=view.getUint16(start+2,true);
      sampleRate=view.getUint32(start+4,true);bits=view.getUint16(start+14,true);
    }else if(name==="data"&&dataOffset<0){dataOffset=start;dataSize=size;}
    offset=end+(size%2);
  }
  if(formatCode!==1||bits!==16)throw new VoiceStudioError("VoiceStudio HTTP fallback must return uncompressed PCM16 WAV audio.","unsupported_audio_format",false);
  const metadata=readPcmMetadata({sample_rate:sampleRate,channels,format:"pcm16"});
  if(dataOffset<0||dataSize===0||dataOffset+dataSize>bytes.length||dataSize%(channels*2)!==0)
    throw new VoiceStudioError("VoiceStudio WAV audio data is missing, malformed, or not frame-aligned.","invalid_wav",false);
  return {metadata,data:bytes.slice(dataOffset,dataOffset+dataSize)};
}
async function readBoundedResponse(response:Response):Promise<Uint8Array>{
  const length=response.headers.get("content-length");
  if(length&&/^\d+$/.test(length)&&Number(length)>MAX_WAV_BYTES)
    throw new VoiceStudioError("VoiceStudio WAV response exceeds the 64 MiB limit.","response_too_large",false);
  if(response.body?.getReader){
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];
    let total=0;
    try{
      for(;;){
        const next=await reader.read();
        if(next.done)break;
        total+=next.value.byteLength;
        if(total>MAX_WAV_BYTES){await reader.cancel();throw new VoiceStudioError("VoiceStudio WAV response exceeds the 64 MiB limit.","response_too_large",false);}
        chunks.push(next.value);
      }
    }finally{reader.releaseLock();}
    const merged=new Uint8Array(total);let offset=0;
    for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
    return merged;
  }
  const array=new Uint8Array(await response.arrayBuffer());
  if(array.byteLength>MAX_WAV_BYTES)throw new VoiceStudioError("VoiceStudio WAV response exceeds the 64 MiB limit.","response_too_large",false);
  return array;
}
function publicError(error:unknown):{code:string;message:string;retryable:boolean}{
  if(error instanceof VoiceStudioError)return {code:error.code,message:safeServerMessage(error.message),retryable:error.retryable};
  if(error instanceof Error&&error.name==="AbortError")return {code:"cancelled",message:"TTS operation was cancelled.",retryable:true};
  return {code:"transport_error",message:"VoiceStudio connection or synthesis failed.",retryable:true};
}

class BoundedAsyncQueue<T> implements AsyncIterableIterator<T>{
  private readonly values:T[]=[];
  private readonly readers:Array<{resolve:(value:IteratorResult<T>)=>void;reject:(error:unknown)=>void}>=[];
  private readonly writers:Array<()=>void>=[];
  private closed=false;
  private failure:unknown;
  constructor(private readonly capacity:number){}
  async push(value:T):Promise<void>{
    while(!this.closed&&this.values.length>=this.capacity)await new Promise<void>(resolve=>this.writers.push(resolve));
    if(this.closed)throw this.failure??new Error("TTS event queue is closed.");
    const reader=this.readers.shift();
    if(reader)reader.resolve({value,done:false});else this.values.push(value);
  }
  next():Promise<IteratorResult<T>>{
    const value=this.values.shift();
    if(value!==undefined){this.writers.shift()?.();return Promise.resolve({value,done:false});}
    if(this.closed)return this.failure?Promise.reject(this.failure):Promise.resolve({value:undefined,done:true});
    return new Promise((resolve,reject)=>this.readers.push({resolve,reject}));
  }
  close(error?:unknown):void{
    if(this.closed)return;
    this.closed=true;this.failure=error;
    for(const wake of this.writers.splice(0))wake();
    if(this.values.length===0){
      for(const reader of this.readers.splice(0)){
        if(error)reader.reject(error);else reader.resolve({value:undefined,done:true});
      }
    }
  }
  [Symbol.asyncIterator]():AsyncIterableIterator<T>{return this;}
  async return():Promise<IteratorResult<T>>{this.close();return {value:undefined,done:true};}
}

interface SocketRequest {
  sessionId:string;
  queue:BoundedAsyncQueue<TtsStreamEvent>;
  metadata?:TtsAudioMetadata;
  sequence:number;
  timer:ReturnType<typeof setTimeout>;
  processing:Promise<void>;
  pendingBytes:number;
  ended:boolean;
  audioSeen:boolean;
  socket:WebSocket;
  onMessage:(event:MessageEvent)=>void;
  onClose:()=>void;
  onError:()=>void;
}

export class VoiceStudioTtsProvider implements TtsProvider {
  readonly id="voice-studio";
  private socket:WebSocket|undefined;
  private socketBaseUrl:string|undefined;
  private activeRequest:SocketRequest|undefined;
  private requestPending=false;
  private readonly fetcher:VoiceStudioFetch;
  private readonly socketFactory:VoiceStudioWebSocketFactory;
  private readonly requestTimeoutMs:number;
  private readonly openTimeoutMs:number;
  private readonly websocketAvailable:boolean;

  constructor(options:VoiceStudioTtsOptions={}){
    this.fetcher=options.fetch??((url,init)=>fetch(url,init));
    this.socketFactory=options.createWebSocket??(url=>new WebSocket(url));
    this.websocketAvailable=options.createWebSocket!==undefined||typeof WebSocket!=="undefined";
    this.requestTimeoutMs=options.requestTimeoutMs??WS_TIMEOUT_MS;
    this.openTimeoutMs=options.openTimeoutMs??OPEN_TIMEOUT_MS;
  }

  capabilities():TtsProviderCapabilities{
    // Without a selected engine, report only capabilities safe for every engine.
    return {streaming:true,audioFormats:["pcm16le"],supportsVoiceProfiles:true,supportsLanguage:true,
      supportsSpeed:true,supportsInstruction:false,nonverbalTags:[],maxTextChars:MAX_TEXT_CHARS};
  }

  capabilitiesForPreset(preset:TtsPreset):TtsProviderCapabilities{
    const base=this.capabilities();
    if(preset.providerOptions?.engine!=="omnivoice")return base;
    return {...base,supportsInstruction:true,nonverbalTags:["laughter","sigh"]};
  }

  async testConnection(preset:TtsPreset,signal:AbortSignal):Promise<TtsProviderHealth>{
    try{
      const {baseUrl}=validatePreset(preset);
      throwIfAborted(signal);
      const timeout=linkedTimeout(signal,5_000);
      try{
        const response=await this.fetcher(baseUrl+"/openapi.json",{method:"GET",signal:timeout.signal,redirect:"error"});
        if(!response.ok)return {status:"unavailable",message:"VoiceStudio did not respond successfully to its local API check."};
        if(response.body)void response.body.cancel().catch(()=>undefined);
        return {status:"healthy",message:"VoiceStudio local API is reachable."};
      }finally{timeout.dispose();}
    }catch(error){
      if(signal.aborted)return {status:"unavailable",message:"Connection check was cancelled."};
      const value=publicError(error);
      return {status:"unavailable",message:value.message};
    }
  }

  async *synthesize(request:TtsSynthesisRequest,options:TtsOperationOptions):AsyncIterable<TtsStreamEvent>{
    let validated:{baseUrl:string;engine?:string};
    try{
      validated=validatePreset(request.preset,true);
      if(typeof request.text!=="string"||!request.text.trim()||request.text.length>MAX_TEXT_CHARS)
        throw new VoiceStudioError("TTS text must contain 1 to 4000 characters.","invalid_text",false);
      if(typeof request.sessionId!=="string"||!request.sessionId||request.sessionId.length>256)
        throw new VoiceStudioError("TTS session id is invalid.","invalid_session",false);
      throwIfAborted(options.signal);
    }catch(error){
      yield {type:"error",sessionId:request.sessionId,error:publicError(error)};
      return;
    }

    if(!this.websocketAvailable){
      yield* this.synthesizeHttp(request,options.signal,validated);
      return;
    }
    let audioAccepted=false;
    const prelude:TtsStreamEvent[]=[];
    try{
      for await(const event of this.synthesizeWebSocket(request,options.signal,validated.baseUrl,validated.engine)){
        if(event.type==="routing"){
          yield event;
          continue;
        }
        if(event.type==="audio"){
          audioAccepted=true;
          for(const pending of prelude)yield pending;
          prelude.length=0;
          yield event;
        }else if(event.type==="done"||event.type==="error"){
          // A clean socket completion without any PCM is safe to retry over HTTP.
          // Do not leak the websocket start event into the replacement request.
          if(event.type==="done"&&!audioAccepted){
            prelude.length=0;
            yield* this.synthesizeHttp(request,options.signal,validated);
            return;
          }
          for(const pending of prelude)yield pending;
          prelude.length=0;
          yield event;
          return;
        }else prelude.push(event);
      }
      if(!audioAccepted){
        yield* this.synthesizeHttp(request,options.signal,validated);
        return;
      }
      yield {type:"done",sessionId:request.sessionId};
    }catch(error){
      if(options.signal.aborted)throw abortError();
      const fallback=error instanceof VoiceStudioError&&error.allowHttpFallback;
      if(!audioAccepted&&fallback){
        yield* this.synthesizeHttp(request,options.signal,validated);
        return;
      }
      yield {type:"error",sessionId:request.sessionId,error:publicError(error)};
    }
  }

  private async *synthesizeWebSocket(
    request:TtsSynthesisRequest,signal:AbortSignal,baseUrl:string,engine?:string
  ):AsyncIterable<TtsStreamEvent>{
    throwIfAborted(signal);
    if(this.requestPending||this.activeRequest)throw new VoiceStudioError("VoiceStudio permits only one outstanding websocket request.","request_already_active",true);
    this.requestPending=true;
    let socket:WebSocket;
    try{socket=await this.ensureSocket(baseUrl,signal);}
    catch(error){this.requestPending=false;throw error;}
    const queue=new BoundedAsyncQueue<TtsStreamEvent>(24);
    const timeoutMs=this.requestTimeoutMs;
    let operation:SocketRequest;
    const fail=(error:Error)=>{
      if(operation.ended)return;
      operation.ended=true;clearTimeout(operation.timer);
      operation.queue.close(error);
    };
    const finish=async(event:TtsStreamEvent)=>{
      if(operation.ended)return;
      if(event.type==="audio")operation.audioSeen=true;
      await operation.queue.push(event);
      if(event.type==="done"||event.type==="error"){
        operation.ended=true;clearTimeout(operation.timer);operation.queue.close();
      }
    };
    const handleMessage=async(event:MessageEvent)=>{
      if(operation.ended||this.activeRequest!==operation)return;
      const data=event.data;
      if(typeof data==="string"){
        if(data.length*2>MAX_JSON_MESSAGE_BYTES)throw new VoiceStudioError("VoiceStudio sent an oversized JSON message.","message_too_large",false);
        let decoded:unknown;
        try{decoded=JSON.parse(data);}catch{throw new VoiceStudioError("VoiceStudio sent malformed JSON.","invalid_json_message",false);}
        if(!isRecord(decoded)||typeof decoded.type!=="string")throw new VoiceStudioError("VoiceStudio sent an invalid protocol message.","invalid_protocol_message",false);
        if(decoded.type==="routing"){
          if(typeof decoded.status!=="string"||!decoded.status||decoded.status.length>80)
            throw new VoiceStudioError("VoiceStudio returned invalid routing metadata.","invalid_routing_metadata",false);
          if(decoded.reason!==undefined&&(typeof decoded.reason!=="string"||decoded.reason.length>240))
            throw new VoiceStudioError("VoiceStudio returned an invalid routing reason.","invalid_routing_metadata",false);
          await finish({
            type:"routing",sessionId:request.sessionId,status:decoded.status,
            ...(typeof decoded.reason==="string"&&decoded.reason?{reason:safeServerMessage(decoded.reason)}:{})
          });
          return;
        }
        if(decoded.type==="start"){
          if(operation.metadata)throw new VoiceStudioError("VoiceStudio sent duplicate audio-start metadata.","invalid_audio_metadata",false);
          const metadata=readPcmMetadata(decoded);
          operation.metadata=metadata;
          await finish({type:"start",sessionId:request.sessionId,audio:metadata});
          return;
        }
        if(decoded.type==="done"){
          if(!operation.metadata)throw new VoiceStudioError("VoiceStudio completed without audio metadata.","missing_audio_metadata",false);
          await finish({type:"done",sessionId:request.sessionId});
          return;
        }
        if(decoded.type==="error"){
          await finish({type:"error",sessionId:request.sessionId,error:{
            code:"engine_error",message:safeServerMessage(decoded.detail??decoded.message),retryable:true
          }});
          return;
        }
        throw new VoiceStudioError("VoiceStudio sent an unsupported protocol message.","invalid_protocol_message",false);
      }
      const bytes=await asBytes(data);
      if(bytes.byteLength===0)return;
      if(bytes.byteLength>MAX_BINARY_CHUNK_BYTES||bytes.byteLength%((operation.metadata?.channels??1)*2)!==0)
        throw new VoiceStudioError("VoiceStudio sent an oversized or non-frame-aligned PCM16 chunk.","invalid_audio_chunk",false);
      if(!operation.metadata)throw new VoiceStudioError("VoiceStudio sent audio before its start metadata.","missing_audio_metadata",false);
      operation.audioSeen=true;
      await finish({type:"audio",sessionId:request.sessionId,sequence:operation.sequence++,data:bytes});
    };
    const cleanup=(closeSocket:boolean)=>{
      clearTimeout(operation.timer);
      signal.removeEventListener("abort",onAbort);
      socket.removeEventListener("message",operation.onMessage);
      socket.removeEventListener("close",operation.onClose);
      socket.removeEventListener("error",operation.onError);
      if(this.activeRequest===operation){this.activeRequest=undefined;this.requestPending=false;}
      if(closeSocket){
        try{socket.close();}catch{}
        if(this.socket===socket){this.socket=undefined;this.socketBaseUrl=undefined;}
      }
    };
    const onAbort=()=>{
      fail(abortError());
      cleanup(true);
    };
    const onClose=()=>{
      // Finish queued message decoding before deciding whether HTTP retry could duplicate audio.
      void operation.processing.then(()=>{
        if(!operation.ended)fail(new VoiceStudioError("VoiceStudio websocket disconnected before the request completed.","websocket_disconnected",true,!operation.audioSeen));
        if(this.activeRequest===operation)cleanup(false);
      });
    };
    const onSocketError=()=>{
      if(!operation.ended){
        fail(new VoiceStudioError("VoiceStudio websocket connection failed.","websocket_error",true,!operation.audioSeen));
        cleanup(true);
      }
    };
    operation={
      sessionId:request.sessionId,queue,sequence:0,timer:setTimeout(()=>{fail(new VoiceStudioError("VoiceStudio synthesis timed out.","request_timeout",true,!operation.audioSeen));cleanup(true);},timeoutMs),
      processing:Promise.resolve(),pendingBytes:0,ended:false,audioSeen:false,socket,onMessage:()=>undefined,onClose,onError:onSocketError
    };
    operation.onMessage=(event:MessageEvent)=>{
      if(operation.ended||this.activeRequest!==operation)return;
      const size=byteLength(event.data);
      if(size===undefined){fail(new VoiceStudioError("VoiceStudio sent an unsupported message type.","invalid_message",false));cleanup(true);return;}
      if(typeof event.data!=="string")operation.audioSeen=true;
      operation.pendingBytes+=size;
      if(operation.pendingBytes>MAX_PENDING_WEBSOCKET_BYTES){
        fail(new VoiceStudioError("VoiceStudio exceeded the bounded incoming-audio buffer.","message_buffer_limit",false));
        cleanup(true);return;
      }
      operation.processing=operation.processing.then(()=>handleMessage(event)).catch(error=>{
        if(!operation.ended)fail(error instanceof Error?error:new Error("VoiceStudio message processing failed."));
        cleanup(true);
      }).finally(()=>{operation.pendingBytes-=size;});
    };
    this.activeRequest=operation;
    socket.addEventListener("message",operation.onMessage);
    socket.addEventListener("close",operation.onClose);
    socket.addEventListener("error",operation.onError);
    signal.addEventListener("abort",onAbort,{once:true});
    try{
      const payload:Record<string,unknown>={text:request.text,language:request.preset.language,speed:request.preset.speed};
      payload.voice=request.preset.voiceProfileId.trim();
      if(engine)payload.engine=engine;
      if(request.instruction==="whisper"&&this.capabilitiesForPreset(request.preset).supportsInstruction)payload.instruct=request.instruction;
      try{socket.send(JSON.stringify(payload));}catch{
        cleanup(true);
        throw new VoiceStudioError("VoiceStudio websocket request could not be sent; using HTTP fallback.","websocket_send_failed",true,true);
      }
      for await(const event of queue){
        yield event;
        if(event.type==="done"||event.type==="error")return;
      }
      if(!operation.ended)throw new VoiceStudioError("VoiceStudio ended a request without a completion event.","incomplete_response",true,!operation.audioSeen);
    }finally{
      cleanup(false);
    }
  }

  private async ensureSocket(baseUrl:string,signal:AbortSignal):Promise<WebSocket>{
    throwIfAborted(signal);
    if(this.socket&&this.socketBaseUrl===baseUrl&&this.socket.readyState===1)return this.socket;
    if(this.socket){try{this.socket.close();}catch{}this.socket=undefined;this.socketBaseUrl=undefined;}
    let socket:WebSocket;
    try{socket=this.socketFactory(wsUrl(baseUrl));}
    catch{throw new VoiceStudioError("VoiceStudio websocket is unavailable; using HTTP fallback.","websocket_unavailable",true,true);}
    const timeoutMs=this.openTimeoutMs;
    return await new Promise<WebSocket>((resolve,reject)=>{
      let settled=false;
      const timer=setTimeout(()=>complete(false),timeoutMs);
      const cleanup=()=>{
        clearTimeout(timer);
        signal.removeEventListener("abort",onAbort);
        socket.removeEventListener("open",onOpen);
        socket.removeEventListener("error",onError);
        socket.removeEventListener("close",onClose);
      };
      const complete=(opened:boolean)=>{
        if(settled)return;
        settled=true;cleanup();
        if(opened){this.socket=socket;this.socketBaseUrl=baseUrl;resolve(socket);}
        else{try{socket.close();}catch{}reject(signal.aborted?abortError():new VoiceStudioError("VoiceStudio websocket could not be opened; using HTTP fallback.","websocket_unavailable",true,true));}
      };
      const onOpen=()=>complete(true),onError=()=>complete(false),onClose=()=>complete(false),onAbort=()=>complete(false);
      signal.addEventListener("abort",onAbort,{once:true});
      socket.addEventListener("open",onOpen);socket.addEventListener("error",onError);socket.addEventListener("close",onClose);
      if(socket.readyState===1)complete(true);
    });
  }

  private async *synthesizeHttp(
    request:TtsSynthesisRequest,parentSignal:AbortSignal,validated:{baseUrl:string;engine?:string}
  ):AsyncIterable<TtsStreamEvent>{
    const timeout=linkedTimeout(parentSignal,this.requestTimeoutMs);
    try{
      throwIfAborted(parentSignal);
      const form=new FormData();
      form.append("text",request.text);
      form.append("language",request.preset.language);
      form.append("speed",String(request.preset.speed));
      form.append("profile_id",request.preset.voiceProfileId.trim());
      if(validated.engine)form.append("engine",validated.engine);
      form.append("wav_bits","16");
      if(request.instruction==="whisper"&&this.capabilitiesForPreset(request.preset).supportsInstruction)form.append("instruct",request.instruction);
      const response=await this.fetcher(validated.baseUrl+"/generate",{method:"POST",body:form,signal:timeout.signal,redirect:"error"});
      if(!response.ok)throw new VoiceStudioError("VoiceStudio HTTP synthesis request failed with status "+response.status+".","http_error",true);
      const bytes=await readBoundedResponse(response);
      throwIfAborted(parentSignal);
      const wav=wavPcm16(bytes);
      yield {type:"start",sessionId:request.sessionId,audio:wav.metadata};
      let sequence=0;
      for(let offset=0;offset<wav.data.length;offset+=64*1024){
        throwIfAborted(parentSignal);
        yield {type:"audio",sessionId:request.sessionId,sequence:sequence++,data:wav.data.slice(offset,Math.min(offset+64*1024,wav.data.length))};
      }
      yield {type:"done",sessionId:request.sessionId};
    }catch(error){
      if(parentSignal.aborted)throw abortError();
      yield {type:"error",sessionId:request.sessionId,error:publicError(error)};
    }finally{timeout.dispose();}
  }
}
