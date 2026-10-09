import type {CognitiveScheduleSettings,MindExpressionCandidate,MindExpressionPublishResult,MindExpressionPublisher,MindExpressionSuppressionReason,MindRuntimeLifecycleState,MindState,MindTraceEntry,MindWakeReason,Thought,Unsubscribe} from "../../contracts/src";
import {DEFAULT_COGNITIVE_SCHEDULE,DEFAULT_PROACTIVE_CHAT} from "../../contracts/src";
import type {ProactiveChatSettings} from "../../contracts/src";
import {MindScheduler} from "./mind-scheduler";

const DEFAULT_RECENT_THOUGHTS=50;
const DEFAULT_STEP_TIMEOUT_MS=60_000;
const MAX_THOUGHT_CHARS=8_000;
const MAX_TRACE_ENTRIES=100;
const HOUR_MS=3_600_000;

export interface CognitiveStepContext{characterId:string;state:Readonly<MindState>;signal:AbortSignal;wakeReason:MindWakeReason;}
export interface CognitiveStepResult{thought:Thought;nextWakeInMs?:unknown;requestId?:string;providerId?:string;expression?:MindExpressionCandidate;expressionInvalid?:boolean;conversationId?:string;}
export interface CognitiveStep{run(context:CognitiveStepContext):Promise<Thought|CognitiveStepResult>;}
export interface MindRuntimeOptions{
  cognitiveStep:CognitiveStep;
  schedule?:CognitiveScheduleSettings;
  /** Legacy test/consumer option. When provided without schedule it selects fixed cadence. */
  stepIntervalMs?:number;
  stepTimeoutMs?:number;
  recentThoughtLimit?:number;
  initialFocus?:string|null;
  onError?:(error:unknown)=>void;
  clock?:()=>string;
  now?:()=>number;
  proactiveChat?:ProactiveChatSettings;
  expressionPublisher?:MindExpressionPublisher;
  isExpressionContextCurrent?:(characterId:string,conversationId:string)=>Promise<boolean>|boolean;
  onExpressionError?:(error:unknown)=>void;
}

interface CharacterMindState{focus:string|null;lastThought:Thought|null;lastThoughtAt:string|null;recentThoughts:Thought[];}
type CancellationKind="cancelled"|"superseded"|"timeout";
interface IntervalChoice{intervalMs:number;requested?:number;decision:string;}
function abortError():Error{const error=new Error("Mind Runtime cognitive step aborted.");error.name="AbortError";return error;}
function cloneState(state:MindState):MindState{
  return {...state,recentThoughts:[...state.recentThoughts],nextWakeAt:state.nextWakeAt??null,recentTrace:(state.recentTrace??[]).map(entry=>({...entry}))};
}
function createCharacterMindState(focus:string|null=null):CharacterMindState{return {focus,lastThought:null,lastThoughtAt:null,recentThoughts:[]};}
function normalizeSchedule(schedule:CognitiveScheduleSettings):CognitiveScheduleSettings{
  const upper=3_600_000;
  const validInt=(value:unknown,fallback:number,min=1,max=upper)=>typeof value==="number"&&Number.isFinite(value)&&Number.isInteger(value)?Math.min(max,Math.max(min,value)):fallback;
  const minIntervalMs=validInt(schedule?.minIntervalMs,DEFAULT_COGNITIVE_SCHEDULE.minIntervalMs);
  const maxIntervalMs=Math.max(minIntervalMs,validInt(schedule?.maxIntervalMs,DEFAULT_COGNITIVE_SCHEDULE.maxIntervalMs));
  const defaultIntervalMs=Math.min(maxIntervalMs,Math.max(minIntervalMs,validInt(schedule?.defaultIntervalMs,DEFAULT_COGNITIVE_SCHEDULE.defaultIntervalMs)));
  const maxRequestsPerHour=validInt(schedule?.maxRequestsPerHour,DEFAULT_COGNITIVE_SCHEDULE.maxRequestsPerHour,1,3600);
  return {mode:schedule?.mode==="fixed"?"fixed":"adaptive",defaultIntervalMs,minIntervalMs,maxIntervalMs,maxRequestsPerHour};
}
function extractResult(value:Thought|CognitiveStepResult):CognitiveStepResult{
  if(value&&typeof value==="object"&&"thought" in value)return value as CognitiveStepResult;
  return {thought:value as Thought};
}
function normalizeProactiveChat(settings:ProactiveChatSettings|undefined):ProactiveChatSettings{
  const integer=(value:unknown,fallback:number,min:number,max:number)=>typeof value==="number"&&Number.isSafeInteger(value)?Math.max(min,Math.min(max,value)):fallback;
  return {
    enabled:typeof settings?.enabled==="boolean"?settings.enabled:DEFAULT_PROACTIVE_CHAT.enabled,
    minMessageIntervalMs:integer(settings?.minMessageIntervalMs,DEFAULT_PROACTIVE_CHAT.minMessageIntervalMs,10_000,3_600_000),
    maxMessagesPerHour:integer(settings?.maxMessagesPerHour,DEFAULT_PROACTIVE_CHAT.maxMessagesPerHour,1,60)
  };
}
function chooseInterval(raw:unknown,settings:CognitiveScheduleSettings):IntervalChoice{
  if(settings.mode==="fixed")return {intervalMs:settings.defaultIntervalMs,decision:"fixed-mode"};
  if(typeof raw!=="number"||!Number.isFinite(raw)||!Number.isInteger(raw)||!Number.isSafeInteger(raw)){
    return {intervalMs:settings.defaultIntervalMs,decision:raw===undefined?"missing-interval-default":"invalid-interval-default"};
  }
  if(raw<settings.minIntervalMs)return {intervalMs:settings.minIntervalMs,requested:raw,decision:"below-minimum-clamped"};
  if(raw>settings.maxIntervalMs)return {intervalMs:settings.maxIntervalMs,requested:raw,decision:"above-maximum-clamped"};
  return {intervalMs:raw,requested:raw,decision:"model"};
}
function mergeWakeReason(current:MindWakeReason|undefined,next:MindWakeReason):MindWakeReason{
  if(!current)return next;
  if(current==="character-change"||next==="character-change")return "character-change";
  if(current==="user-message"||next==="user-message")return "user-message";
  return current;
}

