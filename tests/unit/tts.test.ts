import {SpeechOutputController,SpeechSentenceSegmenter,normalizeVoiceExpression} from "../../modules/voice/tts/src";
import {MindRuntime} from "../../core/src/mind-runtime";
import type {AudioOutputAdapter} from "../../modules/voice/tts/src";
import type {TtsAudioMetadata,TtsPreset,TtsProvider,TtsProviderCapabilities,TtsProviderHealth,TtsSettings,TtsStreamEvent,TtsSynthesisRequest} from "../../contracts/src/tts";
import {DEFAULT_TTS_SETTINGS} from "../../contracts/src/tts";
import {VoiceStudioTtsProvider,validateVoiceStudioBaseUrl} from "../../providers/tts/voice-studio/src";
import {SileroTtsProvider,type SileroFetch} from "../../providers/tts/silero/src";
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
/** Enqueue completion is distinct from actual playback completion. */
class PlaybackControlledOutput implements AudioOutputAdapter{
  unlocked=false;
  queued:Array<{sessionId:string;sequence:number;metadata:TtsAudioMetadata;text:string}>=[];
  gaps:number[]=[];
  pendingPlayback=new Map<number,string>();
  stops:Array<string|undefined>=[];
  private playbackWaiters=new Set<()=>void>();
  async unlock(){this.unlocked=true;}
  startSession(_sessionId:string,_metadata:TtsAudioMetadata){}
  async enqueue(sessionId:string,sequence:number,audio:TtsAudioMetadata,data:Uint8Array,signal:AbortSignal,
    segment?:{segmentSequence:number;gapBeforeMs:number;onPlaybackStarted?:()=>void}){
    if(signal.aborted){const error=new Error("cancelled");error.name="AbortError";throw error;}
    this.queued.push({sessionId,sequence,metadata:audio,text:new TextDecoder().decode(data)});
    this.gaps.push(segment?.gapBeforeMs??0);
    segment?.onPlaybackStarted?.();
    this.pendingPlayback.set(sequence,sessionId);
  }
  async waitForPlayback(sessionId:string,signal:AbortSignal):Promise<void>{
    while([...this.pendingPlayback.values()].some(id=>id===sessionId)){
      if(signal.aborted){const error=new Error("cancelled");error.name="AbortError";throw error;}
      await new Promise<void>((resolve,reject)=>{
        const wake=()=>{this.playbackWaiters.delete(wake);signal.removeEventListener("abort",onAbort);resolve();};
        const onAbort=()=>{this.playbackWaiters.delete(wake);reject(Object.assign(new Error("cancelled"),{name:"AbortError"}));};
        this.playbackWaiters.add(wake);
        signal.addEventListener("abort",onAbort,{once:true});
      });
    }
    if(signal.aborted){const error=new Error("cancelled");error.name="AbortError";throw error;}
  }
  finishPlayback(sequence:number){this.pendingPlayback.delete(sequence);for(const wake of [...this.playbackWaiters])wake();}
  stop(sessionId?:string){
    this.stops.push(sessionId);
    if(sessionId===undefined){this.queued=[];this.pendingPlayback.clear();}
    else{
      this.queued=this.queued.filter(item=>item.sessionId!==sessionId);
      for(const [sequence,id] of this.pendingPlayback)if(id===sessionId)this.pendingPlayback.delete(sequence);
    }
    for(const wake of [...this.playbackWaiters])wake();
  }
}
class RecordingProvider implements TtsProvider{
  readonly id="fake-tts";
  readonly requests:string[]=[];
  readonly emotions:string[]=[];
  gateFirst?:Promise<void>;
  failAt?:number;
  active=0;
  maxActive=0;
  constructor(gateFirst?:Promise<void>,failAt?:number){this.gateFirst=gateFirst;this.failAt=failAt;}
  capabilities(){return capabilities;}
  async testConnection(_preset:TtsPreset,_signal:AbortSignal):Promise<TtsProviderHealth>{return {status:"healthy",message:"fake provider ready"};}
  async *synthesize(request:TtsSynthesisRequest,options:{signal:AbortSignal}):AsyncIterable<TtsStreamEvent>{
    const index=this.requests.push(request.text)-1;this.emotions.push(request.emotion);
    this.active++;this.maxActive=Math.max(this.maxActive,this.active);
    try{
      yield {type:"start",sessionId:request.sessionId,audio:metadata};
      if(index===this.failAt)throw new Error("synthetic segment synthesis failure");
      yield {type:"audio",sessionId:request.sessionId,sequence:0,data:new TextEncoder().encode(request.text)};
      if(this.requests.length===1&&this.gateFirst){await this.gateFirst; if(options.signal.aborted){const error=new Error("cancelled");error.name="AbortError";throw error;}}
      yield {type:"done",sessionId:request.sessionId};
    }finally{this.active--;}
  }
}
class LateEventProvider implements TtsProvider{
  readonly id="late-tts";
  readonly requests:string[]=[];
  completed=0;
  private readonly firstGate=deferred<void>();
  releaseFirst(){this.firstGate.resolve();}
  capabilities(){return capabilities;}
  async testConnection(_preset:TtsPreset,_signal:AbortSignal):Promise<TtsProviderHealth>{return {status:"healthy"};}
  async *synthesize(request:TtsSynthesisRequest,_options:{signal:AbortSignal}):AsyncIterable<TtsStreamEvent>{
    const index=this.requests.push(request.text)-1;
    try{
      yield {type:"start",sessionId:request.sessionId,audio:metadata};
      if(index===0)await this.firstGate.promise;
      yield {type:"audio",sessionId:request.sessionId,sequence:0,data:new TextEncoder().encode(request.text)};
      yield {type:"done",sessionId:request.sessionId};
    }finally{this.completed++;}
  }
}
async function until(predicate:()=>boolean,message:string):Promise<void>{
  for(let i=0;i<100;i++){if(predicate())return;await Promise.resolve();}
  throw new Error(message);
}
async function untilWithTimeout(predicate:()=>boolean,message:string,timeoutMs=1500):Promise<void>{
  const deadline=Date.now()+timeoutMs;
  while(!predicate()){
    if(Date.now()>=deadline)throw new Error(message);
    await new Promise(resolve=>setTimeout(resolve,2));
  }
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
  equal(normalizeVoiceExpression("Oh","not laughter",capabilities).text,"Oh","negated or unrecognized laughter phrases remain neutral");
  equal(normalizeVoiceExpression("Quietly","sad but whispering",capabilities).instruction,undefined,"mixed unsupported labels cannot trigger a whisper instruction");
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
  const sourceText='Первая фраза. Кавычка: "да". Эмодзи 😀. Последний остаток';
  const jsonPayload=JSON.stringify({speech:sourceText,thoughts:"не озвучивать"});
  const streamDecoder=new NovaTurnJsonSpeechStreamDecoder(),sentenceDecoder=new SpeechSentenceSegmenter();
  const reconstructed:string[]=[];
  for(let i=0;i<jsonPayload.length;i++){
    const speechDelta=streamDecoder.push(jsonPayload.slice(i,i+1));
    reconstructed.push(...sentenceDecoder.push(speechDelta));
  }
  reconstructed.push(...sentenceDecoder.finish());
  equal(reconstructed.join(""),sourceText,"JSON escape, punctuation and UTF-16 split boundaries preserve public speech");
  const escapedPayload="{\"speech\":\"Escaped: \\uD83D\\uDE00\\nquote: \\\"ok\\\"\"}";
  const escapedDecoder=new NovaTurnJsonSpeechStreamDecoder();
  let escapedSpeech="";
  for(let i=0;i<escapedPayload.length;i++)escapedSpeech+=escapedDecoder.push(escapedPayload.slice(i,i+1));
  equal(escapedSpeech,"Escaped: 😀\nquote: \"ok\"","incremental JSON preserves escaped surrogate pairs, newlines and quotes");

  const tags='<NOVA_TURN version="1"><SPEECH>Public text</SPEECH><THOUGHTS>private</THOUGHTS><EMOTION>whisper</EMOTION></NOVA_TURN>';
  const tagSpeech=new NovaTurnTaggedSpeechStreamDecoder(),tagEmotion=new NovaTurnTaggedEmotionStreamDecoder();
  let visible="",expression="";
  for(let i=0;i<tags.length;i+=3){const part=tags.slice(i,i+3);visible+=tagSpeech.push(part);expression+=tagEmotion.push(part);}
  equal(visible,"Public text","tagged speech decoder emits before the later emotion");
  equal(expression,"whisper","tagged emotion decoder extracts the later emotion incrementally");
  ok((tagEmotion.fieldOffset()??Infinity)>(tagSpeech.fieldOffset()??Infinity),"tagged emotion-after-speech order is identified");
}

