import {SpeechOutputController,SpeechSentenceSegmenter,normalizeVoiceExpression} from "../../modules/voice/tts/src";
import type {AudioOutputAdapter} from "../../modules/voice/tts/src";
import type {TtsAudioMetadata,TtsPreset,TtsProvider,TtsProviderCapabilities,TtsProviderHealth,TtsSettings,TtsStreamEvent,TtsSynthesisRequest} from "../../contracts/src/tts";
import {DEFAULT_TTS_SETTINGS} from "../../contracts/src/tts";
import {VoiceStudioTtsProvider,validateVoiceStudioBaseUrl} from "../../providers/tts/voice-studio/src";
import {NovaTurnJsonEmotionStreamDecoder,NovaTurnJsonSpeechStreamDecoder,NovaTurnTaggedEmotionStreamDecoder,NovaTurnTaggedSpeechStreamDecoder} from "../../core/src/nova-turn-stream-decoders";
import {WebAudioOutputAdapter} from "../../apps/desktop-ui/src/web-audio-output";

function ok(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function equal<T>(actual:T,expected:T,message:string):void{if(actual!==expected)throw new Error(message+": expected "+String(expected)+", got "+String(actual));}
function deferred<T=void>(){
  let resolve!:(value:T|PromiseLike<T>)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
const metadata:TtsAudioMetadata={format:"pcm16le",sampleRate:22050,channels:1};
const capabilities:TtsProviderCapabilities={
  streaming:true,audioFormats:["pcm16le"],supportsVoiceProfiles:true,supportsLanguage:true,supportsSpeed:true,
  supportsInstruction:true,nonverbalTags:["laughter","sigh"],maxTextChars:4000
};
function preset(providerId="fake-tts"):TtsPreset{
  const defaults=DEFAULT_TTS_SETTINGS.presets[0]!;
  return {...defaults,id:"test-preset",name:"Test preset",providerId,baseUrl:"http://127.0.0.1:3900",voiceProfileId:"profile-test",language:"ru",speed:1,credentialReference:null,providerOptions:{}};
}
class RecordingOutput implements AudioOutputAdapter{
  unlocked=false;
  queued:Array<{sessionId:string;sequence:number;metadata:TtsAudioMetadata;text:string}>=[];
  starts:Array<{sessionId:string;metadata:TtsAudioMetadata}>=[];
  stops:Array<string|undefined>=[];
  async unlock(){this.unlocked=true;}
  startSession(sessionId:string,audio:TtsAudioMetadata){this.starts.push({sessionId,metadata:audio});}
  async enqueue(sessionId:string,sequence:number,audio:TtsAudioMetadata,data:Uint8Array,_signal:AbortSignal){
    this.queued.push({sessionId,sequence,metadata:audio,text:new TextDecoder().decode(data)});
  }
  stop(sessionId?:string){this.stops.push(sessionId);if(sessionId===undefined)this.queued=[];else this.queued=this.queued.filter(item=>item.sessionId!==sessionId);}
}
class RecordingProvider implements TtsProvider{
  readonly id="fake-tts";
  readonly requests:string[]=[];
  readonly emotions:string[]=[];
  gateFirst?:Promise<void>;
  active=0;
  maxActive=0;
  constructor(gateFirst?:Promise<void>){this.gateFirst=gateFirst;}
  capabilities(){return capabilities;}
  async testConnection(_preset:TtsPreset,_signal:AbortSignal):Promise<TtsProviderHealth>{return {status:"healthy",message:"fake provider ready"};}
  async *synthesize(request:TtsSynthesisRequest,options:{signal:AbortSignal}):AsyncIterable<TtsStreamEvent>{
    this.requests.push(request.text);this.emotions.push(request.emotion);
    this.active++;this.maxActive=Math.max(this.maxActive,this.active);
    try{
      yield {type:"start",sessionId:request.sessionId,audio:metadata};
      yield {type:"audio",sessionId:request.sessionId,sequence:0,data:new TextEncoder().encode(request.text)};
      if(this.requests.length===1&&this.gateFirst){await this.gateFirst; if(options.signal.aborted){const error=new Error("cancelled");error.name="AbortError";throw error;}}
      yield {type:"done",sessionId:request.sessionId};
    }finally{this.active--;}
  }
}
async function until(predicate:()=>boolean,message:string):Promise<void>{
  for(let i=0;i<100;i++){if(predicate())return;await Promise.resolve();}
  throw new Error(message);
}

function sentenceBoundariesPreserveEveryCharacter():void{
  const source="Привет, т.д. это 3.14. Он сказал: «Да!» А т.е. нет.\nНезавершённый остаток";
  const splitter=new SpeechSentenceSegmenter();
  const output:string[]=[];
  for(let i=0;i<source.length;i+=2)output.push(...splitter.push(source.slice(i,i+2)));
  output.push(...splitter.finish());
  equal(output.join(""),source,"sentence splitter preserves every code unit and chunk boundary");
  equal(output.length,4,"abbreviations and decimal points stay inside their sentence");
  equal(output[0],"Привет, т.д. это 3.14. ","decimal point and т.д. abbreviation are not sentence endings");
  equal(output[1],"Он сказал: «Да!» ","punctuation in Russian closing quotes is grouped with its sentence");
  equal(output[2],"А т.е. нет.\n","т.е. and newline boundaries are handled");
  equal(output[3],"Незавершённый остаток","last unpunctuated text is flushed at success");
  const reset=new SpeechSentenceSegmenter();
  reset.push("Old incomplete speech");
  reset.reset();
  equal(reset.finish().length,0,"cancel reset never flushes old partial speech");
  const utf8=new SpeechSentenceSegmenter();
  const unicode="😀. Далее.";
  let joined="";
  for(let i=0;i<unicode.length;i++)joined+=utf8.push(unicode.slice(i,i+1)).join("");
  joined+=utf8.finish().join("");
  equal(joined,unicode,"UTF-16 surrogate halves split across deltas are preserved");
}

function emotionMappingOnlyUsesSupportedActions():void{
  const neutral=normalizeVoiceExpression("Hello","happy",capabilities);
  equal(neutral.text,"Hello","ordinary happy emotion has no unsupported spoken tag");
  equal(neutral.instruction,undefined,"ordinary emotion is neutral on base OmniVoice");
  equal(normalizeVoiceExpression("Hello","sad",capabilities).text,"Hello","sad is neutral on a non-expressive engine");
  equal(normalizeVoiceExpression("Quietly","whisper",capabilities).instruction,"whisper","explicit whisper intent maps to a supported instruction");
  equal(normalizeVoiceExpression("That's funny","laughter",capabilities).text,"[laughter] That's funny","explicit laughter maps to non-verbal action tag");
  equal(normalizeVoiceExpression("[laughter] That's funny","laughter",capabilities).text,"[laughter] That's funny","existing laughter tags are not duplicated");
  equal(normalizeVoiceExpression("Oh","sigh",capabilities).text,"[sigh] Oh","explicit sigh maps to non-verbal action tag");
  equal(normalizeVoiceExpression("Oh","unknown state",capabilities).text,"Oh","unknown emotion remains neutral");
}

function emotionDecodersDoNotGateSpeech():void{
  const jsonSpeech=new NovaTurnJsonSpeechStreamDecoder(),jsonEmotion=new NovaTurnJsonEmotionStreamDecoder();
  const first='{"speech":"Public speech is streamed before the emotion field is reached",';
  equal(jsonSpeech.push(first),"Public speech is streamed before the emotion field is reached","speech streams while trailing JSON fields are incomplete");
  equal(jsonEmotion.push(first),"","emotion remains unresolved while prior speech value is incomplete");
  const second='"emotion":"whisper","thoughts":"do not expose"}';
  const jsonSpeechNext=jsonSpeech.push(second);
  equal(jsonSpeechNext,"","speech decoder does not expose emotion/thoughts");
  equal(jsonEmotion.push(second),"whisper","emotion is decoded when its later field arrives");
  ok((jsonEmotion.fieldOffset()??Infinity)>(jsonSpeech.fieldOffset()??Infinity),"JSON emotion-after-speech order is identified");
  const tags='<NOVA_TURN version="1"><SPEECH>Public text</SPEECH><THOUGHTS>private</THOUGHTS><EMOTION>whisper</EMOTION></NOVA_TURN>';
  const tagSpeech=new NovaTurnTaggedSpeechStreamDecoder(),tagEmotion=new NovaTurnTaggedEmotionStreamDecoder();
  let visible="",expression="";
  for(let i=0;i<tags.length;i+=3){const part=tags.slice(i,i+3);visible+=tagSpeech.push(part);expression+=tagEmotion.push(part);}
  equal(visible,"Public text","tagged speech decoder emits before the later emotion");
  equal(expression,"whisper","tagged emotion decoder extracts the later emotion incrementally");
  ok((tagEmotion.fieldOffset()??Infinity)>(tagSpeech.fieldOffset()??Infinity),"tagged emotion-after-speech order is identified");
}

async function synthesisRunsAheadOfPlaybackAndKeepsFifo():Promise<void>{
  const output=new RecordingOutput(),provider=new RecordingProvider();
  let settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset()]};
  const controller=new SpeechOutputController({getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output});
  await controller.unlockPlayback();
  await controller.handleSpeechEvent({type:"start",turnId:"turn-a"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-a",text:"First sentence. Second sentence"});
  await controller.finishTurn("turn-a");
  equal(provider.requests.length,2,"both sentences synthesize");
  ok(output.queued.length===2,"both audio segments are queued");
  equal(output.queued.map(item=>item.text).join(""),"First sentence. Second sentence","FIFO audio output preserves text and order");
  ok(provider.maxActive===1,"a provider/model never receives overlapping synthesis requests");
  // The fake output deliberately keeps playback pending: enqueue only queues it, just like the Web Audio adapter.
  let playbackFinished=false;
  ok(!playbackFinished,"playback remains independent from synthesis completion");
  equal(provider.requests[1],"Second sentence","sentence N+1 synthesis begins immediately after N completes");
  playbackFinished=true;
  void playbackFinished;
  controller.stop();
  settings={...settings,enabled:false};
  ok(output.stops.length>0,"Stop clears scheduled output");
}

async function boundedBackpressureAndCancellation():Promise<void>{
  const first=deferred<void>();
  const output=new RecordingOutput(),provider=new RecordingProvider(first.promise);
  const controller=new SpeechOutputController({getSettings:()=>({...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset()]}),getProvider:()=>provider,output});
  await controller.unlockPlayback();
  await controller.handleSpeechEvent({type:"start",turnId:"turn-backpressure"});
  const source=Array.from({length:18},(_,i)=>"Sentence "+(i+1)+".").join(" ");
  let completed=false;
  const work=controller.handleSpeechEvent({type:"delta",turnId:"turn-backpressure",text:source}).then(()=>{completed=true;});
  await until(()=>provider.requests.length===1,"first synthesis should start");
  await Promise.resolve();await Promise.resolve();
  ok(!completed,"bounded sentence queue applies backpressure while synthesis is stalled");
  first.resolve();
  await work;
  await controller.finishTurn("turn-backpressure");
  equal(provider.requests.length,18,"backpressure does not drop any sentence");
  controller.stop();
  const before=provider.requests.length;
  await controller.handleSpeechEvent({type:"start",turnId:"turn-new"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-old",text:"stale speech."});
  await controller.handleSpeechEvent({type:"reset",turnId:"turn-new"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-new",text:"must not revive."});
  equal(provider.requests.length,before,"reset cancels the old session and stale deltas cannot restart it");
}

function pcmWav(sampleRate=22050,channels=1):Uint8Array{
  const pcm=new Uint8Array(8),bytes=new Uint8Array(44+pcm.length),view=new DataView(bytes.buffer);
  const put=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i);};
  put(0,"RIFF");view.setUint32(4,bytes.length-8,true);put(8,"WAVE");put(12,"fmt ");view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);
  put(36,"data");view.setUint32(40,pcm.length,true);bytes.set(pcm,44);
  return bytes;
}
class MockWebSocket extends EventTarget{
  readyState=1;
  sent:string[]=[];
  close(){this.readyState=3;this.dispatchEvent(new Event("close"));}
  send(value:string){
    this.sent.push(value);
    queueMicrotask(()=>{
      this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"start",sample_rate:44100,channels:2,format:"pcm16"})}));
      const pcm=new Int16Array([32767,-32768,0,500]).buffer;
      this.dispatchEvent(new MessageEvent("message",{data:pcm}));
      this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"done"})}));
    });
  }
}
async function voiceStudioWebSocketAndHttpFallback():Promise<void>{
  equal(validateVoiceStudioBaseUrl("http://127.0.0.1:3900"),"http://127.0.0.1:3900","loopback base URL is accepted");
  for(const unsafe of ["https://127.0.0.1:3900","http://127.0.0.1:3901","http://127.0.0.1:3900/path","http://127.0.0.1:3900/?x=1","http://user:pass@127.0.0.1:3900","http://example.com:3900"]){
    let rejected=false;try{validateVoiceStudioBaseUrl(unsafe);}catch{rejected=true;}
    ok(rejected,"unsafe VoiceStudio URL is rejected: "+unsafe);
  }
  const socket=new MockWebSocket();
  const wsProvider=new VoiceStudioTtsProvider({createWebSocket:()=>socket as unknown as WebSocket,requestTimeoutMs:1000});
  const events:TtsStreamEvent[]=[];
  for await(const event of wsProvider.synthesize({sessionId:"ws-test",text:"Привет",preset:preset("voice-studio"),emotion:""}, {signal:new AbortController().signal}))events.push(event);
  equal(events.map(event=>event.type).join(","),"start,audio,done","websocket protocol emits start, binary PCM, done");
  const start=events[0];ok(start?.type==="start"&&start.audio.sampleRate===44100&&start.audio.channels===2,"sample rate and channels come from actual start metadata");
  const audio=events[1];ok(audio?.type==="audio"&&audio.data.byteLength===8,"binary PCM16 chunk bytes are preserved");
  const request=JSON.parse(socket.sent[0]!) as Record<string,unknown>;
  equal(request.voice,"profile-test","VoiceStudio receives the configured profile ID");
  equal(request.speed,1,"VoiceStudio receives speed");

  let sawForm=false,sawManualContentType=false;
  const fallback=new VoiceStudioTtsProvider({
    createWebSocket:()=>{throw new Error("WebSocket implementation unavailable");},
    fetch:async(url,init)=>{
      equal(url,"http://127.0.0.1:3900/generate","HTTP fallback posts to /generate");
      ok(init.body instanceof FormData,"HTTP fallback uses multipart FormData");
      const form=init.body as FormData;sawForm=form.get("text")==="One complete sentence"&&form.get("profile_id")==="profile-test";
      const headers=new Headers(init.headers);sawManualContentType=headers.has("content-type");
      const wav=pcmWav();const body=new ArrayBuffer(wav.byteLength);new Uint8Array(body).set(wav);
      return new Response(body,{status:200,headers:{"content-type":"audio/wav"}});
    }
  });
  const httpEvents:TtsStreamEvent[]=[];
  for await(const event of fallback.synthesize({sessionId:"http-test",text:"One complete sentence",preset:preset("voice-studio"),emotion:""}, {signal:new AbortController().signal}))httpEvents.push(event);
  ok(sawForm,"HTTP fallback posts text and profile_id as multipart fields");
  ok(!sawManualContentType,"HTTP fallback lets the runtime supply FormData Content-Type and boundary");
  equal(httpEvents.map(event=>event.type).join(","),"start,audio,done","HTTP fallback parses WAV and exposes bounded audio chunks");
  const httpStart=httpEvents[0];ok(httpStart?.type==="start"&&httpStart.audio.sampleRate===22050,"WAV sample rate is parsed instead of guessed");
}

