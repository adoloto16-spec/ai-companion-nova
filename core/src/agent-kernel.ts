import type {AgentDecision,AgentDecisionAction,AgentRun,AgentRunInput,AgentRunLimits,AgentState,AgentStep,ChatMessage,DiagnosticsStore,EventBus,SchemaValidator} from "../../contracts/src/index";
import {AGENT_DEFAULT_LIMITS,STANDARD_SCHEMAS,StandardContractValidator,createEvent} from "../../contracts/src/index";
import {AgentDecisionProtocolError} from "./agent-protocol";
import {AgentModelCallLimitError} from "./agent-cognitive-controller";
import type {AgentCognitiveDecisionProvider,AgentCognitiveContext,AgentDecisionResult} from "./agent-cognitive-controller";
import type {AgentActionExecutor,AgentActionExecution} from "./agent-action-executor";

const TERMINAL:readonly AgentState[]=["completed","failed"];
const transitions:Record<AgentState,readonly AgentState[]>={
  starting:["ready","failed","interrupted"],
  ready:["thinking","paused","failed","stopping"],
  idle:["thinking","paused","failed","stopping"],
  thinking:["acting","waiting","completed","failed","interrupted","paused","stopping"],
  planning:["thinking","acting","waiting","failed","interrupted","paused","stopping"],
  acting:["thinking","waiting","completed","failed","interrupted","paused","stopping"],
  waiting:["ready","thinking","paused","interrupted","failed","stopping"],
  interrupted:["ready","thinking"],
  paused:["ready","thinking"],
  resting:["ready","thinking","stopping"],
  stopping:["completed","failed","interrupted"],
  completed:[],
  failed:[]
};

function status(state:AgentState):AgentRun["status"]{
  if(state==="waiting")return "waiting";
  if(state==="paused")return "paused";
  if(state==="completed")return "completed";
  if(state==="failed")return "failed";
  if(state==="interrupted")return "interrupted";
  return "running";
}
function bounded(value:string,max=512){return value.length<=max?value:value.slice(0,max);}
function isAbortError(error:unknown){return error instanceof Error&&error.name==="AbortError";}

export class AgentKernelError extends Error{
  readonly code:"AGENT_RUN_NOT_FOUND"|"AGENT_INVALID_STATE"|"AGENT_MODEL_CALL_LIMIT_REACHED";
  constructor(code:"AGENT_RUN_NOT_FOUND"|"AGENT_INVALID_STATE"|"AGENT_MODEL_CALL_LIMIT_REACHED",message:string){super(message);this.name="AgentKernelError";this.code=code;}
}

interface Control{controller:AbortController;timer?:ReturnType<typeof setTimeout>;durationExceeded:boolean;}

export interface AgentKernelStepOptions{
  contextProvider?:(run:AgentRun,stepIndex:number,previousRuntimeMessages:readonly ChatMessage[])=>Promise<readonly ChatMessage[]>;
}

export interface AgentKernelOptions{
  cognitive:AgentCognitiveDecisionProvider;
  actionExecutor:AgentActionExecutor;
  validator?:SchemaValidator;
  diagnostics?:DiagnosticsStore;
  events?:EventBus;
  clock?:()=>string;
  limits?:Partial<AgentRunLimits>;
  conversationContext?:(characterId:string,conversationId:string)=>Promise<readonly ChatMessage[]>;
}

export class AgentKernel{
  private readonly validator:SchemaValidator;
  private readonly diagnostics?:DiagnosticsStore;
  private readonly events?:EventBus;
  private readonly clock:()=>string;
  private readonly limits:Partial<AgentRunLimits>;
  private readonly runs=new Map<string,AgentRun>();
  private readonly steps=new Map<string,AgentStep[]>();
  private readonly controls=new Map<string,Control>();
  private readonly consecutiveFailures=new Map<string,number>();
  private readonly pendingUserResponses=new Map<string,string>();
  private readonly runtimeContextMessages=new Map<string,ChatMessage[]>();
  private nextId=1;

  constructor(private readonly options:AgentKernelOptions){
    this.validator=options.validator??new StandardContractValidator();
    this.diagnostics=options.diagnostics;this.events=options.events;this.clock=options.clock??(()=>new Date().toISOString());this.limits=options.limits??{};
  }