async function synthesisRunsAheadOfPlaybackAndKeepsFifo():Promise<void>{
  const output=new PlaybackControlledOutput(),provider=new RecordingProvider();
  const settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset()]};
  const controller=new SpeechOutputController({getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output});
  await controller.unlockPlayback();
  await controller.handleSpeechEvent({type:"start",turnId:"turn-a"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-a",text:"First sentence. Second sentence"});
  let finished=false;
  const finish=controller.finishTurn("turn-a").then(()=>{finished=true;});
  await until(()=>provider.requests.length===2&&output.pendingPlayback.size===2,"both sentence synthesis requests should complete");
  equal(provider.maxActive,1,"sentence synthesis requests remain serial");
  equal(provider.requests[1],"Second sentence","synthesis N+1 starts after synthesis N completes");
  equal(output.queued.map(item=>item.text).join(""),"First sentence. Second sentence","accepted playback segments preserve FIFO text order");
  ok(!finished,"turn finalization waits after synthesis while playback is still pending");
  output.finishPlayback(0);
  await Promise.resolve();
  ok(!finished&&output.pendingPlayback.has(1),"first playback completion must not finish the turn while the second segment remains");
  output.finishPlayback(1);
  await finish;
  ok(finished,"turn finalization resolves after the final audio segment physically ends");
  equal(output.gaps.join(","),"0,500","configured sentence gap is applied only at segment boundaries");
  controller.stop();
  ok(output.stops.some(id=>id===undefined),"explicit Stop cancels output even when synthesis has finalized");
}
async function segmentSynthesisFailureDoesNotStopAlreadyQueuedSpeech():Promise<void>{
  const output=new PlaybackControlledOutput(),provider=new RecordingProvider(undefined,1);
  const settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset()]};
  const controller=new SpeechOutputController({getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output});
  await controller.unlockPlayback();
  await controller.handleSpeechEvent({type:"start",turnId:"turn-failed-segment"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-failed-segment",text:"First sentence. Second sentence."});
  let cognitivelyReleased=false;
  const finished=controller.finishTurn("turn-failed-segment").then(()=>{cognitivelyReleased=true;});
  await until(()=>provider.requests.length===2&&output.pendingPlayback.size===1,"first segment must stay queued while second segment fails");
  await finished;
  ok(cognitivelyReleased&&output.pendingPlayback.size===1,"synthesis failure releases the turn while successful earlier audio continues playing");
  ok(!output.stops.includes("nova-tts-1-turn-failed-segment"),"later synthesis failure does not stop the current playback session");
  output.finishPlayback(0);
  await until(()=>controller.getStatus().message.includes("Speech playback drained"),"the preserved audio drains after the early cognitive release");
  equal(output.queued.length,1,"only the successful segment reaches playback");
  ok(!output.stops.includes("nova-tts-1-turn-failed-segment"),"successful drain does not cancel preserved audio after a later segment error");
  controller.stop();
}
async function assistantTurnsWaitForPlaybackAndInterruptionClearsQueue():Promise<void>{
  const output=new PlaybackControlledOutput(),provider=new RecordingProvider();
  const settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset()]};
  const controller=new SpeechOutputController({getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output});
  await controller.unlockPlayback();
  await controller.handleSpeechEvent({type:"start",turnId:"turn-one"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-one",text:"First message."});
  let firstFinished=false;
  const first=controller.finishTurn("turn-one").then(()=>{firstFinished=true;});
  await until(()=>output.pendingPlayback.size===1,"first message audio should be awaiting playback");
  await controller.handleSpeechEvent({type:"start",turnId:"turn-two"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-two",text:"Second message."});
  let secondFinished=false;
  const second=controller.finishTurn("turn-two").then(()=>{secondFinished=true;});
  await Promise.resolve();
  equal(provider.requests.length,1,"second message is not synthesized over active playback");
  ok(!firstFinished&&!secondFinished,"neither queued message finalizes while the first audio is playing");
  output.finishPlayback(0);
  await first;
  await until(()=>provider.requests.length===2&&output.pendingPlayback.size===1,"second message starts only after the first playback ends");
  ok(!secondFinished,"second message remains pending until its own playback ends");
  output.finishPlayback(0);
  await second;
  ok(secondFinished,"queued second message completes in FIFO order");
  controller.stop();

  await controller.handleSpeechEvent({type:"start",turnId:"turn-interrupt"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-interrupt",text:"This audio must stop."});
  const interrupted=controller.finishTurn("turn-interrupt");
  await until(()=>output.pendingPlayback.size===1,"interrupted turn audio should begin");
  await controller.handleSpeechEvent({type:"start",turnId:"turn-stale-queued"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-stale-queued",text:"This queued audio must never play."});
  const staleQueued=controller.finishTurn("turn-stale-queued");
  controller.stop("User interrupted Nova.");
  await Promise.all([interrupted,staleQueued]);
  equal(output.pendingPlayback.size,0,"interruption cancels active playback and all queued segments");
  const requestCount=provider.requests.length;
  await controller.handleSpeechEvent({type:"start",turnId:"turn-fresh"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-fresh",text:"Fresh message."});
  const fresh=controller.finishTurn("turn-fresh");
  await until(()=>provider.requests.length===requestCount+1&&output.pendingPlayback.size===1,"fresh speech works after interruption");
  output.finishPlayback(0);
  await fresh;
  equal(provider.requests.length,requestCount+1,"stale queued speech does not resume after interruption");
  controller.stop();
}
async function noFirstAudioTimesOutAndReleasesTurn():Promise<void>{
  const gate=deferred<void>();
  const provider:TtsProvider={
    id:"delayed-first-audio",
    capabilities:()=>capabilities,
    async testConnection(_preset:TtsPreset,_signal:AbortSignal){return {status:"healthy"};},
    async *synthesize(request:TtsSynthesisRequest,options:{signal:AbortSignal}):AsyncIterable<TtsStreamEvent>{
      yield {type:"start",sessionId:request.sessionId,audio:metadata};
      await gate.promise;
      if(options.signal.aborted){const error=new Error("cancelled");error.name="AbortError";throw error;}
      yield {type:"audio",sessionId:request.sessionId,sequence:0,data:new TextEncoder().encode(request.text)};
      yield {type:"done",sessionId:request.sessionId};
    }
  };
  const output=new RecordingOutput();
  const settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",startTimeoutMs:1000,presets:[preset(provider.id)]};
  const controller=new SpeechOutputController({getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output});
  await controller.unlockPlayback();
  await controller.handleSpeechEvent({type:"start",turnId:"turn-no-audio"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-no-audio",text:"Delayed first sentence."});
  const before=Date.now();
  await controller.finishTurn("turn-no-audio");
  ok(Date.now()-before>=900,"first-audio timeout respects the configured 1000 ms budget");
  equal(output.queued.length,0,"a provider that never starts audio is cancelled without late playback");
  ok(controller.getStatus().message.includes("playback did not start"),"startup timeout is observable through the TTS status");
  gate.resolve();
  await Promise.resolve();await Promise.resolve();
  controller.stop();
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

async function cancelledProviderEventsCannotEnterANewSession():Promise<void>{
  const output=new RecordingOutput(),provider=new LateEventProvider();
  const settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset(provider.id)]};
  const controller=new SpeechOutputController({getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output});
  await controller.unlockPlayback();
  await controller.handleSpeechEvent({type:"start",turnId:"turn-old"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-old",text:"Old sentence. "});
  await until(()=>provider.requests.length===1,"old synthesis must begin");
  await controller.handleSpeechEvent({type:"reset",turnId:"turn-old"});
  provider.releaseFirst();
  await until(()=>provider.completed===1,"cancelled provider iterator must unwind after its delayed event");
  equal(output.queued.length,0,"late PCM from an aborted provider is rejected before reaching audio output");

  await controller.handleSpeechEvent({type:"start",turnId:"turn-fresh"});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-old",text:"Stale delta. "});
  await controller.handleSpeechEvent({type:"delta",turnId:"turn-fresh",text:"Fresh sentence. "});
  await controller.finishTurn("turn-fresh");
  equal(provider.requests.length,2,"stale deltas do not create a synthesis request in the new turn");
  equal(output.queued.length,1,"only the fresh session receives PCM");
  equal(output.queued[0]?.text,"Fresh sentence. ","fresh-session audio excludes stale events");
  controller.stop();
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
type MockWebSocketMode="done"|"error"|"partial-close"|"empty-done"|"routing"|"hold"|"malformed-json"|"unknown"|"invalid-start"|"duplicate-start"|"audio-before-start"|"done-before-start"|"misaligned-pcm"|"close-before-audio"|"timeout-after-audio";
class MockWebSocket extends EventTarget{
  readyState=1;
  sent:string[]=[];
  constructor(private readonly mode:MockWebSocketMode="done"){super();}
  close(){this.readyState=3;this.dispatchEvent(new Event("close"));}
  send(value:string){
    this.sent.push(value);
    queueMicrotask(()=>{
      if(this.mode==="hold")return;
      if(this.mode==="malformed-json"){this.dispatchEvent(new MessageEvent("message",{data:"{not-json"}));return;}
      if(this.mode==="unknown"){this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"unknown-frame"})}));return;}
      if(this.mode==="audio-before-start"){this.dispatchEvent(new MessageEvent("message",{data:new Int16Array([1,2]).buffer}));return;}
      if(this.mode==="done-before-start"){this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"done"})}));return;}
      if(this.mode==="routing")this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"routing",status:"cpu_fallback",reason:"GPU unavailable; using CPU"})}));
      const start={type:"start",sample_rate:this.mode==="invalid-start"?1:44100,channels:2,format:"pcm16"};
      this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(start)}));
      if(this.mode==="duplicate-start"){this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(start)}));return;}
      if(this.mode==="close-before-audio"){this.close();return;}
      if(this.mode==="error"){
        this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"error",detail:"engine API key=fixture-secret"})}));
        return;
      }
      if(this.mode==="empty-done"){
        this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"done"})}));
        return;
      }
      const pcm=(this.mode==="misaligned-pcm"?new Int16Array([32767]):new Int16Array([32767,-32768,0,500])).buffer;
      this.dispatchEvent(new MessageEvent("message",{data:pcm}));
      if(this.mode==="misaligned-pcm")return;
      if(this.mode==="partial-close"){this.close();return;}
      if(this.mode==="timeout-after-audio")return;
      this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"done"})}));
    });
  }
}
async function voiceStudioWebSocketAndHttpFallback():Promise<void>{
  equal(validateVoiceStudioBaseUrl("http://127.0.0.1:3900"),"http://127.0.0.1:3900","loopback base URL is accepted");
  let invalidEngineRejected=false;
  const invalidEngineProvider=new VoiceStudioTtsProvider({createWebSocket:()=>new MockWebSocket() as unknown as WebSocket});
  const invalidEnginePreset={...preset("voice-studio"),providerOptions:{engine:"../../unsafe"}};
  for await(const event of invalidEngineProvider.synthesize({sessionId:"bad-engine",text:"test",preset:invalidEnginePreset,emotion:""},{signal:new AbortController().signal}))
    if(event.type==="error"&&event.error.code==="invalid_provider_options")invalidEngineRejected=true;
  ok(invalidEngineRejected,"invalid provider-specific engine identifiers are rejected by the adapter");
  for(const unsafe of ["https://127.0.0.1:3900","http://127.0.0.1:3901","http://127.0.0.1:3900/path","http://127.0.0.1:3900/?x=1","http://user:pass@127.0.0.1:3900","http://example.com:3900"]){
    let rejected=false;try{validateVoiceStudioBaseUrl(unsafe);}catch{rejected=true;}
    ok(rejected,"unsafe VoiceStudio URL is rejected: "+unsafe);
  }
  const socket=new MockWebSocket("routing");
  const wsProvider=new VoiceStudioTtsProvider({createWebSocket:()=>socket as unknown as WebSocket,requestTimeoutMs:1000});
  const events:TtsStreamEvent[]=[];
  for await(const event of wsProvider.synthesize({sessionId:"ws-test",text:"Привет",preset:{...preset("voice-studio"),providerOptions:{engine:"omnivoice"}},emotion:""}, {signal:new AbortController().signal}))events.push(event);
  equal(events.map(event=>event.type).join(","),"routing,start,audio,done","websocket protocol forwards routing, start, binary PCM and done");
  const routing=events[0];ok(routing?.type==="routing"&&routing.status==="cpu_fallback","VoiceStudio routing status is validated and surfaced as metadata");
  const start=events[1];ok(start?.type==="start"&&start.audio.sampleRate===44100&&start.audio.channels===2,"sample rate and channels come from actual start metadata");
  const audio=events[2];ok(audio?.type==="audio"&&audio.data.byteLength===8,"binary PCM16 chunk bytes are preserved");
  const request=JSON.parse(socket.sent[0]!) as Record<string,unknown>;
  equal(request.voice,"profile-test","VoiceStudio receives the configured profile ID");
  equal(request.speed,1,"VoiceStudio receives speed");
  equal(request.engine,"omnivoice","VoiceStudio receives the validated per-preset engine override");
  const omniVoiceCapabilities=wsProvider.capabilitiesForPreset({...preset("voice-studio"),providerOptions:{engine:"omnivoice"}});
  ok(omniVoiceCapabilities.supportsInstruction&&omniVoiceCapabilities.nonverbalTags.includes("laughter"),"only explicitly selected OmniVoice enables its supported expressions");
  const unknownEngineCapabilities=wsProvider.capabilitiesForPreset({...preset("voice-studio"),providerOptions:{engine:"other-engine"}});
  ok(!unknownEngineCapabilities.supportsInstruction&&unknownEngineCapabilities.nonverbalTags.length===0,"other engines expose no OmniVoice-specific expression capabilities");

  const otherEngineSocket=new MockWebSocket();
  const otherEngineProvider=new VoiceStudioTtsProvider({createWebSocket:()=>otherEngineSocket as unknown as WebSocket,requestTimeoutMs:1000});
  for await(const _event of otherEngineProvider.synthesize({
    sessionId:"other-engine",text:"Quietly",preset:{...preset("voice-studio"),providerOptions:{engine:"other-engine"}},emotion:"whisper",instruction:"whisper"
  },{signal:new AbortController().signal})){}
  const otherEngineRequest=JSON.parse(otherEngineSocket.sent[0]!) as Record<string,unknown>;
  ok(!Object.prototype.hasOwnProperty.call(otherEngineRequest,"instruct"),"provider never sends instruct to a non-OmniVoice engine, even when a caller supplies it");

  const unsupportedInstructionSocket=new MockWebSocket();
  const unsupportedInstructionProvider=new VoiceStudioTtsProvider({createWebSocket:()=>unsupportedInstructionSocket as unknown as WebSocket});
  for await(const _event of unsupportedInstructionProvider.synthesize({
    sessionId:"invalid-instruction",text:"Quiet",preset:{...preset("voice-studio"),providerOptions:{engine:"omnivoice"}},emotion:"custom",instruction:"use a different voice"
  },{signal:new AbortController().signal})){}
  const unsupportedInstructionRequest=JSON.parse(unsupportedInstructionSocket.sent[0]!) as Record<string,unknown>;
  ok(!Object.prototype.hasOwnProperty.call(unsupportedInstructionRequest,"instruct"),"unknown caller-supplied instructions are neutral even on OmniVoice");


  const heldSocket=new MockWebSocket("hold");
  const concurrentProvider=new VoiceStudioTtsProvider({createWebSocket:()=>heldSocket as unknown as WebSocket,requestTimeoutMs:10_000});
  const firstAbort=new AbortController();
  const firstIterator=concurrentProvider.synthesize({sessionId:"one-in-flight",text:"Still rendering",preset:preset("voice-studio"),emotion:""},{signal:firstAbort.signal})[Symbol.asyncIterator]();
  const firstNext=firstIterator.next();
  await until(()=>heldSocket.sent.length===1,"first websocket request should be sent before the competing request");
  const secondEvents:TtsStreamEvent[]=[];
  for await(const event of concurrentProvider.synthesize({sessionId:"must-not-overlap",text:"Concurrent request",preset:preset("voice-studio"),emotion:""},{signal:new AbortController().signal}))secondEvents.push(event);
  const concurrencyError=secondEvents.find(event=>event.type==="error");
  ok(concurrencyError?.type==="error"&&concurrencyError.error.code==="request_already_active","provider rejects a second request while the first websocket request is unfinished");
  firstAbort.abort();
  await firstNext.catch(()=>({value:undefined,done:true}));

  const engineErrorProvider=new VoiceStudioTtsProvider({createWebSocket:()=>new MockWebSocket("error") as unknown as WebSocket,fetch:async()=>{throw new Error("HTTP fallback must not override an engine error frame");}});
  const engineErrorEvents:TtsStreamEvent[]=[];
  for await(const event of engineErrorProvider.synthesize({sessionId:"engine-error",text:"Secret test",preset:preset("voice-studio"),emotion:""},{signal:new AbortController().signal}))engineErrorEvents.push(event);
  const engineError=engineErrorEvents.find(event=>event.type==="error");
  ok(engineError?.type==="error"&&!engineError.error.message.includes("fixture-secret"),"engine error frames are sanitized without exposing credentials");

  let fallbackAfterAudio=false;
  const partialCloseProvider=new VoiceStudioTtsProvider({createWebSocket:()=>new MockWebSocket("partial-close") as unknown as WebSocket,fetch:async()=>{fallbackAfterAudio=true;return new Response(null,{status:500});},requestTimeoutMs:1000});
  const partialCloseEvents:TtsStreamEvent[]=[];
  for await(const event of partialCloseProvider.synthesize({sessionId:"partial-close",text:"Already started",preset:preset("voice-studio"),emotion:""},{signal:new AbortController().signal}))partialCloseEvents.push(event);
  ok(partialCloseEvents.some(event=>event.type==="audio"),"binary audio queued before a socket close is drained");
  ok(partialCloseEvents.some(event=>event.type==="error"),"socket close after partial audio reports an error");
  ok(!fallbackAfterAudio,"HTTP fallback never repeats a sentence after websocket audio has been accepted");
  const malformedCases:Array<[MockWebSocketMode,string]>=[
    ["malformed-json","invalid_json_message"],
    ["unknown","invalid_protocol_message"],
    ["invalid-start","invalid_audio_metadata"],
    ["duplicate-start","invalid_audio_metadata"],
    ["audio-before-start","missing_audio_metadata"],
    ["done-before-start","missing_audio_metadata"],
    ["misaligned-pcm","invalid_audio_chunk"]
  ];
  for(const [mode,expectedCode] of malformedCases){
    let unexpectedFallback=false;
    const malformedProvider=new VoiceStudioTtsProvider({
      createWebSocket:()=>new MockWebSocket(mode) as unknown as WebSocket,
      fetch:async()=>{unexpectedFallback=true;throw new Error("unexpected fallback");},
      requestTimeoutMs:500
    });
    const malformedEvents:TtsStreamEvent[]=[];
    for await(const event of malformedProvider.synthesize({sessionId:"malformed-"+mode,text:"Test",preset:preset("voice-studio"),emotion:""},{signal:new AbortController().signal}))malformedEvents.push(event);
    const failure=malformedEvents.find(event=>event.type==="error");
    ok(failure?.type==="error"&&failure.error.code===expectedCode,mode+" produces its expected protocol error");
    ok(!unexpectedFallback,mode+" must not silently replace invalid protocol data with HTTP output");
  }

  let earlyCloseFallback=false;
  const earlyCloseProvider=new VoiceStudioTtsProvider({
    createWebSocket:()=>new MockWebSocket("close-before-audio") as unknown as WebSocket,
    fetch:async()=>{
      earlyCloseFallback=true;
      const wav=pcmWav();const body=new ArrayBuffer(wav.byteLength);new Uint8Array(body).set(wav);
      return new Response(body,{status:200});
    }
  });
  const earlyCloseEvents:TtsStreamEvent[]=[];
  for await(const event of earlyCloseProvider.synthesize({sessionId:"early-close",text:"Retryable before audio",preset:preset("voice-studio"),emotion:""},{signal:new AbortController().signal}))earlyCloseEvents.push(event);
  ok(earlyCloseFallback,"disconnect before audio permits HTTP WAV fallback");
  equal(earlyCloseEvents.map(event=>event.type).join(","),"start,audio,done","pre-audio disconnect discards stale WebSocket metadata");

  let malformedWavCalled=false;
  const malformedWavProvider=new VoiceStudioTtsProvider({
    createWebSocket:()=>{throw new Error("force HTTP WAV path");},
    fetch:async()=>{
      malformedWavCalled=true;
      const source=pcmWav(22050,2);
      const bytes=source.slice(0,46);
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      view.setUint32(4,bytes.byteLength-8,true);
      view.setUint32(40,2,true);
      return new Response(bytes,{status:200,headers:{"content-type":"audio/wav"}});
    }
  });
  const malformedWavEvents:TtsStreamEvent[]=[];
  for await(const event of malformedWavProvider.synthesize({
    sessionId:"misaligned-wav",text:"Malformed stereo WAV",preset:preset("voice-studio"),emotion:""
  },{signal:new AbortController().signal}))malformedWavEvents.push(event);
  ok(malformedWavCalled,"malformed stereo WAV reaches the HTTP fallback parser");
  equal(malformedWavEvents.map(event=>event.type).join(","),"error","WAV with an incomplete stereo frame is rejected before start/audio");
  const malformedWavError=malformedWavEvents[0];
  ok(malformedWavError?.type==="error"&&malformedWavError.error.code==="invalid_wav","WAV frame misalignment is reported at the provider boundary");

  let fallbackAfterTimeout=false;
  const timeoutProvider=new VoiceStudioTtsProvider({
    createWebSocket:()=>new MockWebSocket("timeout-after-audio") as unknown as WebSocket,
    fetch:async()=>{fallbackAfterTimeout=true;throw new Error("fallback would duplicate accepted audio");},
    requestTimeoutMs:25
  });
  const timeoutEvents:TtsStreamEvent[]=[];
  for await(const event of timeoutProvider.synthesize({sessionId:"timeout-after-audio",text:"Partial PCM",preset:preset("voice-studio"),emotion:""},{signal:new AbortController().signal}))timeoutEvents.push(event);
  equal(timeoutEvents.map(event=>event.type).join(","),"start,audio,error","timeout after accepted PCM returns a terminal event");
  const timeoutError=timeoutEvents.find(event=>event.type==="error");
  ok(timeoutError?.type==="error"&&timeoutError.error.code==="request_timeout","synthesis timeout reports request_timeout");
  ok(!fallbackAfterTimeout,"timeout after accepted PCM cannot trigger duplicate HTTP synthesis");


  let emptyDoneFallback=false;
  const emptyDoneProvider=new VoiceStudioTtsProvider({
    createWebSocket:()=>new MockWebSocket("empty-done") as unknown as WebSocket,
    fetch:async(_url,init)=>{
      emptyDoneFallback=true;
      ok(init.body instanceof FormData,"empty websocket completion falls back using multipart form");
      const wav=pcmWav();const body=new ArrayBuffer(wav.byteLength);new Uint8Array(body).set(wav);
      return new Response(body,{status:200});
    }
  });
  const emptyDoneEvents:TtsStreamEvent[]=[];
  for await(const event of emptyDoneProvider.synthesize({sessionId:"empty-done",text:"No websocket audio",preset:preset("voice-studio"),emotion:""},{signal:new AbortController().signal}))emptyDoneEvents.push(event);
  ok(emptyDoneFallback,"clean websocket completion without audio uses the HTTP fallback");
  equal(emptyDoneEvents.map(event=>event.type).join(","),"start,audio,done","empty websocket metadata is discarded before HTTP fallback");

  let sawForm=false,sawManualContentType=false;
  const fallback=new VoiceStudioTtsProvider({
    createWebSocket:()=>{throw new Error("WebSocket implementation unavailable");},
    fetch:async(url,init)=>{
      equal(url,"http://127.0.0.1:3900/generate","HTTP fallback posts to /generate");
      ok(init.body instanceof FormData,"HTTP fallback uses multipart FormData");
      const form=init.body as FormData;sawForm=form.get("text")==="One complete sentence"&&form.get("profile_id")==="profile-test"&&form.get("engine")==="omnivoice"&&form.get("wav_bits")==="16";
      const headers=new Headers(init.headers);sawManualContentType=headers.has("content-type");
      const wav=pcmWav();const body=new ArrayBuffer(wav.byteLength);new Uint8Array(body).set(wav);
      return new Response(body,{status:200,headers:{"content-type":"audio/wav"}});
    }
  });
  const httpEvents:TtsStreamEvent[]=[];
  for await(const event of fallback.synthesize({sessionId:"http-test",text:"One complete sentence",preset:{...preset("voice-studio"),providerOptions:{engine:"omnivoice"}},emotion:""}, {signal:new AbortController().signal}))httpEvents.push(event);
  ok(sawForm,"HTTP fallback posts text, profile_id, engine and PCM16 WAV format as multipart fields");
  ok(!sawManualContentType,"HTTP fallback lets the runtime supply FormData Content-Type and boundary");
  equal(httpEvents.map(event=>event.type).join(","),"start,audio,done","HTTP fallback parses WAV and exposes bounded audio chunks");
  const httpStart=httpEvents[0];ok(httpStart?.type==="start"&&httpStart.audio.sampleRate===22050,"WAV sample rate is parsed instead of guessed");
}

