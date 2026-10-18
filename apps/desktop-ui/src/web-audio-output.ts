import type {AudioOutputAdapter} from "../../../modules/voice/tts/src";
import type {TtsAudioMetadata} from "../../../contracts/src/tts";

interface AudioChunk {
  sessionId:string;
  sequence:number;
  metadata:TtsAudioMetadata;
  data:Uint8Array;
}
interface Waiter {resolve:()=>void;reject?:(error:Error)=>void;}
export interface WebAudioOutputOptions {
  createContext?:()=>AudioContext;
  maxQueuedBytes?:number;
  maxQueuedChunks?:number;
  maxScheduleAheadSeconds?:number;
  onError?:(error:Error)=>void;
}
function makeAbortError():Error{const error=new Error("Audio playback was cancelled.");error.name="AbortError";return error;}

/** One shared AudioContext with bounded PCM buffering and FIFO WebAudio scheduling. */
export class WebAudioOutputAdapter implements AudioOutputAdapter {
  private context:AudioContext|undefined;
  private unlocked=false;
  private sessionId:string|undefined;
  private queue:AudioChunk[]=[];
  private queuedBytes=0;
  private sequence=0;
  private nextStartTime=0;
  private pumping=false;
  private sources=new Set<AudioBufferSourceNode>();
  private readonly capacityWaiters:Waiter[]=[];
  private readonly playbackWaiters:Waiter[]=[];
  private outputFailure:Error|undefined;
  private readonly maxQueuedBytes:number;
  private readonly maxQueuedChunks:number;
  private readonly maxScheduleAheadSeconds:number;
  constructor(private readonly options:WebAudioOutputOptions={}){
    this.maxQueuedBytes=options.maxQueuedBytes??4*1024*1024;
    this.maxQueuedChunks=options.maxQueuedChunks??128;
    this.maxScheduleAheadSeconds=options.maxScheduleAheadSeconds??6;
  }

  async unlock():Promise<void>{
    if(!this.context){
      const create=this.options.createContext??(()=>new AudioContext());
      this.context=create();
    }
    await this.context.resume();
    if(this.context.state!=="running")throw new Error("Browser audio playback did not enter the running state.");
    this.unlocked=true;
    this.outputFailure=undefined;
  }

  startSession(sessionId:string,_metadata:TtsAudioMetadata):void{
    if(!this.unlocked)throw new Error("Enable audio playback explicitly from TTS settings first.");
    if(this.sessionId===sessionId)return;
    this.stop();
    this.outputFailure=undefined;
    this.sessionId=sessionId;
    this.sequence=0;
    this.nextStartTime=0;
  }

  async enqueue(sessionId:string,_sequence:number,metadata:TtsAudioMetadata,data:Uint8Array,signal:AbortSignal):Promise<void>{
    if(!this.unlocked||!this.context)throw new Error("Enable audio playback explicitly from TTS settings first.");
    if(this.sessionId!==sessionId)throw makeAbortError();
    if(metadata.format!=="pcm16le"||!Number.isInteger(metadata.sampleRate)||metadata.sampleRate<8_000||metadata.sampleRate>192_000||
       !Number.isInteger(metadata.channels)||metadata.channels<1||metadata.channels>2)
      throw new Error("Unsupported PCM audio metadata.");
    const frameBytes=metadata.channels*2;
    if(data.byteLength===0||data.byteLength%frameBytes!==0||data.byteLength>512*1024)
      throw new Error("PCM audio chunk is empty, oversized, or not frame-aligned.");
    if(data.byteLength>this.maxQueuedBytes)throw new Error("PCM audio chunk exceeds the bounded playback buffer.");
    while(!signal.aborted&&this.sessionId===sessionId&&
      (this.queue.length>=this.maxQueuedChunks||this.queuedBytes+data.byteLength>this.maxQueuedBytes)){
      await new Promise<void>((resolve,reject)=>{
        const onAbort=()=>{signal.removeEventListener("abort",onAbort);reject(makeAbortError());};
        signal.addEventListener("abort",onAbort,{once:true});
        this.capacityWaiters.push({resolve:()=>{signal.removeEventListener("abort",onAbort);resolve();}});
      });
      if(this.outputFailure)throw this.outputFailure;
    }
    if(signal.aborted||this.sessionId!==sessionId)throw makeAbortError();
    if(this.outputFailure)throw this.outputFailure;
    const copy=data.slice();
    this.queue.push({sessionId,sequence:this.sequence++,metadata,data:copy});
    this.queuedBytes+=copy.byteLength;
    void this.pump();
  }

