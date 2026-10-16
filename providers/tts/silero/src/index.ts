import type {
  TtsAudioMetadata,TtsOperationOptions,TtsPreset,TtsProvider,TtsProviderCapabilities,
  TtsProviderHealth,TtsStreamEvent,TtsSynthesisRequest
} from "../../../../contracts/src/tts";

const MAX_WAV_BYTES=64*1024*1024;
const MAX_OPENAPI_BYTES=4*1024*1024;
const MAX_AUDIO_CHUNK_BYTES=64*1024;
const MIN_AUDIO_SAMPLE_RATE=8_000;
const MAX_AUDIO_SAMPLE_RATE=192_000;
const MAX_TEXT_CHARS=4_000;
const DEFAULT_REQUEST_TIMEOUT_MS=120_000;
const DEFAULT_CONNECTION_TIMEOUT_MS=15_000;

export type SileroFetch=(url:string,init:RequestInit)=>Promise<Response>;
export interface SileroTtsOptions {
  fetch?:SileroFetch;
  requestTimeoutMs?:number;
  connectionTimeoutMs?:number;
}

class SileroError extends Error {
  constructor(message:string,readonly code:string,readonly retryable:boolean){
    super(message);
    this.name="SileroError";
  }
}

function throwIfAborted(signal:AbortSignal):void {
  if(signal.aborted){
    const error=new Error("Silero operation was cancelled.");
    error.name="AbortError";
    throw error;
  }
}

function linkedTimeout(signal:AbortSignal,timeoutMs:number):{signal:AbortSignal;dispose:()=>void} {
  const controller=new AbortController();
  const onAbort=()=>controller.abort();
  if(signal.aborted)controller.abort();
  else signal.addEventListener("abort",onAbort,{once:true});
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  return {signal:controller.signal,dispose:()=>{
    clearTimeout(timer);
    signal.removeEventListener("abort",onAbort);
  }};
}

function validateBaseUrl(raw:string):string {
  if(typeof raw!=="string"||raw.length>1024||!raw.trim())
    throw new SileroError("Enter a local Silero URL.","invalid_base_url",false);
  let url:URL;
  try{url=new URL(raw);}
  catch{throw new SileroError("Silero URL is invalid.","invalid_base_url",false);}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]","::1"].includes(host)||
    url.username!==""||url.password!==""||(url.pathname!==""&&url.pathname!=="/")||
    url.search!==""||url.hash!==""){
    throw new SileroError("Silero must use HTTP loopback without credentials, path, query, or fragment.","unsafe_base_url",false);
  }
  return url.origin;
}

function validatePreset(preset:TtsPreset,requireVoice=true):{baseUrl:string;model:string;voice:string} {
  if(preset.providerId!=="silero")
    throw new SileroError("The selected TTS preset is not a Silero preset.","wrong_provider",false);
  const baseUrl=validateBaseUrl(preset.baseUrl);
  if(typeof preset.speed!=="number"||!Number.isFinite(preset.speed)||preset.speed<0.5||preset.speed>2)
    throw new SileroError("Silero speed must be between 0.5 and 2.","invalid_speed",false);
  if(typeof preset.voiceProfileId!=="string"||preset.voiceProfileId.length>80||
    /[\u0000-\u001f\u007f]/u.test(preset.voiceProfileId)||(requireVoice&&!preset.voiceProfileId.trim())){
    throw new SileroError("Silero voice ID is invalid.","invalid_voice",false);
  }
  if(preset.credentialReference!==null)
    throw new SileroError("Silero uses a local API without credentials; remove the credential reference.","unsupported_credentials",false);
  const options=preset.providerOptions;
  if(!options||typeof options!=="object"||Array.isArray(options)||
    Object.keys(options).some(key=>key!=="model")){
    throw new SileroError("Silero preset supports only the model provider option.","invalid_provider_options",false);
  }
  const rawModel=options.model;
  if(typeof rawModel!=="string"||!rawModel.trim()||rawModel.length>120||
    /[\u0000-\u001f\u007f]/u.test(rawModel)){
    throw new SileroError("Silero model must be a non-empty string of at most 120 characters.","invalid_model",false);
  }
  if(typeof preset.speed!=="number"||!Number.isFinite(preset.speed))
    throw new SileroError("Silero speed is invalid.","invalid_speed",false);
  return {baseUrl,model:rawModel.trim(),voice:preset.voiceProfileId.trim()};
}