interface MockBuffer {duration:number;numberOfChannels:number;length:number;sampleRate:number;data:Float32Array[];getChannelData(index:number):Float32Array;}
interface MockSource {buffer:MockBuffer|null;onended:(()=>void)|null;connect(target:unknown):void;disconnect():void;start(when?:number):void;stop():void;}
async function websocketRequestLockReleasedBeforeCancelledIteratorSettles():Promise<void>{
  const firstSocket=new MockWebSocket("hold"),secondSocket=new MockWebSocket("done");
  const sockets=[firstSocket,secondSocket];
  const provider=new VoiceStudioTtsProvider({
    createWebSocket:()=>sockets.shift() as unknown as WebSocket,
    requestTimeoutMs:1000
  });
  const abort=new AbortController();
  const firstIterator=provider.synthesize({
    sessionId:"cancelled-request",text:"Old request",preset:preset("voice-studio"),emotion:""
  },{signal:abort.signal})[Symbol.asyncIterator]();
  const firstNext=firstIterator.next();
  await until(()=>firstSocket.sent.length===1,"old websocket request must be active before abort");
  const oldOutcome=firstNext.then(()=> "resolved",()=> "rejected");
  abort.abort();

  const freshEvents:TtsStreamEvent[]=[];
  for await(const event of provider.synthesize({
    sessionId:"fresh-request",text:"New request",preset:preset("voice-studio"),emotion:""
  },{signal:new AbortController().signal}))freshEvents.push(event);

  equal(await oldOutcome,"rejected","the cancelled operation rejects its outstanding read");
  equal(freshEvents.map(event=>event.type).join(","),"start,audio,done","a fresh request can start immediately after cancellation");
  ok(secondSocket.sent.length===1,"the fresh request owns a new websocket");
}
async function webAudioRecoversAfterTransientOutputFailure():Promise<void>{
  const scheduled:MockSource[]=[],sources:MockSource[]=[],failures:Error[]=[];
  let failFirstBuffer=true;
  const mockContext={
    currentTime:0,state:"running",destination:{},
    async resume(){this.state="running";},async close(){this.state="closed";},
    createBuffer(channels:number,length:number,sampleRate:number):MockBuffer{
      if(failFirstBuffer){failFirstBuffer=false;throw new Error("simulated transient AudioBuffer failure");}
      const data=Array.from({length:channels},()=>new Float32Array(length));
      return {duration:length/sampleRate,numberOfChannels:channels,length,sampleRate,data,getChannelData:(index:number)=>data[index]!};
    },
    createBufferSource():MockSource{
      const source:MockSource={
        buffer:null,onended:null,connect(){},disconnect(){},
        start(){scheduled.push(source);},
        stop(){source.onended?.();}
      };
      sources.push(source);return source;
    }
  };
  const output=new WebAudioOutputAdapter({
    createContext:()=>mockContext as unknown as AudioContext,
    onError:error=>failures.push(error)
  });
  await output.unlock();
  output.startSession("failed-audio-session",metadata);
  await output.enqueue("failed-audio-session",0,metadata,new Uint8Array([0xe8,0x03,0x18,0xfc]),new AbortController().signal);
  await until(()=>failures.length===1,"the first physical audio session records its injected output failure");
  const failedWait=await output.waitForPlayback("failed-audio-session",new AbortController().signal).then(()=>undefined,error=>error as Error);
  equal(failedWait?.message,"simulated transient AudioBuffer failure","a failure is propagated even when the playback waiter registers after the pump has already failed");
  output.startSession("recovered-audio-session",metadata);
  await output.enqueue("recovered-audio-session",0,metadata,new Uint8Array([0xd0,0x07,0x30,0xf8]),new AbortController().signal);
  await until(()=>scheduled.length===1,"a fresh TTS session schedules PCM after the previous output error");
  scheduled[0]!.onended?.();
  await output.waitForPlayback("recovered-audio-session",new AbortController().signal);
  equal(failures[0]?.message,"simulated transient AudioBuffer failure","the initial failure was real and observed");
  await output.dispose();
}

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