  async createRun(input:AgentRunInput):Promise<AgentRun>{
    if(!input.characterId.trim())throw new Error("Agent characterId must not be empty.");
    if(!input.goal.trim())throw new Error("Agent goal must not be empty.");
    if(!input.task.trim())throw new Error("Agent task must not be empty.");
    const limits=this.normalizeLimits({...this.limits,...input.limits});
    const now=this.clock(),id=input.id?.trim()||("agent-run:"+Date.now().toString(36)+":"+this.nextId++);
    if(this.runs.has(id))throw new Error("Agent run already exists: "+id);
    const run:AgentRun={
      id,characterId:bounded(input.characterId,200),...(input.conversationId?{conversationId:bounded(input.conversationId,200)}:{}),goal:bounded(input.goal,4000),task:bounded(input.task,4000),wakeReason:bounded(input.wakeReason??"runtime_event",100),
      state:"starting",status:"running",stepCount:0,modelCallCount:0,startedAt:now,updatedAt:now,limits,
      ...(input.providerId?{providerId:input.providerId}:{}),...(input.model?{model:input.model}: {})
    };
    this.runs.set(id,run);this.steps.set(id,[]);this.runtimeContextMessages.set(id,[]);
    await this.events?.publish(createEvent("AgentRunStarted",{runId:id,characterId:run.characterId,goal:run.goal},"agent-kernel",this.clock,id+":started"));
    await this.setState(run,"ready");
    return this.clone(run);
  }

  getRun(runId:string){const run=this.runs.get(runId);return run?this.clone(run):undefined;}
  getSteps(runId:string){return [...(this.steps.get(runId)??[])].map(step=>({...step}));}