export class MindRuntime{
  private readonly cognitiveStep:CognitiveStep;
  private readonly recentThoughtLimit:number;
  private readonly stepTimeoutMs:number;
  private readonly onError?:MindRuntimeOptions["onError"];
  private readonly initialFocus:string|null;
  private readonly clock:()=>string;
  private readonly now:()=>number;
  private scheduleSettings:CognitiveScheduleSettings;
  private proactiveChatSettings:ProactiveChatSettings;
  private expressionPublisher:MindExpressionPublisher|undefined;
  private readonly isExpressionContextCurrent:((characterId:string,conversationId:string)=>Promise<boolean>|boolean)|undefined;
  private readonly onExpressionError:((error:unknown)=>void)|undefined;
  private readonly expressionPublicationTimes:number[]=[];
  private readonly state:MindState;
  private readonly characterStates=new Map<string,CharacterMindState>();
  private readonly listeners=new Set<(state:MindState)=>void>();
  private readonly thoughtListeners=new Set<(thought:Thought)=>void>();
  private readonly trace:MindTraceEntry[]=[];
  private readonly requestStarts:number[]=[];
  private readonly scheduler:MindScheduler;
  private activeCharacterId:string|undefined;
  private lifeController:AbortController|undefined;
  private stepController:AbortController|undefined;
  private cancelActiveStep:((kind:CancellationKind)=>void)|undefined;
  private stepPromise:Promise<void>|undefined;
  private stepActive=false;
  private pendingWakeReason:MindWakeReason|undefined;
  private contextVersion=0;
  private runSequence=0;
  private consecutiveErrors=0;