function responseBody(bytes:Uint8Array):ArrayBuffer{
  const copy=new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
function sileroWav(sampleRate=44100,channels=2,pcmBytes=8,withExtraChunk=false):Uint8Array{
  const extraSize=withExtraChunk?12:0;
  const bytes=new Uint8Array(44+extraSize+pcmBytes+(pcmBytes%2));
  const view=new DataView(bytes.buffer);
  const put=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i);};
  put(0,"RIFF");view.setUint32(4,bytes.length-8,true);put(8,"WAVE");
  put(12,"fmt ");view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,channels,true);
  view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*channels*2,true);
  view.setUint16(32,channels*2,true);view.setUint16(34,16,true);
  let offset=36;
  if(withExtraChunk){put(offset,"JUNK");view.setUint32(offset+4,3,true);bytes.set([1,2,3],offset+8);offset+=12;}
  put(offset,"data");view.setUint32(offset+4,pcmBytes,true);
  return bytes;
}
function sileroPreset(overrides:Partial<TtsPreset>={}):TtsPreset{
  return {
    ...preset("silero"),baseUrl:"http://127.0.0.1:9123",voiceProfileId:"kseniya",
    speed:1.25,credentialReference:null,providerOptions:{model:"tts-fixture"},...overrides
  };
}
async function collectSilero(
  provider:SileroTtsProvider,
  selectedPreset:TtsPreset=sileroPreset(),
  textValue="Привет!",
  signal:AbortSignal=new AbortController().signal
):Promise<TtsStreamEvent[]>{
  const events:TtsStreamEvent[]=[];
  for await(const event of provider.synthesize({sessionId:"silero-test",text:textValue,preset:selectedPreset,emotion:""}, {signal}))events.push(event);
  return events;
}
function sileroError(events:TtsStreamEvent[],code:string,message:string):void{
  const event=events[0];
  ok(event?.type==="error",message+" must emit an error event");
  equal(event.error.code,code,message+" error code");
}
async function sileroProviderProtocolAndWav():Promise<void>{
  const requests:Array<{url:string;init:RequestInit}>=[];
  const audio=sileroWav(44100,2,8,true);
  const provider=new SileroTtsProvider({
    fetch:async(url,init)=>{requests.push({url,init});return new Response(responseBody(audio),{status:200,headers:{"content-type":"audio/wav"}});},
    requestTimeoutMs:1000
  });
  const events=await collectSilero(provider);
  equal(requests.length,1,"one Silero HTTP request is made per supplied sentence");
  equal(requests[0]!.url,"http://127.0.0.1:9123/v1/audio/speech","Silero uses the preset URL with a configurable port");
  equal(requests[0]!.init.method,"POST","Silero synthesis uses POST");
  equal(requests[0]!.init.redirect,"error","Silero requests reject redirects");
  const payload=JSON.parse(String(requests[0]!.init.body)) as Record<string,unknown>;
  equal(payload.model,"tts-fixture","Silero model comes from providerOptions.model");
  equal(payload.input,"Привет!","Silero receives request.text without splitting or collecting text");
  equal(payload.voice,"kseniya","Silero voice comes from voiceProfileId");
  equal(payload.response_format,"wav","Silero requests WAV for its private decoder");
  equal(payload.speed,1.25,"Silero speed comes from the selected preset");
  ok(!Object.prototype.hasOwnProperty.call(payload,"language"),"Silero does not send the non-operative language setting");
  ok(!Object.keys(requests[0]!.init.headers as Record<string,string>).some(key=>key.toLowerCase()==="authorization"),"Silero does not add API authorization");
  equal(events.map(event=>event.type).join(","),"start,audio,done","Silero emits start, raw PCM audio, then done");
  const start=events[0];ok(start?.type==="start","Silero start metadata is present");
  equal(start.audio.sampleRate,44100,"WAV sample rate is preserved");
  equal(start.audio.channels,2,"WAV channel count is preserved");
  equal(start.audio.format,"pcm16le","WAV metadata is converted to pcm16le");
  const audioEvent=events[1];ok(audioEvent?.type==="audio","PCM audio event is present");
  equal(audioEvent.data.byteLength,8,"PCM data excludes RIFF/WAVE headers and chunk metadata");
  equal(audioEvent.sequence,0,"the first PCM event sequence is zero");
  ok(!provider.capabilities().streaming,"Silero is not advertised as streaming because its API returns a complete WAV");

  const chunkRequests:Array<{url:string;init:RequestInit}>=[];
  const longPcmLength=150_000;
  const largeProvider=new SileroTtsProvider({
    fetch:async(url,init)=>{chunkRequests.push({url,init});return new Response(responseBody(sileroWav(22050,2,longPcmLength)),{status:200});},
    requestTimeoutMs:1000
  });
  const chunks=await collectSilero(largeProvider);
  equal(chunks.map(event=>event.type).join(","),"start,audio,audio,audio,done","large PCM is split into bounded audio events");
  const audioChunks=chunks.filter((event):event is Extract<TtsStreamEvent,{type:"audio"}>=>event.type==="audio");
  equal(audioChunks.reduce((sum,event)=>sum+event.data.byteLength,0),longPcmLength,"PCM chunking preserves every audio byte");
  for(let i=0;i<audioChunks.length;i++){
    ok(audioChunks[i]!.data.byteLength<=64*1024,"Silero audio chunk stays under 64 KiB");
    equal(audioChunks[i]!.data.byteLength%4,0,"stereo PCM chunks are aligned to complete audio frames");
    equal(audioChunks[i]!.sequence,i,"PCM chunk sequence increases in order");
  }
}
async function sileroProviderFailuresAndHealth():Promise<void>{
  const invalidPreset={...sileroPreset(),baseUrl:"http://example.com:9123"};
  let unsafeFetchCalled=false;
  const unsafeProvider=new SileroTtsProvider({fetch:async()=>{unsafeFetchCalled=true;return new Response(responseBody(sileroWav()));}});
  const unsafeEvents=await collectSilero(unsafeProvider,invalidPreset);
  sileroError(unsafeEvents,"unsafe_base_url","Non-loopback Silero URLs");
  ok(!unsafeFetchCalled,"unsafe base URLs are rejected before fetch");
  for(const unsafe of [
    "https://127.0.0.1:9123","http://user:pass@127.0.0.1:9123",
    "http://127.0.0.1:9123/path","http://127.0.0.1:9123/?x=1","http://127.0.0.1:9123/#fragment"
  ]){
    const result=await collectSilero(unsafeProvider,{...sileroPreset(),baseUrl:unsafe});
    sileroError(result,unsafe.startsWith("http://user:")||unsafe.includes("/path")||unsafe.includes("?")||unsafe.includes("#")||unsafe.startsWith("https:")
      ?"unsafe_base_url":"unsafe_base_url","Unsafe Silero URL "+unsafe);
  }

  for(const [name,body] of [["empty WAV",new Uint8Array(0)],["truncated WAV",new Uint8Array([82,73,70,70,4,0,0,0,87,65,86,69])]] as const){
    const provider=new SileroTtsProvider({fetch:async()=>new Response(responseBody(body),{status:200}),requestTimeoutMs:1000});
    sileroError(await collectSilero(provider),"invalid_wav",name);
  }
  for(const status of [401,403,404,422,503]){
    const httpProvider=new SileroTtsProvider({fetch:async()=>new Response("fixture server failure",{status})});
    const httpEvents=await collectSilero(httpProvider);
    sileroError(httpEvents,"http_error","Silero HTTP "+status);
    const httpError=httpEvents[0];
    ok(httpError?.type==="error"&&!httpError.error.message.includes("fixture server failure"),"HTTP "+status+" response body is not leaked");
    if(status===401||status===403)ok(httpError?.type==="error"&&httpError.error.message.includes("authorization"),"HTTP "+status+" indicates authorization is required");
  }
  const networkProvider=new SileroTtsProvider({fetch:async()=>{throw new Error("http://127.0.0.1:9123 private connection text");}});
  const networkEvents=await collectSilero(networkProvider);
  sileroError(networkEvents,"transport_error","Silero connection failure");
  const networkError=networkEvents[0];
  ok(networkError?.type==="error"&&!networkError.error.message.includes("9123"),"network errors do not expose the local URL");

  const waitsForAbort:SileroFetch=async(_url,init)=>await new Promise<Response>((_resolve,reject)=>{
    const signal=init.signal;
    if(!signal)throw new Error("Expected timeout signal.");
    const cancel=()=>{const error=new Error("aborted");error.name="AbortError";reject(error);};
    signal.addEventListener("abort",cancel,{once:true});
  });
  const timeoutProvider=new SileroTtsProvider({fetch:waitsForAbort,requestTimeoutMs:5});
  sileroError(await collectSilero(timeoutProvider),"timeout","Silero synthesis timeout");
  const cancelController=new AbortController();
  let started!:()=>void;
  const fetchStarted=new Promise<void>(resolve=>{started=resolve;});
  const cancellableProvider=new SileroTtsProvider({
    fetch:async(_url,init)=>await new Promise<Response>((_resolve,reject)=>{
      const signal=init.signal;
      if(!signal)throw new Error("Expected cancellation signal.");
      signal.addEventListener("abort",()=>{const error=new Error("aborted");error.name="AbortError";reject(error);},{once:true});
      started();
    }),
    requestTimeoutMs:10_000
  });
  const cancelPromise=collectSilero(cancellableProvider,sileroPreset(),"Cancel me",cancelController.signal);
  await fetchStarted;
  cancelController.abort();
  sileroError(await cancelPromise,"cancelled","External cancellation");

  const healthRequests:Array<{url:string;init:RequestInit}>=[];
  const sileroOpenApiFixture={
    openapi:"3.1.0",
    paths:{"/v1/audio/speech":{post:{
      requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/SpeechRequest"}}}}
    }}},
    components:{schemas:{SpeechRequest:{
      type:"object",required:["model","input","voice"],
      properties:{model:{type:"string"},input:{type:"string"},voice:{type:"string"},response_format:{type:"string"},speed:{type:"number"}}
    }}}
  };
  const healthProvider=new SileroTtsProvider({
    fetch:async(url,init)=>{
      healthRequests.push({url,init});
      if(url.endsWith("/openapi.json"))
        return new Response(JSON.stringify(sileroOpenApiFixture),{status:200,headers:{"content-type":"application/json"}});
      return new Response(responseBody(sileroWav()),{status:200,headers:{"content-type":"audio/wav"}});
    }
  });
  const health=await healthProvider.testConnection(sileroPreset(),new AbortController().signal);
  equal(health.status,"healthy","connection test confirms a compatible API and a PCM16 WAV probe");
  equal(healthRequests.length,2,"connection test checks OpenAPI and the actual speech endpoint");
  equal(healthRequests[0]!.url,"http://127.0.0.1:9123/openapi.json","OpenAPI uses selected preset URL");
  equal(healthRequests[0]!.init.method,"GET","OpenAPI check uses GET");
  equal(healthRequests[0]!.init.redirect,"error","OpenAPI check rejects redirects");
  ok(!healthRequests[0]!.init.body,"OpenAPI check has no body");
  equal(healthRequests[1]!.url,"http://127.0.0.1:9123/v1/audio/speech","health probe calls the speech endpoint");
  equal(healthRequests[1]!.init.method,"POST","speech probe uses POST");
  equal(healthRequests[1]!.init.redirect,"error","speech probe rejects redirects");
  const probePayload=JSON.parse(String(healthRequests[1]!.init.body)) as Record<string,unknown>;
  equal(probePayload.model,"tts-fixture","health probe uses selected model");
  equal(probePayload.input,"Привет.","health probe synthesizes non-empty audio to validate the real endpoint");
  equal(probePayload.voice,"kseniya","health probe uses selected voice");
  equal(probePayload.response_format,"wav","health probe requests WAV");
  equal(probePayload.speed,1,"health probe avoids FFmpeg for speed changes");

  let authProbeReached=false;
  const authOnSpeechProvider=new SileroTtsProvider({fetch:async(url)=>{
    if(url.endsWith("/openapi.json"))
      return new Response(JSON.stringify(sileroOpenApiFixture),{status:200,headers:{"content-type":"application/json"}});
    authProbeReached=true;return new Response("unauthorized",{status:401});
  }});
  const authHealth=await authOnSpeechProvider.testConnection(sileroPreset(),new AbortController().signal);
  ok(authProbeReached,"health check tests the auth-protected speech endpoint");
  equal(authHealth.status,"unavailable","public OpenAPI cannot mask POST authorization errors");
  ok(authHealth.message?.includes("authorization"),"POST auth error is explained");

  const healthTimeoutProvider=new SileroTtsProvider({fetch:waitsForAbort,connectionTimeoutMs:5});
  const healthTimeout=await healthTimeoutProvider.testConnection(sileroPreset(),new AbortController().signal);
  equal(healthTimeout.status,"unavailable","connection timeout uses existing unavailable status");
  equal(healthTimeout.message,"Silero connection check timed out.","connection timeout has a safe diagnostic");
}

