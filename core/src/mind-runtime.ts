import type {MindRuntimeLifecycleState,MindState,Thought} from "../../contracts/src";

const DEFAULT_STEP_INTERVAL_MS=25;
const DEFAULT_RECENT_THOUGHTS=5;

export interface CognitiveStepContext{
  state:Readonly<MindState>;
  signal:AbortSignal;
}

export interface CognitiveStep{
  run(context:CognitiveStepContext):Promise<Thought>;
}

export interface MindRuntimeOptions{
  cognitiveStep:CognitiveStep;
  stepIntervalMs?:number;
  recentThoughtLimit?:number;
  initialFocus?:string|null;
}

function abortError():Error{
  const error=new Error("Mind Runtime cognitive step aborted.");
  error.name="AbortError";
  return error;
}

function isAbortError(error:unknown):boolean{
  return error instanceof Error&&error.name==="AbortError";
}

function wait(ms:number,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      signal.removeEventListener("abort",onAbort);
      resolve();
    },ms);
    const onAbort=()=>{
      clearTimeout(timer);
      signal.removeEventListener("abort",onAbort);
      resolve();
    };
    signal.addEventListener("abort",onAbort,{once:true});
  });
}

export class MindRuntime{
  private readonly cognitiveStep:CognitiveStep;
  private readonly stepIntervalMs:number;
  private readonly recentThoughtLimit:number;
  private readonly state:MindState;
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
    this.state={
      focus:options.initialFocus??null,
      lastThought:null,
      lastThoughtAt:null,
      recentThoughts:[],
      lifecycleState:"off"
    };
  }

  getState():MindState{
    return {
      focus:this.state.focus,
      lastThought:this.state.lastThought,
      lastThoughtAt:this.state.lastThoughtAt,
      recentThoughts:[...this.state.recentThoughts],
      lifecycleState:this.state.lifecycleState
    };
  }

  async start():Promise<void>{
    if(this.state.lifecycleState!=="off")throw new Error(`Mind Runtime cannot start from state ${this.state.lifecycleState}.`);
    const controller=new AbortController();
    this.controller=controller;
    this.state.lifecycleState="starting";
    this.runPromise=this.runLoop(controller);
  }

  async stop():Promise<void>{
    if(this.state.lifecycleState==="off"){
      return;
    }

    const controller=this.controller;
    const runPromise=this.runPromise;

    this.state.lifecycleState="stopping";
    controller?.abort();

    if(runPromise){
      await runPromise;
    }else{
      this.state.lifecycleState="off";
    }

    this.controller=undefined;
    this.runPromise=undefined;
    this.state.lifecycleState="off";
  }

  private async runLoop(controller:AbortController):Promise<void>{
    const signal=controller.signal;

    while(!signal.aborted){
      this.state.lifecycleState="thinking";

      try{
        const thought=await this.cognitiveStep.run({
          state:this.getState(),
          signal
        });

        if(signal.aborted)break;

        this.applyThought(thought);
      }catch(error){
        if(signal.aborted||isAbortError(error))break;
        this.state.lifecycleState="error";
        return;
      }

      if(signal.aborted)break;
      await wait(this.stepIntervalMs,signal);
    }

    if(this.state.lifecycleState!=="error"){
      this.state.lifecycleState="off";
    }
  }

  private applyThought(thought:Thought):void{
    this.state.lastThought=thought;
    this.state.lastThoughtAt=thought.timestamp;
    this.state.recentThoughts=[
      ...this.state.recentThoughts,
      thought
    ].slice(-this.recentThoughtLimit);
  }

  static createAbortError():Error{
    return abortError();
  }
}

export class DeterministicCognitiveStep implements CognitiveStep{
  private sequence=0;

  constructor(private readonly clock:()=>string=()=>new Date().toISOString()){}

  async run(context:CognitiveStepContext):Promise<Thought>{
    if(context.signal.aborted)throw MindRuntime.createAbortError();

    this.sequence+=1;
    const previous=context.state.lastThought;
    return {
      id:`thought:deterministic:${this.sequence}`,
      timestamp:this.clock(),
      content:previous
        ? `Internal continuation after ${previous.id}`
        : "Initial internal thought",
      expression:"internal"
    };
  }
}

export type {MindRuntimeLifecycleState};