function publicError(error:unknown):{code:string;message:string;retryable:boolean} {
  if(error instanceof SileroError)
    return {code:error.code,message:error.message,retryable:error.retryable};
  if(error instanceof Error&&error.name==="AbortError")
    return {code:"cancelled",message:"Silero operation was cancelled.",retryable:true};
  if(error instanceof Error&&error.name==="SileroTransportError"&&"code" in error&&typeof (error as {code?:unknown}).code==="string")
    return {code:(error as {code:string}).code,message:error.message.slice(0,240),retryable:true};
  return {code:"transport_error",message:"Silero connection or synthesis failed.",retryable:true};
}

function invalidWav(message="Silero returned an invalid WAV file."):SileroError {
  return new SileroError(message,"invalid_wav",false);
}

function wavPcm16(bytes:Uint8Array):{metadata:TtsAudioMetadata;data:Uint8Array} {
  if(bytes.byteLength<44||bytes.byteLength>MAX_WAV_BYTES)throw invalidWav();
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const ascii=(offset:number,length:number)=>String.fromCharCode(...bytes.subarray(offset,offset+length));
  if(ascii(0,4)!=="RIFF"||ascii(8,4)!=="WAVE")throw invalidWav("Silero response is not a RIFF/WAVE file.");
  const riffEnd=view.getUint32(4,true)+8;
  if(riffEnd!==bytes.byteLength||riffEnd<12)throw invalidWav("Silero WAV RIFF size does not match the response.");
  let offset=12;
  let formatCode:number|undefined,channels:number|undefined,sampleRate:number|undefined;
  let bits:number|undefined,blockAlign:number|undefined,byteRate:number|undefined;
  let dataOffset=-1,dataSize=0;
  while(offset<riffEnd){
    if(offset+8>riffEnd)throw invalidWav("Silero WAV contains an incomplete chunk header.");
    const name=ascii(offset,4);
    const size=view.getUint32(offset+4,true);
    const start=offset+8,end=start+size;
    if(end>riffEnd)throw invalidWav("Silero WAV chunk exceeds the declared RIFF boundary.");
    if(name==="fmt "){
      if(formatCode!==undefined||size<16)throw invalidWav("Silero WAV format chunk is missing, duplicated, or incomplete.");
      formatCode=view.getUint16(start,true);
      channels=view.getUint16(start+2,true);
      sampleRate=view.getUint32(start+4,true);
      byteRate=view.getUint32(start+8,true);
      blockAlign=view.getUint16(start+12,true);
      bits=view.getUint16(start+14,true);
    }else if(name==="data"){
      if(dataOffset>=0)throw invalidWav("Silero WAV contains more than one data chunk.");
      dataOffset=start;
      dataSize=size;
    }
    const next=end+(size%2);
    if(next>riffEnd)throw invalidWav("Silero WAV chunk padding exceeds the RIFF boundary.");
    offset=next;
  }
  if(offset!==riffEnd)throw invalidWav("Silero WAV contains malformed trailing chunk data.");
  if(formatCode!==1||bits!==16)
    throw new SileroError("Silero WAV must contain uncompressed PCM16 audio.","unsupported_audio_format",false);
  if(typeof channels!=="number"||!Number.isInteger(channels)||channels<1||channels>2)
    throw new SileroError("Silero WAV channel count must be one or two.","unsupported_audio_channels",false);
  if(typeof sampleRate!=="number"||!Number.isInteger(sampleRate)||
    sampleRate<MIN_AUDIO_SAMPLE_RATE||sampleRate>MAX_AUDIO_SAMPLE_RATE)
    throw invalidWav("Silero WAV sample rate is outside the supported range.");
  const expectedBlockAlign=channels*2;
  if(blockAlign!==expectedBlockAlign||byteRate!==sampleRate*expectedBlockAlign)
    throw invalidWav("Silero WAV PCM frame metadata is inconsistent.");
  if(dataOffset<0||dataSize===0||dataOffset+dataSize>riffEnd||dataSize%expectedBlockAlign!==0)
    throw invalidWav("Silero WAV audio data is empty, malformed, or not frame-aligned.");
  return {
    metadata:{format:"pcm16le",sampleRate,channels},
    data:bytes.slice(dataOffset,dataOffset+dataSize)
  };
}