  async step(runId:string,options:AgentKernelStepOptions={}):Promise<AgentRun>{
    const run=this.require(runId);
    if(TERMINAL.includes(run.state)||run.state==="waiting"||run.state==="paused"||run.state==="interrupted")
      throw new AgentKernelError("AGENT_INVALID_STATE","Agent run is not ready for another automatic step.");
    if(run.stepCount>=run.limits.maxSteps)return this.limitFailure(run,"AGENT_STEP_LIMIT_REACHED","Agent step limit reached.");
    if(run.modelCallCount>=run.limits.maxModelCallsPerBurst)return this.limitFailure(run,"AGENT_MODEL_CALL_LIMIT_REACHED","Agent model-call budget reached.");
    if(this.elapsed(run)>=run.limits.maxDurationMs)return this.limitFailure(run,"AGENT_DURATION_LIMIT_REACHED","Agent duration limit reached.");

    const control=this.controlFor(run);
    const stepIndex=run.stepCount+1,startedAt=this.clock();
    await this.setState(run,"thinking");
    await this.events?.publish(createEvent("AgentStepStarted",{runId:run.id,stepIndex},"agent-kernel",this.clock,run.id+":step-started:"+stepIndex));

    let result:AgentDecisionResult;
    try{
      const runtimeContext=this.runtimeContextMessages.get(run.id)??[];
      const conversationMessages=options.contextProvider
        ?await options.contextProvider(run,stepIndex,runtimeContext)
        :run.conversationId&&this.options.conversationContext
          ?await this.options.conversationContext(run.characterId,run.conversationId)
          :[];
      const userResponse=this.pendingUserResponses.get(run.id);
      if(userResponse!==undefined)this.pendingUserResponses.delete(run.id);
      const context:AgentCognitiveContext={
        runId:run.id,characterId:run.characterId,goal:run.goal,task:run.task,state:"thinking",stepIndex,wakeReason:run.wakeReason,
        ...(run.workingSummary?{workingSummary:run.workingSummary}:{}),
        ...(run.lastAction?{lastAction:run.lastAction}:{}),...(run.lastOutcome?{lastOutcome:run.lastOutcome}:{}),
        ...(run.conversationId?{conversationId:run.conversationId}:{}),
        recentConversationMessages:conversationMessages.slice(-32),
        ...(userResponse!==undefined?{userResponse}:{}),
        ...(run.providerId?{providerId:run.providerId}:{}),model:run.model??"",maxModelCallsPerBurst:run.limits.maxModelCallsPerBurst,modelCallsUsed:run.modelCallCount
      };
      result=await this.options.cognitive.decide(context,{signal:control.controller.signal});
    }catch(error){
      if(error instanceof AgentDecisionProtocolError){
        this.recordStep(run,stepIndex,startedAt,this.clock(),"failed","respond");
        return this.fail(run,"AGENT_DECISION_INVALID","Agent decision parsing failed.",error,"protocol_model_output",stepIndex);
      }
      if(error instanceof AgentModelCallLimitError){
        this.recordStep(run,stepIndex,startedAt,this.clock(),"failed","respond");
        return this.fail(run,"AGENT_MODEL_CALL_LIMIT_REACHED","Agent model-call budget reached.",error,"budget",stepIndex);
      }
      if(isAbortError(error)){
        const liveState=run.state as AgentState;
    if(liveState==="interrupted"||liveState==="paused")return this.clone(run);
        if(control.durationExceeded)return this.limitFailure(run,"AGENT_DURATION_LIMIT_REACHED","Agent duration limit reached.");
      }
      this.diagnostics?.recordError("agent-kernel","AGENT_COGNITION_FAILED","Agent cognition failed.",{runId:run.id});
      return this.fail(run,"AGENT_COGNITION_FAILED","Agent cognition failed.",error);
    }

    const postCognitiveState=run.state as AgentState;
    if(postCognitiveState==="interrupted"||postCognitiveState==="paused")return this.clone(run);

    const valid=this.validator.validate(result.decision,STANDARD_SCHEMAS["agent-decision"]!);
    if(!valid.valid){
      this.diagnostics?.recordError("agent-kernel","AGENT_DECISION_INVALID","Agent decision failed kernel validation.",{runId:run.id,stepIndex});
      return this.fail(run,"AGENT_DECISION_INVALID","Agent decision failed kernel validation.");
    }

    await this.events?.publish(createEvent("AgentDecisionMade",{runId:run.id,stepIndex,action:result.decision.action,outputMode:result.outputMode},"agent-kernel",this.clock,run.id+":decision:"+stepIndex));
    await this.setState(run,"acting");

    const decisionAction=result.decision.action;
    let action:AgentActionExecution;
    try{
      action=await this.options.actionExecutor.execute(run,result.decision,{signal:control.controller.signal});
    }catch(error){
      if(isAbortError(error)){
        const liveActionState=run.state as AgentState;
        if(liveActionState==="interrupted"||liveActionState==="paused")return this.clone(run);
        if(control.durationExceeded)return this.limitFailure(run,"AGENT_DURATION_LIMIT_REACHED","Agent duration limit reached.");
      }
      const failures=(this.consecutiveFailures.get(run.id)??0)+1;
      this.consecutiveFailures.set(run.id,failures);
      this.recordStep(run,stepIndex,startedAt,this.clock(),"failed",decisionAction);
      if(failures>=run.limits.maxConsecutiveFailures)return this.limitFailure(run,"AGENT_FAILURE_LIMIT_REACHED","Agent consecutive failure limit reached.");
      await this.setState(run,"thinking");
      return this.clone(run);
    }

    this.consecutiveFailures.set(run.id,0);
    run.stepCount=stepIndex;
    run.modelCallCount+=result.modelCalls;
    run.lastAction=result.decision.action;
    run.lastOutcome=bounded(action.outcome+(action.summary?":"+action.summary:""));
    if(action.contextMessages){
      const runtimeMessages=this.runtimeContextMessages.get(run.id)??[];
      runtimeMessages.push(...action.contextMessages.map(message=>({...message,...(message.metadata?{metadata:{...message.metadata}}:{})})));
      this.runtimeContextMessages.set(run.id,runtimeMessages);
    }
    if(result.decision.action==="respond"||result.decision.action==="ask_user"){
      run.workingSummary=bounded(result.decision.action==="respond"?result.decision.content:result.decision.question,2000);
    }
    if(result.decision.action==="wait")run.lastWaitMs=action.waitMs;
    else run.lastWaitMs=undefined;
    if(result.decision.action==="tool_call"){
      run.lastToolName=result.decision.toolName;
      run.lastToolCallId=result.decision.callId;
    }else{
      run.lastToolName=undefined;
      run.lastToolCallId=undefined;
    }
    run.updatedAt=this.clock();

    await this.setState(run,action.nextState);
    this.recordStep(run,stepIndex,startedAt,this.clock(),action.outcome);
    await this.events?.publish(createEvent("AgentStepCompleted",{runId:run.id,stepIndex,decisionType:result.decision.action,outcome:action.outcome},"agent-kernel",this.clock,run.id+":step-completed:"+stepIndex));

    if(run.state==="completed"){
      await this.events?.publish(createEvent("AgentRunCompleted",{runId:run.id,stepCount:run.stepCount},"agent-kernel",this.clock,run.id+":completed"));
    }else if(run.state==="thinking"&&this.elapsed(run)>=run.limits.maxDurationMs){
      return this.limitFailure(run,"AGENT_DURATION_LIMIT_REACHED","Agent duration limit reached.");
    }else if(run.state==="thinking"&&run.stepCount>=run.limits.maxSteps){
      return this.limitFailure(run,"AGENT_STEP_LIMIT_REACHED","Agent step limit reached.");
    }
    return this.clone(run);
  }

