import type {MindTurnSpeechEvent} from "../../../../contracts/src/mind-runtime";
import type {
  TtsAudioMetadata,TtsPreset,TtsProvider,TtsProviderCapabilities,TtsSettings,TtsStreamEvent,TtsSynthesisRequest
} from "../../../../contracts/src/tts";

export interface AudioSegmentPlaybackOptions {
  /** Stable sequence for one logical sentence/segment, distinct from its PCM chunk sequence. */
  segmentSequence:number;
  /** Inserted before the first PCM chunk for this segment, never between chunks of the same segment. */
  gapBeforeMs:number;
  onPlaybackStarted?:()=>void;
}
export type TtsSegmentStatus="queued"|"synthesizing"|"buffered"|"playing"|"completed"|"failed"|"cancelled";
export interface AudioOutputAdapter {
  unlock():Promise<void>;
  startSession(sessionId:string,metadata:TtsAudioMetadata):void;
  enqueue(sessionId:string,sequence:number,metadata:TtsAudioMetadata,data:Uint8Array,signal:AbortSignal,segment?:AudioSegmentPlaybackOptions):Promise<void>;
  markSegmentSynthesisComplete?(sessionId:string,segmentSequence:number):void;
  waitForSegmentPlayback?(sessionId:string,segmentSequence:number,signal:AbortSignal):Promise<void>;
  /** Resolves only after the session's final audio has physically finished playback. */
  waitForPlayback?(sessionId:string,signal:AbortSignal):Promise<void>;
  stop(sessionId?:string):void;
}
export type SpeechOutputState="disabled"|"locked"|"ready"|"synthesizing"|"error";
export interface SpeechOutputStatus {
  state:SpeechOutputState;
  message:string;
  sessionId?:string;
}
export interface SpeechOutputControllerOptions {
  getSettings:()=>TtsSettings;
  getProvider:(id:string)=>TtsProvider|undefined;
  output:AudioOutputAdapter;
  onDiagnostic?:(code:string,message:string)=>void;
  /** Bounds synthesis and physical playback finalization; timeout is diagnosed as a failure. */
  finishTimeoutMs?:number;
}
interface SentenceTask {text:string;emotion:string;sequence:number;}
interface Session {
  turnId:string;
  id:string;
  preset:TtsPreset;
  provider:TtsProvider;
  abort:AbortController;
  queue:SentenceTask[];
  waitingWriters:Array<()=>void>;
  queueWaiters:Array<()=>void>;
  queuedChars:number;
  segmenter:SpeechSentenceSegmenter;
  emotion:string;
  worker?:Promise<void>;
  finishing:boolean;
  failed:boolean;
  outputSequence:number;
  nextSegmentSequence:number;
  hasAudio:boolean;
  playbackStarted:boolean;
  segmentStates:Map<number,TtsSegmentStatus>;
  startTimeoutMs:number;
  segmentGapMs:number;
  segmentError?:string;
  startTimer?:ReturnType<typeof setTimeout>;
  finishPromise?:Promise<void>;
}
const MAX_PENDING_SENTENCES=12;
const MAX_PENDING_TEXT_CHARS=8_000;
const MAX_SENTENCE_CHARS=1_200;
const MAX_AUDIO_EVENT_BYTES=512*1024;
const DEFAULT_FINISH_TIMEOUT_MS=60_000;
const DEFAULT_START_TIMEOUT_MS=10_000;
const DEFAULT_SEGMENT_GAP_MS=500;

class TtsOutputError extends Error {
  constructor(error:unknown){super(safeError(error));this.name="TtsOutputError";}
}