  constructor(options:MindRuntimeOptions){
    if(options.stepIntervalMs!==undefined&&(!Number.isInteger(options.stepIntervalMs)||options.stepIntervalMs<1))throw new Error("Mind Runtime step interval must be a positive integer.");
    if(options.stepTimeoutMs!==undefined&&(!Number.isInteger(options.stepTimeoutMs)||options.stepTimeoutMs<1))throw new Error("Mind Runtime step timeout must be a positive integer.");
    if(options.recentThoughtLimit!==undefined&&(!Number.isInteger(options.recentThoughtLimit)||options.recentThoughtLimit<1))throw new Error("Mind Runtime recent thought limit must be a positive integer.");
    this.cognitiveStep=options.cognitiveStep;
    const legacy=options.schedule===undefined&&options.stepIntervalMs!==undefined;
    const interval=options.stepIntervalMs??DEFAULT_COGNITIVE_SCHEDULE.defaultIntervalMs;
    this.scheduleSettings=normalizeSchedule(options.schedule??(legacy?{mode:"fixed",defaultIntervalMs:interval,minIntervalMs:interval,maxIntervalMs:interval,maxRequestsPerHour:3600}:DEFAULT_COGNITIVE_SCHEDULE));
    this.recentThoughtLimit=options.recentThoughtLimit??DEFAULT_RECENT_THOUGHTS;
    this.stepTimeoutMs=options.stepTimeoutMs??DEFAULT_STEP_TIMEOUT_MS;
    this.onError=options.onError;
    this.proactiveChatSettings=normalizeProactiveChat(options.proactiveChat);
    this.expressionPublisher=options.expressionPublisher;
    this.isExpressionContextCurrent=options.isExpressionContextCurrent;
    this.onExpressionError=options.onExpressionError;
    this.initialFocus=options.initialFocus??null;
    this.clock=options.clock??(()=>new Date().toISOString());
    this.now=options.now??(()=>Date.now());
    this.state={focus:this.initialFocus,lastThought:null,lastThoughtAt:null,recentThoughts:[],lifecycleState:"off",nextWakeAt:null,recentTrace:[]};
    this.scheduler=new MindScheduler(reason=>this.handleWake(reason),this.now);
  }

  getState():MindState{return cloneState(this.state);}
  subscribe(listener:(state:MindState)=>void):Unsubscribe{this.listeners.add(listener);return ()=>{this.listeners.delete(listener)};}
  subscribeThoughts(listener:(thought:Thought)=>void):Unsubscribe{this.thoughtListeners.add(listener);return ()=>{this.thoughtListeners.delete(listener)};}

  setActiveCharacter(characterId:string):void{
    const normalized=characterId.trim();
    if(!normalized)throw new Error("Mind Runtime active character id must not be empty.");
    if(normalized===this.activeCharacterId)return;
    this.activeCharacterId=normalized;this.contextVersion+=1;
    if(!this.characterStates.has(normalized))this.characterStates.set(normalized,createCharacterMindState(this.characterStates.size===0?this.initialFocus:null));
    this.syncActiveState();this.notify();
    if(this.lifeController&&!this.lifeController.signal.aborted)this.wake("character-change");
  }

  async start():Promise<void>{
    if(this.state.lifecycleState!=="off")throw new Error("Mind Runtime cannot start from state "+this.state.lifecycleState+".");
    if(!this.activeCharacterId)throw new Error("Mind Runtime cannot start without an active character.");
    const controller=new AbortController();this.lifeController=controller;
    this.pendingWakeReason=undefined;this.consecutiveErrors=0;
    this.scheduler.cancel();this.state.nextWakeAt=null;
    this.setLifecycleState("starting");
    this.scheduler.wake("life-start");
  }

  async stop():Promise<void>{
    if(this.state.lifecycleState==="off"&&!this.lifeController)return;
    this.scheduler.cancel();this.state.nextWakeAt=null;this.pendingWakeReason=undefined;
    this.setLifecycleState("stopping");
    const controller=this.lifeController;
    controller?.abort();
    this.cancelActiveStep?.("cancelled");
    const running=this.stepPromise;
    if(running)await running;
    this.lifeController=undefined;this.stepController=undefined;this.cancelActiveStep=undefined;this.stepPromise=undefined;
    this.stepActive=false;this.state.nextWakeAt=null;
    this.setLifecycleState("off");
  }

  wake(reason:MindWakeReason="user-message"):void{
    const life=this.lifeController;
    if(!life||life.signal.aborted||this.state.lifecycleState==="off"||this.state.lifecycleState==="stopping")return;
    this.scheduler.cancel();this.state.nextWakeAt=null;
    if(this.stepActive){
      this.pendingWakeReason=mergeWakeReason(this.pendingWakeReason,reason);
      this.cancelActiveStep?.("superseded");
      this.notify();return;
    }
    this.scheduler.wake(reason);
  }