  async run(runId:string,options:AgentKernelStepOptions={}):Promise<AgentRun>{
    const run=this.require(runId);
    if(TERMINAL.includes(run.state)||run.state==="waiting"||run.state==="paused"||run.state==="interrupted")return this.clone(run);
    const control=this.controlFor(run);
    const remaining=Math.max(0,run.limits.maxDurationMs-this.elapsed(run));
    if(remaining===0)return this.limitFailure(run,"AGENT_DURATION_LIMIT_REACHED","Agent duration limit reached.");
    control.timer=setTimeout(()=>{control.durationExceeded=true;control.controller.abort();},remaining);
    try{
      while(true){
        const current=this.runs.get(runId)!;
        if(TERMINAL.includes(current.state)||current.state==="waiting"||current.state==="paused"||current.state==="interrupted")break;
        if(current.stepCount>=current.limits.maxSteps){await this.limitFailure(current,"AGENT_STEP_LIMIT_REACHED","Agent step limit reached.");break;}
        if(this.elapsed(current)>=current.limits.maxDurationMs){await this.limitFailure(current,"AGENT_DURATION_LIMIT_REACHED","Agent duration limit reached.");break;}
        await this.step(runId,options);
      }
      return this.clone(this.runs.get(runId)!);
    }finally{
      if(control.timer)clearTimeout(control.timer);
      if(this.controls.get(runId)===control)this.controls.delete(runId);
    }
  }

  async interrupt(runId:string,reason="Interrupted by user."){
    const run=this.require(runId);
    if(TERMINAL.includes(run.state))return this.clone(run);
    this.pendingUserResponses.delete(runId);
    this.runtimeContextMessages.delete(runId);
    run.cancelReason=bounded(reason);await this.setState(run,"interrupted");
    const control=this.controls.get(runId);if(control){control.controller.abort();if(control.timer)clearTimeout(control.timer);this.controls.delete(runId);}
    this.diagnostics?.recordError("agent-kernel","AGENT_RUN_INTERRUPTED","Agent run was interrupted.",{runId,reason:run.cancelReason});
    await this.events?.publish(createEvent("AgentRunInterrupted",{runId,reason:run.cancelReason},"agent-kernel",this.clock,runId+":interrupted:"+Date.now()));
    return this.clone(run);
  }

  async pause(runId:string){
    const run=this.require(runId);if(TERMINAL.includes(run.state))return this.clone(run);
    this.pendingUserResponses.delete(runId);
    this.runtimeContextMessages.delete(runId);
    await this.setState(run,"paused");
    const control=this.controls.get(runId);if(control){control.controller.abort();if(control.timer)clearTimeout(control.timer);this.controls.delete(runId);}
    return this.clone(run);
  }

  async resume(runId:string,userResponse?:string){
    const run=this.require(runId);
    if(!["interrupted","paused","waiting"].includes(run.state)){
      if(run.state==="ready"||run.state==="thinking")return this.clone(run);
      throw new AgentKernelError("AGENT_INVALID_STATE","Agent run cannot be resumed from its current state.");
    }
    const normalizedResponse=userResponse?.trim();
    if(normalizedResponse){
      if(run.state!=="waiting"||run.lastAction!=="ask_user"){
        throw new AgentKernelError("AGENT_INVALID_STATE","Agent run is not waiting for an ask_user response.");
      }
      this.pendingUserResponses.set(runId,normalizedResponse);
    }
    run.cancelReason=undefined;await this.setState(run,"ready");return this.clone(run);
  }