function aborted(signal:AbortSignal):boolean{return signal.aborted;}
function abortError():Error{const e=new Error("Speech session was cancelled.");e.name="AbortError";return e;}
function presetCopy(preset:TtsPreset):TtsPreset{return {...preset,credentialReference:preset.credentialReference?{...preset.credentialReference}:null,providerOptions:{...preset.providerOptions}};}
function safeError(error:unknown):string{
  if(error&&typeof error==="object"&&"name" in error&&(error as {name?:unknown}).name==="AbortError")return "Speech session stopped.";
  if(error&&typeof error==="object"&&"message" in error&&typeof (error as {message?:unknown}).message==="string")
    return (error as {message:string}).message.replace(/https?:\/\/\S+/gi,"[url]").replace(/(?:token|secret|password|api.?key)\s*[:=]\s*\S+/gi,"[redacted]").slice(0,240);
  return "Text-to-speech synthesis failed.";
}
function isCloser(character:string):boolean{return /[\u0022'”’»›)\]}]/u.test(character);}
function isWhite(character:string):boolean{return /\s/u.test(character);}
function safeRoutingMessage(status:string,reason?:string):string{
  const safe=(reason??"").replace(/https?:\/\/\S+/gi,"[url]").replace(/(?:token|secret|password|api.?key)\s*[:=]\s*\S+/gi,"[redacted]").replace(/[\r\n\t]+/g," ").slice(0,200);
  return "VoiceStudio routing: "+status+(safe?" — "+safe:"");
}

function safeTextSplit(text:string,limit:number):number{
  if(text.length<=limit)return -1;
  let index=text.lastIndexOf(" ",limit);
  if(index<Math.floor(limit*0.55))index=text.indexOf(" ",limit);
  if(index<0||index>Math.floor(limit*1.35))index=limit;
  if(index>0&&index<text.length&&text.charCodeAt(index-1)>=0xD800&&text.charCodeAt(index-1)<=0xDBFF)index++;
  return index;
}

/** Streaming-safe sentence splitter. It preserves every source character across chunk boundaries. */
export class SpeechSentenceSegmenter {
  private buffer="";
  push(delta:string):string[]{
    if(!delta)return [];
    this.buffer+=delta;
    const result:string[]=[];
    for(;;){
      const detected=this.findBoundary();
      const safeCut=safeTextSplit(this.buffer,MAX_SENTENCE_CHARS);
      const boundary=safeCut>0&&(detected<0||safeCut<detected)?safeCut:detected;
      if(boundary>0){
        const part=this.buffer.slice(0,boundary);
        this.buffer=this.buffer.slice(boundary);
        if(part.trim())result.push(part);
        else {this.buffer=part+this.buffer;break;}
        continue;
      }
      if(this.buffer.length>MAX_SENTENCE_CHARS){
        const cut=safeTextSplit(this.buffer,MAX_SENTENCE_CHARS);
        if(cut>0){
          const part=this.buffer.slice(0,cut);this.buffer=this.buffer.slice(cut);
          if(part.trim())result.push(part);else {this.buffer=part+this.buffer;break;}
          continue;
        }
      }
      break;
    }
    return result;
  }
  finish():string[]{
    const rest=this.buffer;this.buffer="";
    return rest.trim()?[rest]:[];
  }
  reset():void{this.buffer="";}
  pendingText():string{return this.buffer;}
  private findBoundary():number{
    const source=this.buffer;
    for(let i=0;i<source.length;i++){
      const character=source[i]!;
      if(character==="\r"||character==="\n"){
        return character==="\r"&&source[i+1]==="\n"?i+2:i+1;
      }
      if(character!=="."&&character!=="!"&&character!=="?"&&character!=="…")continue;
      if(character==="."&&i>0&&i+1<source.length&&/\d/u.test(source[i-1]!)&&/\d/u.test(source[i+1]!))continue;
      if(character==="."&&/(?:^|[\s(\[{,;:])(?:т\.д|т\.е|г|др|ул|им|стр|м|см|кг|руб|гл|рис|с)\.$/iu.test(source.slice(0,i+1)))continue;
      let end=i+1;
      while(end<source.length&&".!?…".includes(source[end]!))end++;
      while(end<source.length&&isCloser(source[end]!))end++;
      if(end===source.length)continue;
      if(isWhite(source[end]!)){while(end<source.length&&isWhite(source[end]!))end++;return end;}
    }
    return -1;
  }
}

export interface NormalizedVoiceExpression {
  text:string;
  instruction?:string;
}
/** Maps only explicit supported actions; ordinary emotions are intentionally neutral on basic OmniVoice. */
export function normalizeVoiceExpression(text:string,emotion:string,capabilities:TtsProviderCapabilities):NormalizedVoiceExpression{
  const normalized=typeof emotion==="string"
    ?emotion.normalize("NFKC").trim().replace(/\s+/gu," ").toLocaleLowerCase("ru-RU"):"";
  let prepared=text;
  const tags=capabilities.nonverbalTags;
  const laughterEmotions=new Set(["laughter","laugh","laughing","laughs","смех","смеётся","смеется","смешок"]);
  const sighEmotions=new Set(["sigh","sighing","вздох","вздохнуть","вздыхает","вздыхание"]);
  const whisperEmotions=new Set(["whisper","whispering","шёпот","шепот","шепчет","шептать"]);
  if(tags.includes("laughter")&&laughterEmotions.has(normalized)&&!/(?:^|\s)\[laughter\](?:\s|$)/iu.test(text))
    prepared="[laughter] "+prepared;
  else if(tags.includes("sigh")&&sighEmotions.has(normalized)&&!/(?:^|\s)\[sigh\](?:\s|$)/iu.test(text))
    prepared="[sigh] "+prepared;
  if(capabilities.supportsInstruction&&whisperEmotions.has(normalized))return {text:prepared,instruction:"whisper"};
  return {text:prepared};
}

export class SpeechOutputController {
  private readonly sessions=new Map<string,Session>();
  private active:Session|undefined;
  private readonly pendingSessions:Session[]=[];
  private testAbort:AbortController|undefined;
  private sequence=0;
  private unlocked=false;
  private status:SpeechOutputStatus={state:"disabled",message:"Speech output is disabled."};
  private readonly listeners=new Set<(status:SpeechOutputStatus)=>void>();
  constructor(private readonly options:SpeechOutputControllerOptions){}

  getStatus():SpeechOutputStatus{return {...this.status};}
  subscribe(listener:(status:SpeechOutputStatus)=>void):()=>void{
    this.listeners.add(listener);listener(this.getStatus());
    return ()=>this.listeners.delete(listener);
  }
  async unlockPlayback():Promise<void>{
    await this.options.output.unlock();
    this.unlocked=true;
    this.setStatus({state:"ready",message:"Audio playback is enabled by the user."});
  }

  /** Handles only public NovaTurn speech lifecycle events. It never receives thoughts or raw JSON. */
  async handleSpeechEvent(event:Pick<MindTurnSpeechEvent,"type"|"turnId"|"text"|"emotion">):Promise<void>{
    let handlingSession:Session|undefined;
    try{
      if(event.type==="start"){
        // Cognitive tool rounds may emit multiple starts for the same turn. Keep one TTS session per turn.
        if(this.findSession(event.turnId))return;
        const settings=this.options.getSettings();
        if(!settings.enabled){
          if(!this.active)this.setStatus({state:"disabled",message:"Speech output is disabled."});
          return;
        }
        if(!this.unlocked){
          const message="Speech output was skipped because browser audio is locked. Enable audio playback from TTS settings before Nova can speak.";
          this.reportDiagnostic("TTS_AUDIO_LOCKED",message);
          if(!this.active)this.setStatus({state:"locked",message});
          return;
        }
        const preset=settings.presets.find(item=>item.id===settings.activePresetId);
        if(!preset){
          this.reportDiagnostic("TTS_PRESET_MISSING","The active TTS preset is missing.");
          if(!this.active)this.setStatus({state:"error",message:"The active TTS preset is missing."});
          return;
        }
        const provider=this.options.getProvider(preset.providerId);
        if(!provider){
          this.reportDiagnostic("TTS_PROVIDER_MISSING","The selected TTS provider is not registered.");
          if(!this.active)this.setStatus({state:"error",message:"The selected TTS provider is not registered."});
          return;
        }
        const session:Session={
          turnId:event.turnId,id:"nova-tts-"+(++this.sequence)+"-"+event.turnId.slice(0,80),
          preset:presetCopy(preset),provider,abort:new AbortController(),queue:[],waitingWriters:[],queueWaiters:[],queuedChars:0,
          segmenter:new SpeechSentenceSegmenter(),emotion:"",finishing:false,failed:false,outputSequence:0,
          nextSegmentSequence:0,hasAudio:false,playbackStarted:false,segmentStates:new Map<number,TtsSegmentStatus>(),
          startTimeoutMs:Math.max(1_000,Math.min(60_000,Math.floor(settings.startTimeoutMs??DEFAULT_START_TIMEOUT_MS))),
          segmentGapMs:Math.max(0,Math.min(5_000,Math.floor(settings.segmentGapMs??DEFAULT_SEGMENT_GAP_MS)))
        };
        this.sessions.set(session.id,session);
        if(this.active){
          this.pendingSessions.push(session);
          this.setStatus({state:"ready",message:"Assistant speech queued behind the active playback.",sessionId:session.id});
        }else{
          this.active=session;
          this.setStatus({state:"ready",message:"TTS session started.",sessionId:session.id});
        }
        return;
      }
      const session=this.findSession(event.turnId);
      if(!session)return;
      handlingSession=session;
      if(event.type==="emotion"){
        if(typeof event.emotion==="string")session.emotion=event.emotion.slice(0,500);
        return;
      }
      if(event.type==="reset"||event.type==="clear"){
        // Successful commit emits clear after finalization; never truncate the queued audio in that case.
        if(event.type==="clear"&&session.finishing)return;
        this.cancelSession(session,"Speech output was reset.");
        return;
      }
      if(event.type==="delta"){
        if(typeof event.text==="string"&&event.text.length>0)await this.appendText(session,event.text);
      }
    }catch(error){
      this.reportDiagnostic("TTS_STREAM_FAILED",safeError(error));
      if(error&&typeof error==="object"&&(error as {name?:unknown}).name==="AbortError")return;
      const session=handlingSession??this.active;
      if(session)this.cancelSession(session,safeError(error),true);
      this.setStatus({state:"error",message:safeError(error)});
    }
  }

  /** Finalizes synthesis and then waits for the physical playback queue to drain. */
  finishTurn(turnId:string):Promise<void>{
    const session=this.findSession(turnId);
    if(!session||session.failed)return Promise.resolve();
    if(session.finishPromise)return session.finishPromise;
    session.finishing=true;
    const timeoutMs=this.options.finishTimeoutMs!==undefined
      ?Math.max(1,Math.floor(this.options.finishTimeoutMs))
      :Math.max(10_000,Math.min(600_000,Math.floor(this.options.getSettings().finishTimeoutMs??DEFAULT_FINISH_TIMEOUT_MS)));
    const finishStartedAt=Date.now();
    const completion=(async()=>{
      for(const text of session.segmenter.finish())await this.enqueueSentence(session,text,session.emotion);
      this.ensureWorker(session);
      await this.waitForSynthesis(session);
      if(session.failed||aborted(session.abort.signal))return;
      if(session.segmentError&&session.hasAudio){
        // Release Nova Life immediately on a synthesis error, but keep already-queued audio active.
        void this.drainFailedSessionAfterPlayback(session,Math.max(1,timeoutMs-(Date.now()-finishStartedAt)));
        return;
      }
      if(session.outputSequence>0&&this.options.output.waitForPlayback)
        await this.options.output.waitForPlayback(session.id,session.abort.signal);
      if(session.failed||aborted(session.abort.signal))return;
      this.clearStartTimeout(session);
      for(const [sequence,state] of session.segmentStates)
        if(state!=="failed"&&state!=="cancelled")session.segmentStates.set(sequence,"completed");
      this.sessions.delete(session.id);
      const wasActive=this.active===session;
      this.pendingSessions.splice(0,this.pendingSessions.length,...this.pendingSessions.filter(item=>item!==session));
      if(wasActive){
        this.active=undefined;
        this.activateNextSession();
      }
      if(!this.active)this.setStatus({state:"ready",message:"Assistant speech playback completed.",sessionId:session.id});
    })();
    let timeout:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<void>((_resolve,reject)=>{
      timeout=setTimeout(()=>{
        const error=new Error("Speech synthesis or playback exceeded its "+timeoutMs+" ms completion deadline.");
        error.name="TimeoutError";
        reject(error);
      },timeoutMs);
    });
    session.finishPromise=Promise.race([completion,deadline]).catch(error=>{
      if(!aborted(session.abort.signal)){
        this.reportDiagnostic("TTS_FINISH_FAILED",safeError(error));
        this.cancelSession(session,safeError(error),true);
        this.setStatus({state:"error",message:safeError(error)});
      }
    }).finally(()=>{
      if(timeout!==undefined)clearTimeout(timeout);
      session.finishPromise=undefined;
    });
    return session.finishPromise;
  }

  /** Explicit interruption cancels the active turn and every not-yet-played queued turn. */
  stop(message="Speech output stopped."):void{
    for(const session of [...this.sessions.values()])this.cancelSession(session,message,false,false);
    this.active=undefined;
    this.pendingSessions.length=0;
    if(this.testAbort){const preview=this.testAbort;this.testAbort=undefined;preview.abort();}
    this.options.output.stop();
    this.setStatus({state:this.unlocked?"ready":"locked",message});
  }

  /** User-triggered connection preview; it remains separate from Nova's speech stream. */
  async testVoice(text="Проверка голосового вывода."):Promise<void>{
    const settings=this.options.getSettings(),preset=settings.presets.find(item=>item.id===settings.activePresetId);
    if(!preset)throw new Error("Select a TTS preset first.");
    if(!this.unlocked)throw new Error("Enable audio playback first.");
    const provider=this.options.getProvider(preset.providerId);
    if(!provider)throw new Error("The selected TTS provider is not registered.");
    this.stop("Starting TTS test voice.");
    const sessionId="nova-tts-test-"+(++this.sequence);
    const abort=new AbortController();
    this.testAbort=abort;
    let metadata:TtsAudioMetadata|undefined,sequence=0,done=false;
    this.setStatus({state:"synthesizing",message:"Synthesizing a test voice.",sessionId});
    try{
      const expression=normalizeVoiceExpression(text,"",provider.capabilities());
      for await(const event of provider.synthesize({sessionId,text:expression.text,preset:presetCopy(preset),emotion:"",...(expression.instruction?{instruction:expression.instruction}:{})},{signal:abort.signal})){
        if(event.sessionId!==sessionId)continue;
        if(event.type==="routing"){
          const message=safeRoutingMessage(event.status,event.reason);
          this.reportDiagnostic("TTS_ROUTING",message);
          this.setStatus({state:"synthesizing",message,sessionId});
        }else if(event.type==="start"){metadata=event.audio;this.options.output.startSession(sessionId,metadata);}
        else if(event.type==="audio"){
          if(!metadata)throw new Error("TTS provider sent audio before format metadata.");
          if(event.data.byteLength>MAX_AUDIO_EVENT_BYTES)throw new Error("TTS provider exceeded the audio chunk limit.");
          await this.options.output.enqueue(sessionId,sequence++,metadata,event.data,abort.signal);
        }else if(event.type==="done")done=true;
        else if(event.type==="error")throw new Error(event.error.message);
      }
      if(!done)throw new Error("TTS provider ended the test without a completion event.");
      this.setStatus({state:"ready",message:"Test voice was synthesized; playback is queued.",sessionId});
    }catch(error){
      this.options.output.stop(sessionId);
      if(abort.signal.aborted)return;
      const message=safeError(error);
      this.reportDiagnostic("TTS_TEST_FAILED",message);
      this.setStatus({state:"error",message});
      throw new Error(message);
    }finally{if(this.testAbort===abort)this.testAbort=undefined;}
  }

  async testConnection():Promise<{status:string;message:string}>{
    const settings=this.options.getSettings(),preset=settings.presets.find(item=>item.id===settings.activePresetId);
    if(!preset)return {status:"unavailable",message:"Select a TTS preset first."};
    const provider=this.options.getProvider(preset.providerId);
    if(!provider)return {status:"unavailable",message:"The selected TTS provider is not registered."};
    const signal=new AbortController().signal;
    try{
      const result=await provider.testConnection(presetCopy(preset),signal);
      const providerMessage=result.message??result.status;
      if(result.status!=="healthy"){
        this.setStatus({state:"error",message:providerMessage});
      }else if(!settings.enabled){
        this.setStatus({state:"disabled",message:"TTS provider connection succeeded, but speech output is disabled."});
      }else if(!this.unlocked){
        this.setStatus({state:"locked",message:"TTS provider is connected, but audio playback is locked. Enable audio playback from TTS settings before Nova can speak."});
      }else{
        this.setStatus({state:"ready",message:providerMessage});
      }
      return {status:result.status,message:providerMessage};
    }catch(error){
      const message=safeError(error);
      this.setStatus({state:"error",message});
      return {status:"unavailable",message};
    }
  }

  /** Called when the active preset or enabled state changes. */
  configurationChanged():void{
    const settings=this.options.getSettings();
    if(!settings.enabled){this.stop("Speech output is disabled.");return;}
    const session=this.active;
    if(session&&session.preset.id!==settings.activePresetId)this.stop("TTS preset changed; previous speech was stopped.");
  }

  private async appendText(session:Session,text:string):Promise<void>{
    if(this.sessions.get(session.id)!==session||session.abort.signal.aborted||session.failed||session.finishing||session.segmentError)return;
    for(const sentence of session.segmenter.push(text))await this.enqueueSentence(session,sentence,session.emotion);
  }
  private async enqueueSentence(session:Session,text:string,emotion:string):Promise<void>{
    if(!text.trim()||this.sessions.get(session.id)!==session||session.abort.signal.aborted||session.failed||session.segmentError)return;
    if(text.length>MAX_SENTENCE_CHARS*2)throw new Error("A TTS sentence exceeded the safe splitting limit.");
    while(!session.abort.signal.aborted&&!session.failed&&this.sessions.get(session.id)===session&&
      (session.queue.length>=MAX_PENDING_SENTENCES||session.queuedChars+text.length>MAX_PENDING_TEXT_CHARS)){
      await new Promise<void>(resolve=>session.waitingWriters.push(resolve));
    }
    if(session.abort.signal.aborted||session.failed||this.sessions.get(session.id)!==session)return;
    const sequence=session.nextSegmentSequence++;
    session.queue.push({text,emotion,sequence});session.queuedChars+=text.length;
    session.segmentStates.set(sequence,"queued");
    this.ensureWorker(session);
  }
  private ensureWorker(session:Session):void{
    if(this.active!==session||session.worker||session.failed||session.abort.signal.aborted)return;
    session.worker=this.runWorker(session).finally(()=>{
      session.worker=undefined;
      if(session.queue.length>0&&!session.failed&&!session.abort.signal.aborted)this.ensureWorker(session);
      this.wakeQueueWaiters(session);
      // Do not release the active session here: synthesized audio may still be playing.
    });
  }
  private async runWorker(session:Session):Promise<void>{
    while(this.active===session&&!session.failed&&!session.abort.signal.aborted&&session.queue.length){
      const task=session.queue.shift()!;
      session.queuedChars-=task.text.length;
      for(const resolve of session.waitingWriters.splice(0))resolve();
      session.segmentStates.set(task.sequence,"synthesizing");
      this.armStartTimeout(session);
      try{await this.synthesizeSentence(session,task);}
      catch(error){
        if(session.abort.signal.aborted||error&&typeof error==="object"&&(error as {name?:unknown}).name==="AbortError")return;
        const message=safeError(error);
        this.reportDiagnostic("TTS_SYNTHESIS_FAILED",message);
        session.segmentStates.set(task.sequence,"failed");
        this.options.output.markSegmentSynthesisComplete?.(session.id,task.sequence);
        // A failed later segment must not stop audio that has already entered playback.
        if(!(error instanceof TtsOutputError)&&session.hasAudio){
          session.segmentError=message;
          session.segmenter.reset();
          for(const queued of session.queue)session.segmentStates.set(queued.sequence,"cancelled");
          session.queue.length=0;session.queuedChars=0;
          for(const resolve of session.waitingWriters.splice(0))resolve();
          this.setStatus({state:"error",message,sessionId:session.id});
          return;
        }
        this.cancelSession(session,message,true);
        this.setStatus({state:"error",message,sessionId:session.id});
        return;
      }
    }
  }
  private async synthesizeSentence(session:Session,task:SentenceTask):Promise<void>{
    const capabilities=session.provider.capabilitiesForPreset?.(session.preset)??session.provider.capabilities();
    const expression=normalizeVoiceExpression(task.text,task.emotion,capabilities);
    const request:TtsSynthesisRequest={
      sessionId:session.id,text:expression.text,preset:session.preset,emotion:task.emotion,
      ...(expression.instruction?{instruction:expression.instruction}:{})
    };
    let metadata:TtsAudioMetadata|undefined,done=false,segmentAudioChunks=0;
    for await(const event of session.provider.synthesize(request,{signal:session.abort.signal})){
      if(session.abort.signal.aborted||this.active!==session||event.sessionId!==session.id)throw abortError();
      if(event.type==="routing"){
        const message=safeRoutingMessage(event.status,event.reason);
        this.reportDiagnostic("TTS_ROUTING",message);
        this.setStatus({state:"synthesizing",message,sessionId:session.id});
      }else if(event.type==="start"){
        metadata=event.audio;
        try{this.options.output.startSession(session.id,metadata);}catch(error){throw new TtsOutputError(error);}
        this.setStatus({state:"synthesizing",message:"Synthesizing public Nova speech.",sessionId:session.id});
      }else if(event.type==="audio"){
        if(!metadata)throw new Error("TTS provider sent audio before format metadata.");
        if(event.data.byteLength>MAX_AUDIO_EVENT_BYTES)throw new Error("TTS provider exceeded the audio chunk limit.");
        const playback={
          segmentSequence:task.sequence,
          gapBeforeMs:segmentAudioChunks===0&&session.hasAudio?session.segmentGapMs:0,
          onPlaybackStarted:()=>{
            session.playbackStarted=true;
            this.clearStartTimeout(session);
            if(session.segmentStates.get(task.sequence)!=="failed"&&!session.failed)
              session.segmentStates.set(task.sequence,"playing");
          }
        };
        try{
          await this.options.output.enqueue(session.id,session.outputSequence,metadata,event.data,session.abort.signal,playback);
        }catch(error){throw new TtsOutputError(error);}
        session.outputSequence++;
        segmentAudioChunks++;
        session.hasAudio=true;
        // Older adapters without segment-playback notifications treat accepted audio as started;
        // the production Web Audio adapter keeps the real start deadline armed until scheduling begins.
        if(!this.options.output.waitForSegmentPlayback){
          session.playbackStarted=true;
          this.clearStartTimeout(session);
        }
        if(session.segmentStates.get(task.sequence)==="synthesizing")session.segmentStates.set(task.sequence,"buffered");
      }else if(event.type==="done")done=true;
      else if(event.type==="error")throw new Error(event.error.message);
    }
    if(!done)throw new Error("TTS provider ended synthesis without a completion event.");
    if(segmentAudioChunks===0)throw new Error("TTS provider completed synthesis without returning audio.");
    this.options.output.markSegmentSynthesisComplete?.(session.id,task.sequence);
    if(this.options.output.waitForSegmentPlayback){
      void this.options.output.waitForSegmentPlayback(session.id,task.sequence,session.abort.signal).then(()=>{
        if(session.segmentStates.get(task.sequence)!=="failed"&&session.segmentStates.get(task.sequence)!=="cancelled")
          session.segmentStates.set(task.sequence,"completed");
      }).catch(()=>{
        if(!session.abort.signal.aborted)session.segmentStates.set(task.sequence,"failed");
      });
    }else session.segmentStates.set(task.sequence,"buffered");
    // The next sentence synthesizes while this segment is playing; turn completion waits for physical playback.
  }
  private async waitForSynthesis(session:Session):Promise<void>{
    while(!session.failed&&!aborted(session.abort.signal)&&(session.queue.length>0||session.worker)){
      if(this.active!==session){
        await new Promise<void>(resolve=>session.queueWaiters.push(resolve));
        continue;
      }
      if(session.worker){
        // Cancellation/first-audio timeout must release Life even if a provider ignores AbortSignal.
        await Promise.race([session.worker,new Promise<void>(resolve=>session.queueWaiters.push(resolve))]);
      }else{
        this.ensureWorker(session);
        if(!session.worker&&session.queue.length>0)
          await new Promise<void>(resolve=>session.queueWaiters.push(resolve));
      }
    }
  }
  private wakeQueueWaiters(session:Session):void{
    for(const resolve of session.queueWaiters.splice(0))resolve();
  }
  private async drainFailedSessionAfterPlayback(session:Session,timeoutMs:number):Promise<void>{
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      const playback=(async()=>{
        if(session.outputSequence>0&&this.options.output.waitForPlayback)
          await this.options.output.waitForPlayback(session.id,session.abort.signal);
      })();
      const deadline=new Promise<void>((_resolve,reject)=>{
        timeout=setTimeout(()=>{
          const error=new Error("Speech synthesis or playback exceeded its "+timeoutMs+" ms completion deadline.");
          error.name="TimeoutError";reject(error);
        },timeoutMs);
      });
      await Promise.race([playback,deadline]);
      if(session.failed||aborted(session.abort.signal))return;
      this.releaseSession(session);
      // Do not overwrite status for a later session already using the output.
      if(!this.active)this.setStatus({
        state:"error",
        message:"Speech playback drained, but a later segment failed: "+(session.segmentError??"TTS synthesis failed."),
        sessionId:session.id
      });
    }catch(error){
      if(aborted(session.abort.signal))return;
      const message=safeError(error);
      this.reportDiagnostic("TTS_FINISH_FAILED",message);
      this.cancelSession(session,message,true);
      this.setStatus({state:"error",message,sessionId:session.id});
    }finally{
      if(timeout!==undefined)clearTimeout(timeout);
    }
  }
  private releaseSession(session:Session):void{
    this.clearStartTimeout(session);
    this.sessions.delete(session.id);
    const wasActive=this.active===session;
    this.pendingSessions.splice(0,this.pendingSessions.length,...this.pendingSessions.filter(item=>item!==session));
    if(wasActive){
      this.active=undefined;
      this.activateNextSession();
    }
  }
  private armStartTimeout(session:Session):void{
    if(session.playbackStarted||session.startTimer!==undefined||session.failed)return;
    session.startTimer=setTimeout(()=>{
      session.startTimer=undefined;
      if(this.sessions.get(session.id)!==session||session.failed||session.abort.signal.aborted||session.playbackStarted)return;
      const message="TTS playback did not start within "+session.startTimeoutMs+" ms.";
      this.reportDiagnostic("TTS_START_TIMEOUT",message);
      this.cancelSession(session,message,true);
      this.setStatus({state:"error",message,sessionId:session.id});
    },session.startTimeoutMs);
  }
  private clearStartTimeout(session:Session):void{
    if(session.startTimer!==undefined)clearTimeout(session.startTimer);
    session.startTimer=undefined;
  }
  private cancelSession(session:Session,message:string,failed=false,advanceQueue=true):void{
    const wasActive=this.active===session;
    session.failed=failed;
    this.clearStartTimeout(session);
    if(!session.abort.signal.aborted)session.abort.abort();
    for(const [sequence,state] of session.segmentStates)
      if(state!=="completed"&&state!=="failed")session.segmentStates.set(sequence,"cancelled");
    session.segmenter.reset();
    session.queue.length=0;session.queuedChars=0;session.finishing=true;
    for(const resolve of session.waitingWriters.splice(0))resolve();
    this.wakeQueueWaiters(session);
    this.sessions.delete(session.id);
    this.pendingSessions.splice(0,this.pendingSessions.length,...this.pendingSessions.filter(item=>item!==session));
    this.options.output.stop(session.id);
    if(wasActive)this.active=undefined;
    if(advanceQueue&&wasActive)this.activateNextSession();
    if(!failed)this.setStatus({state:this.unlocked?"ready":"locked",message});
  }
  private findSession(turnId:string):Session|undefined{
    for(const session of this.sessions.values())if(session.turnId===turnId)return session;
    return undefined;
  }
  private activateNextSession():void{
    if(this.active)return;
    while(this.pendingSessions.length){
      const next=this.pendingSessions.shift()!;
      if(this.sessions.get(next.id)!==next||next.failed||next.abort.signal.aborted)continue;
      this.active=next;
      this.wakeQueueWaiters(next);
      this.ensureWorker(next);
      this.setStatus({state:"ready",message:"Next assistant speech session is active.",sessionId:next.id});
      return;
    }
  }
  private reportDiagnostic(code:string,message:string):void{try{this.options.onDiagnostic?.(code,message);}catch{}}

  private setStatus(status:SpeechOutputStatus):void{
    this.status=status;
    for(const listener of this.listeners)listener(this.getStatus());
  }
}
