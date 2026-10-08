import type {MindRuntimeLifecycleState,MindState,Thought,Unsubscribe} from "../../contracts/src";

const DEFAULT_STEP_INTERVAL_MS=1000;
const DEFAULT_RECENT_THOUGHTS=50;

export interface CognitiveStepContext{characterId:string;state:Readonly<MindState>;signal:AbortSignal;}
export interface CognitiveStep{run(context:CognitiveStepContext):Promise<Thought>;}
export interface MindRuntimeOptions{cognitiveStep:CognitiveStep;stepIntervalMs?:number;recentThoughtLimit?:number;initialFocus?:string|null;onError?:(error:unknown)=>void;}

interface CharacterMindState{
  focus:string|null;
  lastThought:Thought|null;
  lastThoughtAt:string|null;
  recentThoughts:Thought[];
}

function abortError():Error{const error=new Error("Mind Runtime cognitive step aborted.");error.name="AbortError";return error;}
function isAbortError(error:unknown):boolean{return error instanceof Error&&error.name==="AbortError";}
function wait(ms:number,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{signal.removeEventListener("abort",onAbort);resolve();},ms);
    const onAbort=()=>{clearTimeout(timer);signal.removeEventListener("abort",onAbort);resolve();};
    signal.addEventListener("abort",onAbort,{once:true});
  });
}
function cloneState(state:MindState):MindState{
  return {
    focus:state.focus,
    lastThought:state.lastThought,
    lastThoughtAt:state.lastThoughtAt,
    recentThoughts:[...state.recentThoughts],
    lifecycleState:state.lifecycleState
  };
}
function createCharacterMindState(focus:string|null=null):CharacterMindState{
  return {focus,lastThought:null,lastThoughtAt:null,recentThoughts:[]};
}
export class MindRuntime{
  private readonly cognitiveStep:CognitiveStep;
  private readonly stepIntervalMs:number;
  private readonly recentThoughtLimit:number;
  private readonly onError?:MindRuntimeOptions["onError"];
  private readonly state:MindState;
  private readonly initialFocus:string|null;
  private readonly characterStates=new Map<string,CharacterMindState>();
  private readonly listeners=new Set<(state:MindState)=>void>();
  private readonly thoughtListeners=new Set<(thought:Thought)=>void>();
  private activeCharacterId:string|undefined;
  private controller:AbortController|undefined;
  private runPromise:Promise<void>|undefined;

  constructor(options:MindRuntimeOptions){
    if(options.stepIntervalMs!==undefined&&!Number.isInteger(options.stepIntervalMs))throw new Error("Mind Runtime step interval must be an integer.");
    if((options.stepIntervalMs??DEFAULT_STEP_INTERVAL_MS)<1)throw new Error("Mind Runtime step interval must be at least 1ms.");
    if(options.recentThoughtLimit!==undefined&&!Number.isInteger(options.recentThoughtLimit))throw new Error("Mind Runtime recent thought limit must be an integer.");
    if((options.recentThoughtLimit??DEFAULT_RECENT_THOUGHTS)<1)throw new Error("Mind Runtime recent thought limit must be at least 1.");
    this.cognitiveStep=options.cognitiveStep;
    this.stepIntervalMs=options.stepIntervalMs??DEFAULT_STEP_INTERVAL_MS;
    this.recentThoughtLimit=options.recentThoughtLimit??DEFAULT_RECENT_THOUGHTS;
    this.onError=options.onError;
    this.initialFocus=options.initialFocus??null;
    this.state={focus:this.initialFocus,lastThought:null,lastThoughtAt:null,recentThoughts:[],lifecycleState:"off"};
  }

  getState():MindState{return cloneState(this.state);}

  subscribe(listener:(state:MindState)=>void):Unsubscribe{
    this.listeners.add(listener);
    return ()=>{this.listeners.delete(listener)};
  }

  subscribeThoughts(listener:(thought:Thought)=>void):Unsubscribe{
    this.thoughtListeners.add(listener);
    return ()=>{this.thoughtListeners.delete(listener)};
  }

  setActiveCharacter(characterId:string):void{
    const normalized=characterId.trim();
    if(!normalized)throw new Error("Mind Runtime active character id must not be empty.");
    this.activeCharacterId=normalized;
    if(!this.characterStates.has(normalized)){
      this.characterStates.set(normalized,createCharacterMindState(this.characterStates.size===0?this.initialFocus:null));
    }
    this.syncActiveState();
    this.notify();
  }

  async start():Promise<void>{
    if(this.state.lifecycleState!=="off")throw new Error("Mind Runtime cannot start from state "+this.state.lifecycleState+".");
    if(!this.activeCharacterId)throw new Error("Mind Runtime cannot start without an active character.");
    const controller=new AbortController();
    this.controller=controller;
    this.setLifecycleState("starting");
    this.runPromise=this.runLoop(controller);
  }