async function lifeSpeechEventsReachAudioAndAwaitPhysicalPlayback():Promise<void>{
  class PcmRecordingProvider extends RecordingProvider{
    override async *synthesize(request:TtsSynthesisRequest,options:{signal:AbortSignal}):AsyncIterable<TtsStreamEvent>{
      this.requests.push(request.text);this.emotions.push(request.emotion);
      if(options.signal.aborted){const error=new Error("cancelled");error.name="AbortError";throw error;}
      yield {type:"start",sessionId:request.sessionId,audio:metadata};
      yield {type:"audio",sessionId:request.sessionId,sequence:0,data:new Uint8Array([0xe8,0x03,0x18,0xfc,0xd0,0x07,0x30,0xf8])};
      yield {type:"done",sessionId:request.sessionId};
    }
  }
  const played:MockSource[]=[],sources:MockSource[]=[],audioErrors:Error[]=[];
  const mockContext={
    currentTime:0,state:"running",destination:{},
    async resume(){this.state="running";},async close(){this.state="closed";},
    createBuffer(channels:number,length:number,sampleRate:number):MockBuffer{
      const data=Array.from({length:channels},()=>new Float32Array(length));
      return {duration:length/sampleRate,numberOfChannels:channels,length,sampleRate,data,getChannelData:(index:number)=>data[index]!};
    },
    createBufferSource():MockSource{
      const source:MockSource={
        buffer:null,onended:null,connect(){},disconnect(){},
        start(){played.push(source);},
        stop(){source.onended?.();}
      };
      sources.push(source);return source;
    }
  };
  const output=new WebAudioOutputAdapter({createContext:()=>mockContext as unknown as AudioContext,onError:error=>audioErrors.push(error)});
  const provider=new PcmRecordingProvider();
  const settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset()]};
  const controller=new SpeechOutputController({getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output});
  await controller.unlockPlayback();
  const text="Nova Life public speech reaches PCM playback.";
  const runtime=new MindRuntime({
    cognitiveStep:{async run(context){
      await context.onSpeechEvent?.({type:"start",conversationId:"conversation.life-tts"});
      await context.onSpeechEvent?.({type:"delta",conversationId:"conversation.life-tts",text});
      return {turn:{version:1,situation:"",thoughts:"",emotion:"",tools:[],toolResults:[],speech:text,nextWakeMs:30_000},conversationId:"conversation.life-tts"};
    }},
    schedule:{mode:"fixed",defaultIntervalMs:30_000,minIntervalMs:3_000,maxIntervalMs:300_000,maxRequestsPerHour:null},
    turnSink:{
      async commit(_turn,context){await controller.finishTurn(context.turnId);},
      async streamSpeech(event){await controller.handleSpeechEvent(event);}
    }
  });
  runtime.setActiveCharacter("character.life-tts");
  try{
    await runtime.start();
    await until(()=>played.length===1,"Nova Life PCM reaches an AudioBufferSource and starts physical playback");
    equal(provider.requests[0],text,"only the public cognitive delta is synthesized");
    equal(runtime.getState().lifecycleState,"thinking","the cognitive step waits while Web Audio is playing");
    equal(audioErrors.length,0,"the Web Audio adapter plays the generated PCM without output errors");
    played[0]!.onended?.();
    await until(()=>runtime.getState().lifecycleState==="waiting","physical Web Audio completion releases the next timer");
    equal(controller.getStatus().message,"Assistant speech playback completed.","TTS session finalizes only after physical playback");
  }finally{
    controller.stop("Life TTS integration cleanup.");
    await runtime.stop();
    await output.dispose();
  }
}