  updateSchedule(schedule:CognitiveScheduleSettings):void{
    this.scheduleSettings=normalizeSchedule(schedule);
    if(!this.lifeController||this.lifeController.signal.aborted||this.state.lifecycleState==="off"||this.state.lifecycleState==="stopping"||this.stepActive)return;
    const priorReason=this.scheduler.scheduledReason??"scheduled";
    this.scheduler.cancel();this.scheduleNext(this.scheduleSettings.defaultIntervalMs,priorReason);
  }
  updateProactiveChat(settings:ProactiveChatSettings):void{this.proactiveChatSettings=normalizeProactiveChat(settings);}
  setExpressionPublisher(publisher:MindExpressionPublisher|undefined):void{this.expressionPublisher=publisher;}

  deleteThought(thoughtId:string):boolean{
    const id=thoughtId.trim();if(!id||!this.activeCharacterId)return false;
    const characterState=this.characterStates.get(this.activeCharacterId);if(!characterState)return false;
    const index=characterState.recentThoughts.findIndex(thought=>thought.id===id);if(index<0)return false;
    characterState.recentThoughts.splice(index,1);
    if(characterState.lastThought?.id===id){const next=characterState.recentThoughts[characterState.recentThoughts.length-1]??null;characterState.lastThought=next;characterState.lastThoughtAt=next?.timestamp??null;}
    this.syncActiveState();this.notify();return true;
  }
  clearCurrentThoughts():void{
    if(!this.activeCharacterId)return;const characterState=this.characterStates.get(this.activeCharacterId);if(!characterState)return;
    characterState.lastThought=null;characterState.lastThoughtAt=null;characterState.recentThoughts=[];this.syncActiveState();this.notify();
  }
  clearAllThoughts():void{
    for(const characterState of this.characterStates.values()){characterState.lastThought=null;characterState.lastThoughtAt=null;characterState.recentThoughts=[];}
    this.syncActiveState();this.notify();
  }

  private handleWake(reason:MindWakeReason):void{
    const life=this.lifeController;
    if(!life||life.signal.aborted||this.state.lifecycleState==="off"||this.state.lifecycleState==="stopping")return;
    if(this.stepActive){this.pendingWakeReason=mergeWakeReason(this.pendingWakeReason,reason);return;}
    const task=this.runStep(reason);this.stepPromise=task;
    void task.finally(()=>{if(this.stepPromise===task)this.stepPromise=undefined;}).catch(()=>undefined);
  }