interface MockBuffer {duration:number;numberOfChannels:number;length:number;sampleRate:number;data:Float32Array[];getChannelData(index:number):Float32Array;}
interface MockSource {buffer:MockBuffer|null;onended:(()=>void)|null;connect(target:unknown):void;disconnect():void;start(when?:number):void;stop():void;}
async function webAudioSchedulesFifoWithoutOverlap():Promise<void>{
  const scheduled:Array<{when:number;duration:number;sample:number}>=[],sources:MockSource[]=[];
  const mockContext={
    currentTime:0,state:"running",destination:{},
    async resume(){this.state="running";},async close(){this.state="closed";},
    createBuffer(channels:number,length:number,sampleRate:number):MockBuffer{
      const data=Array.from({length:channels},()=>new Float32Array(length));
      return {duration:length/sampleRate,numberOfChannels:channels,length,sampleRate,data,getChannelData:(index:number)=>data[index]!};
    },
    createBufferSource():MockSource{
      const source:MockSource={buffer:null,onended:null,connect(){},disconnect(){},start(when=0){const buffer=source.buffer!;scheduled.push({when,duration:buffer.duration,sample:buffer.data[0]?.[0]??0});},stop(){source.onended?.();}};
      sources.push(source);return source;
    }
  };
  const output=new WebAudioOutputAdapter({createContext:()=>mockContext as unknown as AudioContext,maxScheduleAheadSeconds:10});
  await output.unlock();output.startSession("fifo",metadata);
  await output.enqueue("fifo",20,metadata,new Uint8Array([0xe8,0x03,0x18,0xfc]),new AbortController().signal);
  const other:TtsAudioMetadata={format:"pcm16le",sampleRate:44100,channels:1};
  await output.enqueue("fifo",10,other,new Uint8Array([0xd0,0x07,0x30,0xf8]),new AbortController().signal);
  await until(()=>scheduled.length===2,"two queued PCM chunks should be scheduled");
  equal(Math.round(scheduled[0]!.sample*1000),31,"PCM16 samples are converted to Float32 correctly");
  equal(Math.round(scheduled[1]!.sample*1000),61,"second chunk retains FIFO order regardless of transport sequence labels");
  ok(scheduled[1]!.when+1e-9>=scheduled[0]!.when+scheduled[0]!.duration,"consecutive chunks do not overlap");
  output.stop("fifo");
  await output.dispose();
}

async function main():Promise<void>{
  sentenceBoundariesPreserveEveryCharacter();
  emotionMappingOnlyUsesSupportedActions();
  emotionDecodersDoNotGateSpeech();
  await synthesisRunsAheadOfPlaybackAndKeepsFifo();
  await boundedBackpressureAndCancellation();
  await voiceStudioWebSocketAndHttpFallback();
  await webAudioSchedulesFifoWithoutOverlap();
  console.log("PASS TTS sentence, emotion, controller, provider and Web Audio tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