async function failedNovaLifeTurnWaitsForStreamedSpeech():Promise<void>{
  const output=new PlaybackControlledOutput(),provider=new RecordingProvider();
  const settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset()]};
  const controller=new SpeechOutputController({getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output});
  await controller.unlockPlayback();
  const runtime=new MindRuntime({
    cognitiveStep:{async run(context){
      await context.onSpeechEvent?.({type:"start",conversationId:"conversation.failed-speech"});
      await context.onSpeechEvent?.({type:"delta",conversationId:"conversation.failed-speech",text:"This streamed speech must finish."});
      // Mimic another native-tool round; it must not clear speech streamed by the prior round.
      await context.onSpeechEvent?.({type:"start",conversationId:"conversation.failed-speech"});
      throw new Error("fixture provider failure after public speech");
    }},
    schedule:{mode:"fixed",defaultIntervalMs:30_000,minIntervalMs:3_000,maxIntervalMs:300_000,maxRequestsPerHour:null},
    turnSink:{
      async commit(){throw new Error("failed cognitive turn must not commit");},
      async streamSpeech(event){
        if(event.type==="finish"){await controller.finishTurn(event.turnId);return;}
        await controller.handleSpeechEvent(event);
      }
    }
  });
  runtime.setActiveCharacter("character.failed-speech");
  try{
    await runtime.start();
    await until(()=>output.pendingPlayback.size===1,"public speech from a failed turn must reach playback");
    equal(runtime.getState().lifecycleState,"thinking","Nova Life waits while streamed speech is still playing after a model error");
    equal(provider.requests.length,1,"a repeated native-tool start does not erase streamed public speech");
    output.finishPlayback(0);
    await until(()=>runtime.getState().lifecycleState==="waiting","failed turn schedules its backoff only after started speech drains");
    ok(runtime.getState().recentTrace?.some(entry=>entry.result==="error"),"failed model turn remains visible in the trace");
  }finally{
    controller.stop("Failure-drain test cleanup.");
    await runtime.stop();
  }
}
async function healthyConnectionDoesNotMaskLockedPlayback():Promise<void>{
  const output=new PlaybackControlledOutput(),provider=new RecordingProvider(),diagnostics:string[]=[];
  const settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset()]};
  const controller=new SpeechOutputController({
    getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output,
    onDiagnostic:code=>diagnostics.push(code)
  });
  try{
    const health=await controller.testConnection();
    equal(health.status,"healthy","TTS provider connection itself can succeed");
    equal(controller.getStatus().state,"locked","successful provider health must not imply that browser playback is enabled");
    ok(controller.getStatus().message.includes("audio playback is locked"),"status explains why connected TTS cannot yet play");
    await controller.handleSpeechEvent({type:"start",turnId:"locked-turn"});
    await controller.handleSpeechEvent({type:"delta",turnId:"locked-turn",text:"This message must not silently synthesize."});
    await controller.finishTurn("locked-turn");
    equal(provider.requests.length,0,"audio-locked turns do not call synthesize without a user gesture");
    ok(diagnostics.includes("TTS_AUDIO_LOCKED"),"skipped locked audio is visible in diagnostics");

    await controller.unlockPlayback();
    await controller.handleSpeechEvent({type:"start",turnId:"unlocked-turn"});
    await controller.handleSpeechEvent({type:"delta",turnId:"unlocked-turn",text:"Audio works after unlocking."});
    const finished=controller.finishTurn("unlocked-turn");
    await until(()=>output.pendingPlayback.size===1,"an unlocked fresh turn sends synthesized audio to playback");
    equal(provider.requests[0],"Audio works after unlocking.","only the fresh unlocked public speech is synthesized");
    output.finishPlayback(0);
    await finished;
    equal(controller.getStatus().message,"Assistant speech playback completed.","unlocked audio completes as usual");
  }finally{controller.stop("Locked playback test cleanup.");}
}