  private async runStep(reason:MindWakeReason):Promise<void>{
    const life=this.lifeController;if(!life||life.signal.aborted||!this.activeCharacterId)return;
    this.stepActive=true;this.state.nextWakeAt=null;this.setLifecycleState("thinking");
    const characterId=this.activeCharacterId,contextVersion=this.contextVersion;
    const startedMs=this.now(),startedAt=this.clock(),runId="mind-run-"+startedMs+"-"+(++this.runSequence);
    let nextDelay:number|undefined, nextReason:MindWakeReason="scheduled";
    let requestId:string|undefined,providerId:string|undefined,requested:number|undefined,applied:number|undefined,decision:string|undefined;
    let expressionTrace:Partial<MindTraceEntry>={};
    let cancellation:CancellationKind|undefined;
    let stepController:AbortController|undefined;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    const finishTrace=(result:MindTraceEntry["result"],extra:Partial<MindTraceEntry>={})=>{
      const finishedAt=this.clock(),durationMs=Math.max(0,this.now()-startedMs);
      this.trace.push({runId,characterId,wakeReason:reason,startedAt,finishedAt,durationMs,result,...(requested===undefined?{}:{requestedNextWakeInMs:requested}),...(applied===undefined?{}:{appliedIntervalMs:applied}),...(decision===undefined?{}:{intervalDecision:decision}),...(requestId?{requestId}:{}),...(providerId?{providerId}:{}),...expressionTrace,...extra});
      if(this.trace.length>MAX_TRACE_ENTRIES)this.trace.splice(0,this.trace.length-MAX_TRACE_ENTRIES);
      this.state.recentTrace=this.trace.map(entry=>({...entry}));this.notify();
    };
    try{
      const quotaWait=this.quotaWaitMs();
      if(quotaWait>0){
        applied=quotaWait;decision="hourly-limit";nextDelay=quotaWait;nextReason="quota-available";
        finishTrace("deferred");return;
      }
      this.requestStarts.push(this.now());
      stepController=new AbortController();this.stepController=stepController;
      const cancel=(kind:CancellationKind)=>{
        if(cancellation!==undefined||!stepController)return;
        cancellation=kind;stepController.abort();
      };
      this.cancelActiveStep=cancel;
      const onLifeAbort=()=>cancel("cancelled");
      life.signal.addEventListener("abort",onLifeAbort,{once:true});
      timeout=setTimeout(()=>cancel("timeout"),this.stepTimeoutMs);
      const rawPromise=this.cognitiveStep.run({characterId,state:this.getState(),signal:stepController.signal,wakeReason:reason});
      const abortPromise=new Promise<never>((_,reject)=>{
        const rejectAbort=()=>{
          if(cancellation==="timeout"){const error=new Error("Cognitive step timed out.");error.name="TimeoutError";reject(error);}
          else reject(abortError());
        };
        if(stepController!.signal.aborted)rejectAbort();
        else stepController!.signal.addEventListener("abort",rejectAbort,{once:true});
      });
      let raw:Thought|CognitiveStepResult;
      try{raw=await Promise.race([rawPromise,abortPromise]);}
      finally{life.signal.removeEventListener("abort",onLifeAbort);}
      const result=extractResult(raw);
      requestId=result.requestId;providerId=result.providerId;
      if(cancellation==="superseded"||life.signal.aborted||contextVersion!==this.contextVersion||characterId!==this.activeCharacterId){
        finishTrace("cancelled",{intervalDecision:"stale-context"});return;
      }
      const thought=result.thought;
      if(!thought||typeof thought!=="object"||thought.characterId!==characterId)throw new Error("Cognitive Thought character scope mismatch.");
      if(typeof thought.content!=="string"||!thought.content.trim()||thought.content.length>MAX_THOUGHT_CHARS)throw new Error("Cognitive Thought content is empty or exceeds the allowed length.");
      const choice=chooseInterval(result.nextWakeInMs,this.scheduleSettings);
      requested=choice.requested;applied=choice.intervalMs;decision=choice.decision;
      if(stepController.signal.aborted||life.signal.aborted||contextVersion!==this.contextVersion){finishTrace("cancelled",{intervalDecision:"cancelled-before-apply"});return;}
      this.applyThought(thought);
      if(result.expressionInvalid){
        expressionTrace={expressionKind:"chat",expressionStatus:"invalid",expressionSuppressionReason:"invalid-expression",expressionId:"nova-life-expression:"+runId,...(typeof result.conversationId==="string"?{expressionConversationId:result.conversationId}:{})};
      }else if(!result.expression||result.expression.kind==="internal"){
        expressionTrace={expressionKind:"internal",expressionStatus:"internal"};
      }else if(result.expression.kind==="chat"){
        expressionTrace=await this.attemptExpression({
          characterId,conversationId:result.conversationId,content:result.expression.content,
          expressionId:"nova-life-expression:"+runId,reason,contextVersion,stepController,life,
          isCancelled:()=>cancellation!==undefined
        });
      }else{
        expressionTrace={expressionKind:"chat",expressionStatus:"invalid",expressionSuppressionReason:"invalid-expression",expressionId:"nova-life-expression:"+runId};
      }
      this.consecutiveErrors=0;nextDelay=applied;nextReason="scheduled";
      finishTrace("success",expressionTrace);
    }catch(error){
      if(cancellation==="cancelled"||cancellation==="superseded"||life.signal.aborted||contextVersion!==this.contextVersion||characterId!==this.activeCharacterId){
        finishTrace("cancelled",{intervalDecision:cancellation==="superseded"?"superseded-by-new-context":"cancelled"});return;
      }
      this.consecutiveErrors+=1;
      applied=this.errorBackoffMs();decision="error-backoff";nextDelay=applied;nextReason="error-backoff";
      const errorCode=cancellation==="timeout"?"STEP_TIMEOUT":error instanceof Error?error.name:"COGNITIVE_STEP_FAILED";
      this.safeOnError(error);
      finishTrace("error",{errorCode,intervalDecision:decision});
    }finally{
      if(timeout!==undefined)clearTimeout(timeout);
      this.stepController=undefined;this.cancelActiveStep=undefined;this.stepActive=false;
      const lifeNow=this.lifeController;
      if(lifeNow&&!lifeNow.signal.aborted&&this.state.lifecycleState!=="stopping"){
        const pending=this.pendingWakeReason;
        if(pending){this.pendingWakeReason=undefined;this.scheduler.wake(pending);}
        else if(nextDelay!==undefined)this.scheduleNext(nextDelay,nextReason);
      }
    }
  }