async function readBoundedResponse(response:Response,maxBytes=MAX_WAV_BYTES):Promise<Uint8Array> {
  const tooLarge=()=>new SileroError(maxBytes===MAX_OPENAPI_BYTES
    ?"Silero OpenAPI response exceeds the 4 MiB limit."
    :"Silero WAV response exceeds the 64 MiB limit.","response_too_large",false);
  const length=response.headers.get("content-length");
  if(length&&/^\d+$/u.test(length)&&Number(length)>maxBytes){
    if(response.body)await response.body.cancel().catch(()=>undefined);
    throw tooLarge();
  }
  if(response.body?.getReader){
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];
    let total=0;
    try{
      for(;;){
        const next=await reader.read();if(next.done)break;
        total+=next.value.byteLength;
        if(total>maxBytes){await reader.cancel().catch(()=>undefined);throw tooLarge();}
        chunks.push(next.value);
      }
    }finally{reader.releaseLock();}
    const merged=new Uint8Array(total);let offset=0;
    for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
    return merged;
  }
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.byteLength>maxBytes)throw tooLarge();
  return bytes;
}

function isRecord(value:unknown):value is Record<string,unknown> {
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
function isCompatibleSileroOpenApi(document:unknown):boolean {
  if(!isRecord(document)||!isRecord(document.paths))return false;
  const item=document.paths["/v1/audio/speech"];
  if(!isRecord(item)||!isRecord(item.post))return false;
  const operation=item.post;
  if(!isRecord(operation.requestBody)||!isRecord(operation.requestBody.content))return false;
  const json=operation.requestBody.content["application/json"];
  if(!isRecord(json)||!isRecord(json.schema))return false;
  let schema=json.schema;const reference=schema["$ref"];
  if(typeof reference==="string"){
    const match=/^#\/components\/schemas\/([A-Za-z0-9_.-]+)$/u.exec(reference);
    if(!match||!isRecord(document.components)||!isRecord(document.components.schemas))return false;
    const resolved=document.components.schemas[match[1]!];if(!isRecord(resolved))return false;schema=resolved;
  }
  const properties=schema.properties;
  const required=schema.required;
  if(!isRecord(properties)||!Array.isArray(required))return false;
  return ["model","input","voice","response_format","speed"].every(key=>isRecord(properties[key]))&&
    ["model","input","voice"].every(key=>required.includes(key));
}
function connectionHttpMessage(status:number):string {
  if(status===401||status===403)return "Silero API requires authorization. Check the local server's REQUIRE_AUTH setting.";
  if(status===404)return "Silero OpenAI-compatible speech API was not found at the configured local URL.";
  return "Silero API check returned HTTP "+status+".";
}

export class SileroTtsProvider implements TtsProvider {
  readonly id="silero";
  private readonly fetcher:SileroFetch;
  private readonly requestTimeoutMs:number;
  private readonly connectionTimeoutMs:number;

  constructor(options:SileroTtsOptions={}) {
    this.fetcher=options.fetch??((url,init)=>fetch(url,init));
    this.requestTimeoutMs=options.requestTimeoutMs??DEFAULT_REQUEST_TIMEOUT_MS;
    this.connectionTimeoutMs=options.connectionTimeoutMs??DEFAULT_CONNECTION_TIMEOUT_MS;
  }

  capabilities():TtsProviderCapabilities {
    return {
      streaming:false,audioFormats:["pcm16le"],supportsVoiceProfiles:true,supportsLanguage:false,
      supportsSpeed:true,supportsInstruction:false,nonverbalTags:[],maxTextChars:MAX_TEXT_CHARS
    };
  }

  async testConnection(preset:TtsPreset,signal:AbortSignal):Promise<TtsProviderHealth> {
    let timeout:{signal:AbortSignal;dispose:()=>void}|undefined;
    try{
      const {baseUrl,model,voice}=validatePreset(preset);
      throwIfAborted(signal);
      timeout=linkedTimeout(signal,this.connectionTimeoutMs);
      const response=await this.fetcher(baseUrl+"/openapi.json",{method:"GET",signal:timeout.signal,redirect:"error"});
      throwIfAborted(timeout.signal);
      if(!response.ok){
        if(response.body)void response.body.cancel().catch(()=>undefined);
        return {status:"unavailable",message:connectionHttpMessage(response.status)};
      }
      const bytes=await readBoundedResponse(response,MAX_OPENAPI_BYTES);
      throwIfAborted(timeout.signal);
      let document:unknown;
      try{document=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
      catch{return {status:"unavailable",message:"Silero returned an invalid OpenAPI document."};}
      if(!isCompatibleSileroOpenApi(document))
        return {status:"unavailable",message:"The local service does not expose a compatible Silero speech API."};
      // OpenAPI may be public while POST /v1/audio/speech is protected by REQUIRE_AUTH.
      // Probe whitespace, not a spoken phrase, and request speed 1 to avoid FFmpeg.
      const probe=await this.fetcher(baseUrl+"/v1/audio/speech",{
        method:"POST",headers:{"content-type":"application/json","accept":"audio/wav"},
        body:JSON.stringify({model,input:" ",voice,response_format:"wav",speed:1.0}),
        signal:timeout.signal,redirect:"error"
      });
      throwIfAborted(timeout.signal);
      if(!probe.ok){
        if(probe.body)void probe.body.cancel().catch(()=>undefined);
        return {status:"unavailable",message:connectionHttpMessage(probe.status)};
      }
      const contentType=(probe.headers.get("content-type")??"").split(";",1)[0]!.trim().toLowerCase();
      if(contentType!=="audio/wav"&&contentType!=="audio/x-wav"){
        if(probe.body)void probe.body.cancel().catch(()=>undefined);
        return {status:"unavailable",message:"Silero speech endpoint did not return WAV audio."};
      }
      const probeBytes=await readBoundedResponse(probe);
      throwIfAborted(timeout.signal);
      try{wavPcm16(probeBytes);}
      catch{return {status:"unavailable",message:"Silero speech endpoint did not return a supported PCM16 WAV response."};}
      return {status:"healthy",message:"Compatible Silero API and speech endpoint are available."};
    }catch(error){
      if(signal.aborted)return {status:"unavailable",message:"Silero connection check was cancelled."};
      if(timeout?.signal.aborted)return {status:"unavailable",message:"Silero connection check timed out."};
      return {status:"unavailable",message:publicError(error).message};
    }finally{timeout?.dispose();}
  }

  async *synthesize(request:TtsSynthesisRequest,options:TtsOperationOptions):AsyncIterable<TtsStreamEvent> {
    let timeout:{signal:AbortSignal;dispose:()=>void}|undefined;
    try{
      throwIfAborted(options.signal);
      const {baseUrl,model,voice}=validatePreset(request.preset);
      if(typeof request.text!=="string"||!request.text.trim()||request.text.length>MAX_TEXT_CHARS)
        throw new SileroError("TTS text must contain 1 to 4000 characters.","invalid_text",false);
      if(typeof request.sessionId!=="string"||!request.sessionId||request.sessionId.length>256)
        throw new SileroError("TTS session ID is invalid.","invalid_session",false);
      timeout=linkedTimeout(options.signal,this.requestTimeoutMs);
      const response=await this.fetcher(baseUrl+"/v1/audio/speech",{
        method:"POST",
        headers:{"content-type":"application/json","accept":"audio/wav"},
        body:JSON.stringify({
          model,input:request.text,voice,response_format:"wav",speed:request.preset.speed
        }),
        signal:timeout.signal,
        redirect:"error"
      });
      throwIfAborted(timeout.signal);
      if(!response.ok){
        if(response.body)void response.body.cancel().catch(()=>undefined);
        const message=response.status===401||response.status===403
          ?"Silero API requires authorization. Check the local server's REQUIRE_AUTH setting."
          :response.status===404
            ?"Silero speech endpoint was not found; check the local API URL."
            :"Silero API returned HTTP "+response.status+".";
        throw new SileroError(message,"http_error",response.status===429||response.status>=500);
      }
      const wavBytes=await readBoundedResponse(response);
      throwIfAborted(timeout.signal);
      const wav=wavPcm16(wavBytes);
      throwIfAborted(timeout.signal);
      throwIfAborted(options.signal);
      yield {type:"start",sessionId:request.sessionId,audio:wav.metadata};
      const frameBytes=wav.metadata.channels*2;
      const chunkBytes=Math.floor(MAX_AUDIO_CHUNK_BYTES/frameBytes)*frameBytes;
      let sequence=0;
      for(let offset=0;offset<wav.data.byteLength;offset+=chunkBytes){
        throwIfAborted(timeout.signal);
        throwIfAborted(options.signal);
        yield {
          type:"audio",sessionId:request.sessionId,sequence:sequence++,
          data:wav.data.slice(offset,Math.min(offset+chunkBytes,wav.data.byteLength))
        };
      }
      yield {type:"done",sessionId:request.sessionId};
    }catch(error){
      const mapped=options.signal.aborted
        ?{code:"cancelled",message:"Silero operation was cancelled.",retryable:true}
        :timeout?.signal.aborted
          ?{code:"timeout",message:"Silero synthesis timed out.",retryable:true}
          :publicError(error);
      yield {type:"error",sessionId:request.sessionId,error:mapped};
    }finally{timeout?.dispose();}
  }
}
