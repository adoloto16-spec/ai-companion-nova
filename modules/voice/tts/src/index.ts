import type {MindTurnSpeechEvent} from "../../../../contracts/src/mind-runtime";
import type {
  TtsAudioMetadata,TtsPreset,TtsProvider,TtsProviderCapabilities,TtsSettings,TtsStreamEvent,TtsSynthesisRequest
} from "../../../../contracts/src/tts";

export interface AudioOutputAdapter {
  unlock():Promise<void>;
  startSession(sessionId:string,metadata:TtsAudioMetadata):void;
  enqueue(sessionId:string,sequence:number,metadata:TtsAudioMetadata,data:Uint8Array,signal:AbortSignal):Promise<void>;
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
}
interface SentenceTask {text:string;emotion:string;}
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
}
const MAX_PENDING_SENTENCES=12;
const MAX_PENDING_TEXT_CHARS=8_000;
const MAX_SENTENCE_CHARS=1_200;
const MAX_AUDIO_EVENT_BYTES=512*1024;

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
      if(isWhite(source[end]!))return end;
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
  const normalized=typeof emotion==="string"?emotion.normalize("NFKC").toLocaleLowerCase("ru-RU"):"";
  let prepared=text;
  const tags=capabilities.nonverbalTags;
  if(tags.includes("laughter")&&/(?:\blaughter\b|\blaughing\b|\blaugh\b|смех|сме[её]т|сме[её]х)/iu.test(normalized)&&!/(?:^|\s)\[laughter\](?:\s|$)/iu.test(text))
    prepared="[laughter] "+prepared;
  else if(tags.includes("sigh")&&/(?:\bsigh\b|\bsighing\b|вздох|вздых)/iu.test(normalized)&&!/(?:^|\s)\[sigh\](?:\s|$)/iu.test(text))
    prepared="[sigh] "+prepared;
  if(capabilities.supportsInstruction&&/(?:\bwhisper(?:ing)?\b|ш[её]пот|ш[её]пч)/iu.test(normalized))return {text:prepared,instruction:"whisper"};
  return {text:prepared};
}