  /** Waits for every queued PCM chunk and scheduled source in this session to finish playing. */
  async waitForPlayback(sessionId:string,signal:AbortSignal):Promise<void>{
    while(true){
      if(signal.aborted||this.sessionId!==sessionId)throw makeAbortError();
      if(this.outputFailure)throw this.outputFailure;
      if(this.queue.length===0&&this.sources.size===0&&!this.pumping)return;
      await new Promise<void>((resolve,reject)=>{
        const onAbort=()=>{signal.removeEventListener("abort",onAbort);reject(makeAbortError());};
        signal.addEventListener("abort",onAbort,{once:true});
        this.playbackWaiters.push({resolve:()=>{signal.removeEventListener("abort",onAbort);resolve();},reject});
      });
    }
  }

  stop(sessionId?:string):void{
    if(sessionId&&this.sessionId!==sessionId)return;
    this.queue=[];
    this.queuedBytes=0;
    this.sessionId=undefined;
    this.nextStartTime=0;
    for(const source of this.sources){
      try{source.stop();}catch{}
      try{source.disconnect();}catch{}
    }
    this.sources.clear();
    this.wake(this.capacityWaiters);
    this.wake(this.playbackWaiters);
  }

  async dispose():Promise<void>{
    this.stop();
    if(this.context&&this.context.state!=="closed")await this.context.close();
    this.context=undefined;
    this.unlocked=false;
  }

  private async pump():Promise<void>{
    if(this.pumping||!this.context||!this.unlocked)return;
    this.pumping=true;
    try{
      while(this.queue.length){
        const chunk=this.queue[0]!;
        if(this.sessionId!==chunk.sessionId){this.queue.shift();this.queuedBytes-=chunk.data.byteLength;this.wake(this.capacityWaiters);continue;}
        const ahead=this.nextStartTime-this.context.currentTime;
        if(this.nextStartTime>0&&ahead>this.maxScheduleAheadSeconds){
          await new Promise<void>(resolve=>this.playbackWaiters.push({resolve}));
          continue;
        }
        this.queue.shift();
        this.queuedBytes-=chunk.data.byteLength;
        this.wake(this.capacityWaiters);
        const frameBytes=chunk.metadata.channels*2;
        const frames=chunk.data.byteLength/frameBytes;
        const buffer=this.context.createBuffer(chunk.metadata.channels,frames,chunk.metadata.sampleRate);
        const view=new DataView(chunk.data.buffer,chunk.data.byteOffset,chunk.data.byteLength);
        for(let frame=0;frame<frames;frame++){
          for(let channel=0;channel<chunk.metadata.channels;channel++){
            const sample=view.getInt16((frame*chunk.metadata.channels+channel)*2,true);
            buffer.getChannelData(channel)[frame]=sample<0?sample/32768:sample/32767;
          }
        }
        const source=this.context.createBufferSource();
        source.buffer=buffer;
        source.connect(this.context.destination);
        const when=Math.max(this.context.currentTime+0.025,this.nextStartTime||0);
        this.nextStartTime=when+frames/chunk.metadata.sampleRate;
        this.sources.add(source);
        source.onended=()=>{
          this.sources.delete(source);
          try{source.disconnect();}catch{}
          this.wake(this.playbackWaiters);
          if(this.queue.length)void this.pump();
        };
        source.start(when);
      }
    }catch(error){
      this.outputFailure=error instanceof Error?error:new Error("Web Audio playback failed.");
      this.queue=[];this.queuedBytes=0;
      this.wake(this.capacityWaiters,this.outputFailure);
      this.wake(this.playbackWaiters,this.outputFailure);
      try{this.options.onError?.(this.outputFailure);}catch{}
    }finally{
      this.pumping=false;
      if(this.queue.length&&this.sessionId)void this.pump();
    }
  }
  private wake(waiters:Waiter[],error?:Error):void{
    for(const waiter of waiters.splice(0)){
      if(error&&waiter.reject)waiter.reject(error);else waiter.resolve();
    }
  }
}