async function lifeTurnFinalizesAfterPlaybackTimeoutWithoutLosingText():Promise<void>{
  const output=new PlaybackControlledOutput(),provider=new RecordingProvider(),diagnostics:string[]=[];
  const settings:TtsSettings={...DEFAULT_TTS_SETTINGS,enabled:true,activePresetId:"test-preset",presets:[preset()]};
  const controller=new SpeechOutputController({
    getSettings:()=>settings,getProvider:id=>id===provider.id?provider:undefined,output,finishTimeoutMs:30,
    onDiagnostic:code=>diagnostics.push(code)
  });
  await controller.unlockPlayback();
  const text="The saved answer survives a stuck audio device.";
  let persistedText="";
  const runtime=new MindRuntime({
    cognitiveStep:{async run(context){
      await context.onSpeechEvent?.({type:"start",conversationId:"conversation.tts-timeout"});
      await context.onSpeechEvent?.({type:"delta",conversationId:"conversation.tts-timeout",text});
      return {turn:{version:1,situation:"",thoughts:"",emotion:"",tools:[],toolResults:[],speech:text,nextWakeMs:30_000},conversationId:"conversation.tts-timeout"};
    }},
    schedule:{mode:"fixed",defaultIntervalMs:30_000,minIntervalMs:3_000,maxIntervalMs:300_000,maxRequestsPerHour:null},
    turnSink:{
      async commit(turn,context){persistedText=turn.speech;await controller.finishTurn(context.turnId);},
      async streamSpeech(event){await controller.handleSpeechEvent(event);}
    }
  });
  runtime.setActiveCharacter("character.tts-timeout");
  try{
    await runtime.start();
    await untilWithTimeout(()=>runtime.getState().lifecycleState==="waiting"&&persistedText===text,"a stuck playback reaches its bounded timeout and releases the Life scheduler");
    equal(persistedText,text,"public reply is persisted independently of TTS playback completion");
    ok(diagnostics.includes("TTS_FINISH_FAILED"),"playback timeout is diagnosed rather than reported as completed audio");
    equal(controller.getStatus().state,"error","the controller does not report stuck playback as successful");
    ok(runtime.getState().recentTrace?.some(entry=>entry.result==="success"),"a successfully committed cognitive reply is not erased by the separate audio failure");
    equal(output.pendingPlayback.size,0,"timed-out playback session is cancelled from the FIFO output");
    await controller.handleSpeechEvent({type:"start",turnId:"fresh-after-timeout"});
    await controller.handleSpeechEvent({type:"delta",turnId:"fresh-after-timeout",text:"Fresh audio."});
    const fresh=controller.finishTurn("fresh-after-timeout");
    await until(()=>output.pendingPlayback.size===1,"a new session starts after the timed-out audio session");
    output.finishPlayback(0);
    await fresh;
    equal(controller.getStatus().message,"Assistant speech playback completed.","a subsequent healthy audio session finalizes normally");
  }finally{
    controller.stop("TTS timeout test cleanup.");
    await runtime.stop();
  }
}