export class SpeechOutputController {
  private readonly sessions=new Map<string,Session>();
  private active:Session|undefined;
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
    try{
      if(event.type==="start"){
        this.stop();
        const settings=this.options.getSettings();
        if(!settings.enabled){
          this.setStatus({state:"disabled",message:"Speech output is disabled."});
          this.active=undefined;
          return;
        }
        if(!this.unlocked){
          this.setStatus({state:"locked",message:"Enable audio playback from TTS settings before speech can play."});
          this.active=undefined;
          return;
        }
        const preset=settings.presets.find(item=>item.id===settings.activePresetId);
        if(!preset){
          this.setStatus({state:"error",message:"The active TTS preset is missing."});
          this.active=undefined;
          return;
        }
        const provider=this.options.getProvider(preset.providerId);
        if(!provider){
          this.setStatus({state:"error",message:"The selected TTS provider is not registered."});
          this.active=undefined;
          return;
        }
        const session:Session={
          turnId:event.turnId,id:"nova-tts-"+(++this.sequence)+"-"+event.turnId.slice(0,80),
          preset:presetCopy(preset),provider,abort:new AbortController(),queue:[],waitingWriters:[],queueWaiters:[],queuedChars:0,
          segmenter:new SpeechSentenceSegmenter(),emotion:"",finishing:false,failed:false,outputSequence:0
        };
        this.active=session;this.sessions.set(session.id,session);
        this.setStatus({state:"ready",message:"TTS session started.",sessionId:session.id});
        return;
      }
      const session=this.active;
      if(!session||event.turnId!==session.turnId)return;
      if(event.type==="emotion"){
        if(typeof event.emotion==="string")session.emotion=event.emotion.slice(0,500);
        return;
      }
      if(event.type==="reset"||event.type==="clear"){
        this.cancelSession(session,"Speech output was reset.");
        return;
      }
      if(event.type==="delta"){
        if(typeof event.text==="string"&&event.text.length>0)await this.appendText(session,event.text);
      }
    }catch(error){
      // TTS is isolated from Chat/Nova Life: report an output diagnostic, never propagate failure to the turn sink.
      this.options.onDiagnostic?.("TTS_STREAM_FAILED",safeError(error));
      if(error&&typeof error==="object"&&(error as {name?:unknown}).name==="AbortError")return;
      if(this.active)this.cancelSession(this.active,safeError(error),true);
      this.setStatus({state:"error",message:safeError(error)});
    }
  }

  /** Flushes the final unterminated public-speech segment without waiting for playback completion. */
  finishTurn(turnId:string):Promise<void>{
    const session=this.active;
    if(!session||session.turnId!==turnId||session.failed)return Promise.resolve();
    session.finishing=true;
    return (async()=>{
      for(const text of session.segmenter.finish())await this.enqueueSentence(session,text,session.emotion);
      this.ensureWorker(session);
      await this.waitForSynthesis(session);
    })().catch(error=>{
      if(!aborted(session.abort.signal)){
        this.options.onDiagnostic?.("TTS_FINISH_FAILED",safeError(error));
        this.cancelSession(session,safeError(error),true);
        this.setStatus({state:"error",message:safeError(error)});
      }
    });
  }

  /** Stops synthesis and all scheduled/queued audio immediately. */
  stop(message="Speech output stopped."):void{
    const session=this.active;
    if(session)this.cancelSession(session,message);
    else this.options.output.stop();
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
    let metadata:TtsAudioMetadata|undefined,sequence=0,done=false;
    this.setStatus({state:"synthesizing",message:"Synthesizing a test voice.",sessionId});
    try{
      const expression=normalizeVoiceExpression(text,"",provider.capabilities());
      for await(const event of provider.synthesize({sessionId,text:expression.text,preset:presetCopy(preset),emotion:"",...(expression.instruction?{instruction:expression.instruction}:{})},{signal:abort.signal})){
        if(event.sessionId!==sessionId)continue;
        if(event.type==="start"){metadata=event.audio;this.options.output.startSession(sessionId,metadata);}
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
      const message=safeError(error);
      this.options.onDiagnostic?.("TTS_TEST_FAILED",message);
      this.setStatus({state:"error",message});
      throw new Error(message);
    }
  }

  async testConnection():Promise<{status:string;message:string}>{
    const settings=this.options.getSettings(),preset=settings.presets.find(item=>item.id===settings.activePresetId);
    if(!preset)return {status:"unavailable",message:"Select a TTS preset first."};
    const provider=this.options.getProvider(preset.providerId);
    if(!provider)return {status:"unavailable",message:"The selected TTS provider is not registered."};
    const signal=new AbortController().signal;
    try{
      const result=await provider.testConnection(presetCopy(preset),signal);
      this.setStatus({state:result.status==="healthy"?"ready":"error",message:result.message??result.status});
      return result;
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
    if(this.active!==session||session.abort.signal.aborted||session.failed||session.finishing)return;
    for(const sentence of session.segmenter.push(text))await this.enqueueSentence(session,sentence,session.emotion);
  }
  private async enqueueSentence(session:Session,text:string,emotion:string):Promise<void>{
    if(!text.trim()||this.active!==session||session.abort.signal.aborted||session.failed)return;
    if(text.length>MAX_SENTENCE_CHARS*2)throw new Error("A TTS sentence exceeded the safe splitting limit.");
    while(!session.abort.signal.aborted&&!session.failed&&
      (session.queue.length>=MAX_PENDING_SENTENCES||session.queuedChars+text.length>MAX_PENDING_TEXT_CHARS)){
      await new Promise<void>(resolve=>session.waitingWriters.push(resolve));
    }
    if(session.abort.signal.aborted||session.failed||this.active!==session)return;
    session.queue.push({text,emotion});session.queuedChars+=text.length;
    this.ensureWorker(session);
  }
  private ensureWorker(session:Session):void{
    if(session.worker||session.failed||session.abort.signal.aborted)return;
    session.worker=this.runWorker(session).finally(()=>{
      session.worker=undefined;
      if(session.queue.length>0&&!session.failed&&!session.abort.signal.aborted)this.ensureWorker(session);
      this.wakeQueueWaiters(session);
      if(session.finishing&&session.queue.length===0&&!session.failed){
        if(this.active===session)this.active=undefined;
        this.setStatus({state:"ready",message:"Speech synthesis completed; audio may still be playing.",sessionId:session.id});
      }
    });
  }
  private async runWorker(session:Session):Promise<void>{
    while(this.active===session&&!session.failed&&!session.abort.signal.aborted&&session.queue.length){
      const task=session.queue.shift()!;
      session.queuedChars-=task.text.length;
      for(const resolve of session.waitingWriters.splice(0))resolve();
      try{await this.synthesizeSentence(session,task);}
      catch(error){
        if(session.abort.signal.aborted||error&&typeof error==="object"&&(error as {name?:unknown}).name==="AbortError")return;
        const message=safeError(error);
        this.options.onDiagnostic?.("TTS_SYNTHESIS_FAILED",message);
        this.cancelSession(session,message,true);
        this.setStatus({state:"error",message});
        return;
      }
    }
  }
  private async synthesizeSentence(session:Session,task:SentenceTask):Promise<void>{
    const expression=normalizeVoiceExpression(task.text,task.emotion,session.provider.capabilities());
    const request:TtsSynthesisRequest={
      sessionId:session.id,text:expression.text,preset:session.preset,emotion:task.emotion,
      ...(expression.instruction?{instruction:expression.instruction}:{})
    };
    let metadata:TtsAudioMetadata|undefined,done=false;
    for await(const event of session.provider.synthesize(request,{signal:session.abort.signal})){
      if(session.abort.signal.aborted||this.active!==session||event.sessionId!==session.id)throw abortError();
      if(event.type==="start"){
        metadata=event.audio;
        this.options.output.startSession(session.id,metadata);
        this.setStatus({state:"synthesizing",message:"Synthesizing public Nova speech.",sessionId:session.id});
      }else if(event.type==="audio"){
        if(!metadata)throw new Error("TTS provider sent audio before format metadata.");
        if(event.data.byteLength>MAX_AUDIO_EVENT_BYTES)throw new Error("TTS provider exceeded the audio chunk limit.");
        await this.options.output.enqueue(session.id,session.outputSequence++,metadata,event.data,session.abort.signal);
      }else if(event.type==="done")done=true;
      else if(event.type==="error")throw new Error(event.error.message);
    }
    if(!done)throw new Error("TTS provider ended synthesis without a completion event.");
    // The next queued sentence is dispatched as soon as provider synthesis completes. Playback is independent.
  }
  private async waitForSynthesis(session:Session):Promise<void>{
    while(!session.failed&&!session.abort.signal.aborted&&(session.queue.length>0||session.worker)){
      if(session.worker)await session.worker;
      else this.ensureWorker(session);
    }
  }
  private wakeQueueWaiters(session:Session):void{
    for(const resolve of session.queueWaiters.splice(0))resolve();
  }
  private cancelSession(session:Session,message:string,failed=false):void{
    if(session.abort.signal.aborted)return;
    session.failed=failed;
    session.abort.abort();
    session.segmenter.reset();
    session.queue.length=0;session.queuedChars=0;session.finishing=true;
    for(const resolve of session.waitingWriters.splice(0))resolve();
    this.wakeQueueWaiters(session);
    this.sessions.delete(session.id);
    this.options.output.stop(session.id);
    if(this.active===session)this.active=undefined;
    if(!failed)this.setStatus({state:this.unlocked?"ready":"locked",message});
  }
  private setStatus(status:SpeechOutputStatus):void{
    this.status=status;
    for(const listener of this.listeners)listener(this.getStatus());
  }
}