  async stop():Promise<void>{
    if(this.state.lifecycleState==="off")return;
    const controller=this.controller;
    const runPromise=this.runPromise;
    this.setLifecycleState("stopping");
    controller?.abort();
    if(runPromise)await runPromise;
    this.controller=undefined;
    this.runPromise=undefined;
    this.setLifecycleState("off");
  }

  deleteThought(thoughtId:string):boolean{
    const id=thoughtId.trim();
    if(!id||!this.activeCharacterId)return false;
    const characterState=this.characterStates.get(this.activeCharacterId);
    if(!characterState)return false;
    const index=characterState.recentThoughts.findIndex(thought=>thought.id===id);
    if(index<0)return false;
    characterState.recentThoughts.splice(index,1);
    if(characterState.lastThought?.id===id){
      const next=characterState.recentThoughts[characterState.recentThoughts.length-1]??null;
      characterState.lastThought=next;
      characterState.lastThoughtAt=next?.timestamp??null;
    }
    this.syncActiveState();
    this.notify();
    return true;
  }

  clearCurrentThoughts():void{
    if(!this.activeCharacterId)return;
    const characterState=this.characterStates.get(this.activeCharacterId);
    if(!characterState)return;
    characterState.lastThought=null;
    characterState.lastThoughtAt=null;
    characterState.recentThoughts=[];
    this.syncActiveState();
    this.notify();
  }

  clearAllThoughts():void{
    for(const characterState of this.characterStates.values()){
      characterState.lastThought=null;
      characterState.lastThoughtAt=null;
      characterState.recentThoughts=[];
    }
    this.syncActiveState();
    this.notify();
  }

  private async runLoop(controller:AbortController):Promise<void>{
    const signal=controller.signal;
    while(!signal.aborted){
      this.setLifecycleState("thinking");
      const characterId=this.activeCharacterId;
      if(!characterId){
        const error=new Error("Mind Runtime has no active character.");
        this.setLifecycleState("error");
        try{this.onError?.(error)}catch{/* diagnostics must not stop life */}
        await wait(this.stepIntervalMs,signal);
        continue;
      }
      try{
        const thought=await this.cognitiveStep.run({characterId,state:this.getState(),signal});
        if(signal.aborted)break;
        if(thought.characterId!==characterId)throw new Error("Cognitive Thought character scope mismatch.");
        this.applyThought(thought);
      }catch(error){
        if(signal.aborted||isAbortError(error))break;
        this.setLifecycleState("error");
        try{this.onError?.(error)}catch{/* diagnostics must not stop life */}
        await wait(this.stepIntervalMs,signal);
        continue;
      }
      if(signal.aborted)break;
      await wait(this.stepIntervalMs,signal);
    }
    this.setLifecycleState("off");
  }

  private setLifecycleState(lifecycleState:MindRuntimeLifecycleState):void{
    this.state.lifecycleState=lifecycleState;
    this.notify();
  }

  private applyThought(thought:Thought):void{
    const characterState=this.characterStates.get(thought.characterId)??createCharacterMindState();
    characterState.lastThought=thought;
    characterState.lastThoughtAt=thought.timestamp;
    characterState.recentThoughts=[...characterState.recentThoughts,thought].slice(-this.recentThoughtLimit);
    this.characterStates.set(thought.characterId,characterState);
    if(thought.characterId===this.activeCharacterId)this.syncActiveState();
    for(const listener of [...this.thoughtListeners]){try{listener(thought)}catch{/* UI observers cannot affect runtime */}}
    this.notify();
  }

  private syncActiveState():void{
    if(!this.activeCharacterId)return;
    const characterState=this.characterStates.get(this.activeCharacterId)??createCharacterMindState();
    this.characterStates.set(this.activeCharacterId,characterState);
    this.state.focus=characterState.focus;
    this.state.lastThought=characterState.lastThought;
    this.state.lastThoughtAt=characterState.lastThoughtAt;
    this.state.recentThoughts=[...characterState.recentThoughts];
  }


  private notify():void{
    const snapshot=this.getState();
    for(const listener of [...this.listeners]){try{listener(snapshot)}catch{/* UI observers cannot affect runtime */}}
  }

  static createAbortError():Error{return abortError();}
}

export class DeterministicCognitiveStep implements CognitiveStep{
  private sequence=0;
  constructor(private readonly clock:()=>string=()=>new Date().toISOString()){}
  async run(context:CognitiveStepContext):Promise<Thought>{
    if(context.signal.aborted)throw MindRuntime.createAbortError();
    this.sequence+=1;
    const previous=context.state.lastThought;
    return {
      characterId:context.characterId,
      id:"thought:deterministic:"+this.sequence,
      timestamp:this.clock(),
      content:previous?"Internal continuation after "+previous.id:"Initial internal thought",
      expression:"internal"
    };
  }
}
export type {MindRuntimeLifecycleState};