async function main():Promise<void>{
  sentenceBoundariesPreserveEveryCharacter();
  emotionMappingOnlyUsesSupportedActions();
  emotionDecodersDoNotGateSpeech();
  await synthesisRunsAheadOfPlaybackAndKeepsFifo();
  await segmentSynthesisFailureDoesNotStopAlreadyQueuedSpeech();
  await assistantTurnsWaitForPlaybackAndInterruptionClearsQueue();
  await failedNovaLifeTurnWaitsForStreamedSpeech();
  await noFirstAudioTimesOutAndReleasesTurn();
  await healthyConnectionDoesNotMaskLockedPlayback();
  await lifeTurnFinalizesAfterPlaybackTimeoutWithoutLosingText();
  await lifeSpeechEventsReachAudioAndAwaitPhysicalPlayback();
  await boundedBackpressureAndCancellation();
  await cancelledProviderEventsCannotEnterANewSession();
  await voiceStudioWebSocketAndHttpFallback();
  await sileroProviderProtocolAndWav();
  await sileroProviderFailuresAndHealth();
  await websocketRequestLockReleasedBeforeCancelledIteratorSettles();
  await webAudioRecoversAfterTransientOutputFailure();
  await webAudioSchedulesFifoWithoutOverlap();
  console.log("PASS TTS sentence, emotion, controller, provider and Web Audio tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