  private async attemptExpression(input:{
    characterId:string;
    conversationId?:string;
    content:string;
    expressionId:string;
    reason:MindWakeReason;
    contextVersion:number;
    stepController:AbortController;
    life:AbortController;
    isCancelled:()=>boolean;
  }):Promise<Partial<MindTraceEntry>>{
    const base:Partial<MindTraceEntry>={expressionKind:"chat",expressionId:input.expressionId,...(input.conversationId?{expressionConversationId:input.conversationId}:{})};
    const suppressed=(reason:MindExpressionSuppressionReason):Partial<MindTraceEntry>=>({...base,expressionStatus:"suppressed",expressionSuppressionReason:reason});
    const failed=(reason:MindExpressionSuppressionReason,errorCode?:string):Partial<MindTraceEntry>=>({...base,expressionStatus:"failed",expressionSuppressionReason:reason,...(errorCode?{expressionErrorCode:errorCode}:{})});
    if(input.reason!=="scheduled"){
      const reason:MindExpressionSuppressionReason=input.reason==="user-message"?"user-message-wake":input.reason==="life-start"?"life-start-wake":input.reason==="character-change"?"character-change-wake":"not-scheduled-wake";
      return suppressed(reason);
    }
    if(!this.proactiveChatSettings.enabled)return suppressed("disabled");
    if(typeof input.content!=="string"||!input.content.trim()||input.content.length>2000)return {...base,expressionStatus:"invalid",expressionSuppressionReason:"invalid-expression"};
    if(!input.conversationId?.trim())return suppressed("wrong-conversation");
    if(!this.expressionPublisher)return suppressed("publisher-unavailable");
    const current=()=>{
      if(input.life.signal.aborted||this.lifeController!==input.life||input.stepController.signal.aborted||input.isCancelled())return false;
      if(input.contextVersion!==this.contextVersion||input.characterId!==this.activeCharacterId)return false;
      return true;
    };
    if(!current())return suppressed(input.isCancelled()&&this.pendingWakeReason==="user-message"?"user-message-wake":input.isCancelled()&&this.pendingWakeReason==="character-change"?"character-change-wake":"stale-context");
    try{
      if(!this.isExpressionContextCurrent||!await this.isExpressionContextCurrent(input.characterId,input.conversationId))return suppressed("stale-context");
    }catch{return suppressed("stale-context");}
    if(!current())return suppressed(input.isCancelled()&&this.pendingWakeReason==="user-message"?"user-message-wake":input.isCancelled()&&this.pendingWakeReason==="character-change"?"character-change-wake":"stale-context");
    const now=this.now();
    while(this.expressionPublicationTimes.length>0&&now-this.expressionPublicationTimes[0]!>=HOUR_MS)this.expressionPublicationTimes.shift();
    const last=this.expressionPublicationTimes[this.expressionPublicationTimes.length-1];
    if(last!==undefined&&now-last<this.proactiveChatSettings.minMessageIntervalMs)return suppressed("cooldown");
    if(this.expressionPublicationTimes.length>=this.proactiveChatSettings.maxMessagesPerHour)return suppressed("hourly-limit");
    if(!current())return suppressed("stale-context");
    try{
      if(!this.isExpressionContextCurrent||!await this.isExpressionContextCurrent(input.characterId,input.conversationId))return suppressed("stale-context");
    }catch{return suppressed("stale-context");}
    if(!current())return suppressed(input.isCancelled()&&this.pendingWakeReason==="user-message"?"user-message-wake":input.isCancelled()&&this.pendingWakeReason==="character-change"?"character-change-wake":"stale-context");
    const publisher=this.expressionPublisher;
    if(!publisher)return suppressed("publisher-unavailable");
    let outcome:MindExpressionPublishResult;
    try{
      outcome=await publisher.publish({characterId:input.characterId,conversationId:input.conversationId,expressionId:input.expressionId,content:input.content,signal:input.stepController.signal});
    }catch(error){
      this.safeOnExpressionError(error);
      return failed("publication-failed",error instanceof Error?error.name:"PUBLISH_FAILED");
    }
    if(outcome.status==="suppressed")return suppressed(outcome.reason);
    if(outcome.status==="failed"){
      if(outcome.reason==="publication-failed"||outcome.reason==="publisher-unavailable")this.safeOnExpressionError(new Error(outcome.errorCode??outcome.reason));
      return failed(outcome.reason,outcome.errorCode);
    }
    if(outcome.conversationId!==input.conversationId||typeof outcome.messageId!=="string"||!outcome.messageId.trim())return suppressed("wrong-conversation");
    this.expressionPublicationTimes.push(this.now());
    return {...base,expressionStatus:"published",expressionMessageId:outcome.messageId};
  }