  private controlFor(run:AgentRun){
    const existing=this.controls.get(run.id);if(existing)return existing;
    const control:Control={controller:new AbortController(),durationExceeded:false};this.controls.set(run.id,control);return control;
  }
  private elapsed(run:AgentRun){return Math.max(0,Date.parse(this.clock())-Date.parse(run.startedAt));}
  private async setState(run:AgentRun,next:AgentState){
    const previous=run.state;if(previous===next)return;
    if(!transitions[previous].includes(next))throw new AgentKernelError("AGENT_INVALID_STATE","Invalid Agent Kernel transition: "+previous+" -> "+next);
    run.state=next;run.status=status(next);run.updatedAt=this.clock();
    await this.events?.publish(createEvent("AgentStateChanged",{runId:run.id,state:next,previousState:previous},"agent-kernel",this.clock,run.id+":state:"+next+":"+Date.now()));
  }
  private recordStep(run:AgentRun,stepIndex:number,startedAt:string,completedAt:string,outcome:AgentStep["outcome"],decisionType:AgentDecisionAction=run.lastAction??"respond"){
    const list=this.steps.get(run.id);if(!list)return;
    list.push({stepIndex,startedAt,completedAt,decisionType,outcome});
  }
  private async fail(run:AgentRun,code:string,reason:string,error?:unknown,errorCategory?:string,stepIndex?:number){
    if(TERMINAL.includes(run.state))return this.clone(run);
    this.pendingUserResponses.delete(run.id);
    this.runtimeContextMessages.delete(run.id);
    if(error instanceof Error)run.lastOutcome=bounded(error.message);
    if(errorCategory)run.lastErrorCategory=errorCategory;
    await this.setState(run,"failed");
    const chatError=error&&typeof error==="object"?(error as any).chatError:undefined;
    const chatDetails=chatError&&typeof chatError==="object"&&chatError.details&&typeof chatError.details==="object"?chatError.details:{};
    const category=errorCategory??(code==="AGENT_DECISION_INVALID"?"protocol_model_output":chatDetails.category??"runtime");
    this.diagnostics?.recordError("agent-kernel",code,reason,{runId:run.id,step:stepIndex??null,provider:run.providerId??"default",model:run.model??"",outputMode:chatDetails.outputMode??null,errorCategory:category,requestId:chatError?.requestId??null});
    await this.events?.publish(createEvent("AgentRunFailed",{runId:run.id,code,reason},"agent-kernel",this.clock,run.id+":failed:"+code));
    return this.clone(run);
  }
  private limitFailure(run:AgentRun,code:"AGENT_STEP_LIMIT_REACHED"|"AGENT_DURATION_LIMIT_REACHED"|"AGENT_FAILURE_LIMIT_REACHED"|"AGENT_MODEL_CALL_LIMIT_REACHED",reason:string){
    return this.fail(run,code,reason);
  }
  private normalizeLimits(input:Partial<AgentRunLimits>):AgentRunLimits{
    const limits={...AGENT_DEFAULT_LIMITS,...input};
    if(!Number.isInteger(limits.maxSteps)||limits.maxSteps<1)throw new Error("maxSteps must be a positive integer.");
    if(!Number.isFinite(limits.maxDurationMs)||limits.maxDurationMs<1)throw new Error("maxDurationMs must be a positive finite number.");
    if(!Number.isInteger(limits.maxConsecutiveFailures)||limits.maxConsecutiveFailures<1)throw new Error("maxConsecutiveFailures must be a positive integer.");
    if(!Number.isInteger(limits.maxModelCallsPerBurst)||limits.maxModelCallsPerBurst<1)throw new Error("maxModelCallsPerBurst must be a positive integer.");
    return limits;
  }
  private require(runId:string){const run=this.runs.get(runId);if(!run)throw new AgentKernelError("AGENT_RUN_NOT_FOUND","Agent run not found: "+runId);return run;}
  private clone(run:AgentRun):AgentRun{return {...run,limits:{...run.limits}};}
}