  private quotaWaitMs():number{
    const now=this.now();
    while(this.requestStarts.length>0&&now-this.requestStarts[0]!>=HOUR_MS)this.requestStarts.shift();
    if(this.requestStarts.length<this.scheduleSettings.maxRequestsPerHour)return 0;
    return Math.max(1,this.requestStarts[0]!+HOUR_MS-now);
  }
  private errorBackoffMs():number{
    const exponent=Math.min(20,Math.max(0,this.consecutiveErrors-1));
    const proposed=this.scheduleSettings.defaultIntervalMs*Math.pow(2,exponent);
    return Math.min(this.scheduleSettings.maxIntervalMs,Math.max(this.scheduleSettings.minIntervalMs,proposed));
  }
  private scheduleNext(delayMs:number,reason:MindWakeReason):void{
    const life=this.lifeController;if(!life||life.signal.aborted||this.state.lifecycleState==="off"||this.state.lifecycleState==="stopping")return;
    const deadline=this.scheduler.schedule(Math.max(1,Math.floor(delayMs)),reason);
    this.state.nextWakeAt=new Date(deadline).toISOString();this.setLifecycleState("waiting");
  }
  private safeOnError(error:unknown):void{try{this.onError?.(error)}catch{/* diagnostics must not stop Life */}}
  private safeOnExpressionError(error:unknown):void{try{this.onExpressionError?.(error)}catch{/* expression diagnostics must not stop Life */}}
  private setLifecycleState(lifecycleState:MindRuntimeLifecycleState):void{this.state.lifecycleState=lifecycleState;this.notify();}
  private applyThought(thought:Thought):void{
    const characterState=this.characterStates.get(thought.characterId)??createCharacterMindState();
    characterState.lastThought=thought;characterState.lastThoughtAt=thought.timestamp;
    characterState.recentThoughts=[...characterState.recentThoughts,thought].slice(-this.recentThoughtLimit);
    this.characterStates.set(thought.characterId,characterState);
    if(thought.characterId===this.activeCharacterId)this.syncActiveState();
    for(const listener of [...this.thoughtListeners]){try{listener({...thought})}catch{/* UI observers cannot affect runtime */}}
    this.notify();
  }
  private syncActiveState():void{
    if(!this.activeCharacterId)return;
    const characterState=this.characterStates.get(this.activeCharacterId)??createCharacterMindState();
    this.characterStates.set(this.activeCharacterId,characterState);
    this.state.focus=characterState.focus;this.state.lastThought=characterState.lastThought;this.state.lastThoughtAt=characterState.lastThoughtAt;this.state.recentThoughts=[...characterState.recentThoughts];
  }
  private notify():void{const snapshot=this.getState();for(const listener of [...this.listeners]){try{listener(snapshot)}catch{/* observers cannot affect runtime */}}}
  static createAbortError():Error{return abortError();}
}

export class DeterministicCognitiveStep implements CognitiveStep{
  private sequence=0;
  constructor(private readonly clock:()=>string=()=>new Date().toISOString()){}
  async run(context:CognitiveStepContext):Promise<Thought>{
    if(context.signal.aborted)throw MindRuntime.createAbortError();
    this.sequence+=1;const previous=context.state.lastThought;
    return {characterId:context.characterId,id:"thought:deterministic:"+this.sequence,timestamp:this.clock(),content:previous?"Internal continuation after "+previous.id:"Initial internal thought",expression:"internal"};
  }
}
export type {MindRuntimeLifecycleState};
