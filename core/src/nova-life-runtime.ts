import type {
  AgentRun,AgentDecisionAction,ChatMessage,Clock,ContextBudget,ContextEngine,DiagnosticsStore,EventBus,MemoryExtractionRequest,AgentRunInput,AgentRunLimits
} from "../../contracts/src/index";
import {createEvent} from "../../contracts/src/index";
import type {ConversationManager} from "./conversation-manager";
import type {AgentKernel} from "./agent-kernel";

export type NovaLifeStatus="off"|"starting"|"awake"|"thinking"|"acting"|"waiting"|"sleeping"|"stopping"|"error";
export type NovaLifeWakeReason="startup"|"user_message"|"scheduled_wake"|"wait_completed"|"runtime_event"|"conversation_changed"|"character_changed"|"retry";

export interface NovaLifeState{
  status:NovaLifeStatus;
  characterId?:string;
  conversationId?:string;
  startedAt?:string;
  lastWakeAt?:string;
  nextWakeAt?:string;
  wakeReason?:NovaLifeWakeReason;
  activeAgentRunId?:string;
  currentFocus?:string;
  lastAction?:AgentDecisionAction;
  lastOutcome?:string;
  lastActivityAt?:string;
  wakeCount:number;
}

export interface NovaLifeRuntimeOptions{
  agentKernel:AgentKernel;
  contextEngine:ContextEngine;
  conversationManager:Pick<ConversationManager,"getConversation"|"updateConversation"|"getActiveConversation">;
  events:EventBus;
  diagnostics?:DiagnosticsStore;
  clock?:Clock;
  contextBudget:()=>ContextBudget;
  resolveProviderId:()=>string|undefined;
  resolveModel:(providerId?:string)=>Promise<string>;
  getProviderPresetId?:()=>string|undefined;
  extractMemory?:(request:MemoryExtractionRequest)=>Promise<unknown>;
  memoryExtractionEnabled?:()=>boolean;
  recentConversationMessages?:()=>number;
  resolveAgentRunLimits?:()=>Partial<AgentRunLimits>;
  proactiveEnabled?:()=>boolean;
  allowProactiveMessages?:()=>boolean;
  startupBehavior?:()=>"proactive"|"wait";
  defaultWaitMs?:number|(()=>number);
  eventWakePolicy?:()=>{appChanged:boolean;windowChanged:boolean;conversationChanged:boolean;characterChanged:boolean};
  eventDebounceMs?:number|(()=>number);
  minimumWakeIntervalMs?:number|(()=>number);
  maximumWakeIntervalMs?:number|(()=>number);
  retryWakeMs?:number|(()=>number);
  idleWakeMs?:number|(()=>number);
}

type WakeRequest={reason:NovaLifeWakeReason;messageId?:string};

type LifeSubscriber=(state:NovaLifeState)=>void;

function cloneState(state:NovaLifeState):NovaLifeState{return {...state};}
function abortError():Error{const error=new Error("Nova Life stopped.");error.name="AbortError";return error;}

export class NovaLifeRuntime{
  private readonly listeners=new Set<LifeSubscriber>();
  private readonly eventUnsubscribers:Array<()=>void>=[];
  private readonly clock:()=>string;
  private readonly retryWakeMs:number|(()=>number);
  private readonly idleWakeMs:number|(()=>number);
  private state:NovaLifeState={status:"off",wakeCount:0};
  private timer?:ReturnType<typeof setTimeout>;
  private timerEpoch=0;
  private activeWake?:Promise<void>;
  private pendingWake?:WakeRequest;
  private eventTimer?:ReturnType<typeof setTimeout>;
  private pendingEventWake?:WakeRequest;
  private wakeSequence=0;
  private consecutiveFailures=0;
  private currentWakeStartedAt?:number;
  private currentContextStats:{contextMessageCount:number;memoryCandidates:number;coreBookCandidates:number;retrievalCandidates:number}={contextMessageCount:0,memoryCandidates:0,coreBookCandidates:0,retrievalCandidates:0};

  constructor(private readonly options:NovaLifeRuntimeOptions){
    this.clock=options.clock?.now?()=>options.clock!.now():()=>new Date().toISOString();
    this.retryWakeMs=options.retryWakeMs??10000;
    this.idleWakeMs=options.idleWakeMs??0;
  }

  getState():NovaLifeState{return cloneState(this.state);}
  isOn():boolean{return this.state.status!=="off"&&this.state.status!=="stopping";}
  subscribe(listener:LifeSubscriber):()=>void{
    this.listeners.add(listener);
    listener(this.getState());
    return ()=>{this.listeners.delete(listener)};
  }

  async start(characterId:string,conversationId:string):Promise<NovaLifeState>{
    if(this.isOn())throw new Error("Nova Life is already running.");
    if(!characterId.trim())throw new Error("Nova Life characterId must not be empty.");
    if(!conversationId.trim())throw new Error("Nova Life conversationId must not be empty.");
    this.clearTimer();
    this.clearEventTimer();
    this.pendingWake=undefined;
    this.pendingEventWake=undefined;
    this.consecutiveFailures=0;
    this.state={status:"starting",characterId,conversationId,startedAt:this.clock(),wakeReason:"startup",wakeCount:0};
    this.notify();
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_STARTED","Nova Life started",{characterId,conversationId});
    this.subscribeToRuntimeEvents();
    await this.options.events.publish(createEvent("NovaLifeStarted",{characterId,conversationId},"nova-life",this.clock,"nova-life:started:"+Date.now().toString(36)));
    await this.triggerWake({reason:"startup"});
    return this.getState();
  }

  async stop():Promise<NovaLifeState>{
    if(this.state.status==="off")return this.getState();
    this.timerEpoch++;
    this.clearTimer();
    this.clearEventTimer();
    this.pendingWake=undefined;
    this.pendingEventWake=undefined;
    const runId=this.state.activeAgentRunId;
    this.state={...this.state,status:"stopping",nextWakeAt:undefined,activeAgentRunId:undefined};
    this.notify();

    if(runId){
      try{await this.options.agentKernel.interrupt(runId,"Nova Life stopped by user.");}catch{}
    }
    try{await this.activeWake;}catch{}
    this.unsubscribeFromRuntimeEvents();
    const previous=this.getState();
    this.state={...previous,status:"off",activeAgentRunId:undefined,nextWakeAt:undefined};
    this.notify();
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_STOPPED","Nova Life stopped",{
      ...(previous.characterId?{characterId:previous.characterId}:{}),
      ...(previous.conversationId?{conversationId:previous.conversationId}:{}),
    });
    await this.options.events.publish(createEvent("NovaLifeStopped",{
      ...(previous.characterId?{characterId:previous.characterId}:{}),
      ...(previous.conversationId?{conversationId:previous.conversationId}:{}),
    },"nova-life",this.clock,"nova-life:stopped:"+Date.now().toString(36)));
    return this.getState();
  }

  async wake(reason:NovaLifeWakeReason="runtime_event"):Promise<NovaLifeState>{
    if(!this.isOn())return this.getState();
    await this.triggerWake({reason});
    return this.getState();
  }

  notifyUserMessage(characterId:string,conversationId:string,messageId:string):void{
    if(!this.isOn())return;
    if(characterId!==this.state.characterId||conversationId!==this.state.conversationId)return;
    this.state={...this.state,lastActivityAt:this.clock()};
    this.notify();
    void this.triggerWake({reason:"user_message",messageId}).catch(error=>this.handleRuntimeError(error));
  }

  private subscribeToRuntimeEvents():void{
    this.unsubscribeFromRuntimeEvents();
    this.eventUnsubscribers.push(this.options.events.subscribe("UserMessageReceived",event=>{
      const payload=event.payload as {characterId:string;conversationId:string;messageId:string};
      this.notifyUserMessage(payload.characterId,payload.conversationId,payload.messageId);
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("ActiveConversationChanged",event=>{
      const payload=event.payload as {characterId:string;conversationId:string};
      if(!this.isOn()||payload.characterId!==this.state.characterId)return;
      const policy=this.options.eventWakePolicy?.();
      this.state={...this.state,conversationId:payload.conversationId,lastActivityAt:this.clock()};
      this.notify();
      if(policy?.conversationChanged!==false)this.queueEventWake({reason:"conversation_changed"});
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("ActiveCharacterChanged",event=>{
      const payload=event.payload as {characterId:string};
      if(!this.isOn())return;
      const policy=this.options.eventWakePolicy?.();
      if(policy?.characterChanged===false)return;
      void this.followCharacter(payload.characterId).catch(error=>this.handleRuntimeError(error));
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("AppChanged",()=>{
      const policy=this.options.eventWakePolicy?.();
      if(this.isOn()&&policy?.appChanged===true)this.queueEventWake({reason:"runtime_event"});
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("WindowChanged",()=>{
      const policy=this.options.eventWakePolicy?.();
      if(this.isOn()&&policy?.windowChanged===true)this.queueEventWake({reason:"runtime_event"});
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("AgentStateChanged",event=>{
      const payload=event.payload as {runId:string;state:string};
      if(payload.runId!==this.state.activeAgentRunId||!this.isOn())return;
      if(payload.state==="thinking"||payload.state==="planning")this.setStatus("thinking");
      else if(payload.state==="acting")this.setStatus("acting");
    }));
  }

  private unsubscribeFromRuntimeEvents():void{
    while(this.eventUnsubscribers.length>0)this.eventUnsubscribers.pop()!();
  }

  private async followCharacter(characterId:string):Promise<void>{
    if(!this.isOn()||!characterId.trim())return;
    const conversation=await this.options.conversationManager.getActiveConversation(characterId);
    this.state={...this.state,characterId,conversationId:conversation.id,lastActivityAt:this.clock()};
    this.notify();
    this.queueEventWake({reason:"character_changed"});
  }

  private async triggerWake(request:WakeRequest):Promise<void>{
    if(!this.isOn())return;
    this.clearTimer();
    if(request.reason==="user_message")this.clearEventTimer();
    if(this.activeWake){
      this.pendingWake=this.mergeWake(this.pendingWake,request);
      return this.activeWake;
    }
    const wake=this.executeWake(request);
    this.activeWake=wake;
    try{await wake}
    finally{
      if(this.activeWake===wake)this.activeWake=undefined;
      const pending=this.pendingWake;
      this.pendingWake=undefined;
      if(pending&&this.isOn())void this.triggerWake(pending).catch(error=>this.handleRuntimeError(error));
    }
  }

  private async executeWake(request:WakeRequest):Promise<void>{
    const characterId=this.state.characterId,conversationId=this.state.conversationId;
    if(!characterId||!conversationId)return;
    const wakeCount=++this.wakeSequence;
    this.currentWakeStartedAt=Date.now();
    this.currentContextStats={contextMessageCount:0,memoryCandidates:0,coreBookCandidates:0,retrievalCandidates:0};
    this.state={...this.state,status:"awake",wakeReason:request.reason,lastWakeAt:this.clock(),nextWakeAt:undefined,activeAgentRunId:undefined,currentFocus:undefined,wakeCount};
    this.notify();
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_WAKE_STARTED","Nova Life wake started",{
      characterId,conversationId,wakeCount,reason:request.reason
    });
    await this.options.events.publish(createEvent("NovaLifeWakeStarted",{
      characterId,conversationId,wakeCount,reason:request.reason,agentRunId:"pending"
    },"nova-life",this.clock,"nova-life:wake-started:"+wakeCount));

    let run:AgentRun|undefined;
    let terminal:AgentRun|undefined;
    try{
      const providerId=this.options.resolveProviderId();
      const model=await this.options.resolveModel(providerId);
      const task=this.taskFor(request.reason);
      const input:AgentRunInput={
        id:"nova-life:"+Date.now().toString(36)+":"+wakeCount,
        characterId,
        conversationId,
        goal:"Respond naturally as Nova within the current life context.",
        task,
        wakeReason:request.reason,
        ...(providerId?{providerId}:{}),
        ...(model?{model}: {}),
        limits:this.options.resolveAgentRunLimits?.()
      };
      run=await this.options.agentKernel.createRun(input);
      this.state={...this.state,status:"thinking",activeAgentRunId:run.id,currentFocus:task};
      this.notify();
      terminal=await this.options.agentKernel.run(run.id,{
        contextProvider:(_currentRun,_stepIndex,previousRuntimeMessages)=>this.buildContextMessages(request.reason,run!.id,previousRuntimeMessages)
      });
      await this.handleTerminalRun(terminal,request.reason,request.messageId);
      if(terminal.state!=="failed")this.consecutiveFailures=0;
      this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_WAKE_COMPLETED","Nova Life wake completed",{
        characterId,conversationId,wakeCount,reason:request.reason,agentRunId:terminal.id,status:terminal.status,
        durationMs:this.currentWakeStartedAt===undefined?null:Math.max(0,Date.now()-this.currentWakeStartedAt),
        steps:terminal.stepCount,llmCalls:terminal.modelCallCount,provider:terminal.providerId??"default",model:terminal.model??"",
        contextMessageCount:this.currentContextStats.contextMessageCount,memoryCandidates:this.currentContextStats.memoryCandidates,
        coreBookCandidates:this.currentContextStats.coreBookCandidates,retrievalCandidates:this.currentContextStats.retrievalCandidates,
        decisions:this.options.agentKernel.getSteps(terminal.id).map(step=>step.decisionType),
        toolCalls:this.options.agentKernel.getSteps(terminal.id).filter(step=>step.decisionType==="tool_call").length,
        toolResults:this.options.agentKernel.getSteps(terminal.id).filter(step=>step.outcome==="tool_called").length,
        finalResponse:terminal.lastAction==="respond"?(terminal.workingSummary??null):null,nextWake:this.state.nextWakeAt??null,
        lastAction:terminal.lastAction??null,lastOutcome:terminal.lastOutcome??null
      });
      await this.options.events.publish(createEvent("NovaLifeWakeCompleted",{
        characterId,conversationId,wakeCount,reason:request.reason,agentRunId:terminal.id,status:terminal.status
      },"nova-life",this.clock,"nova-life:wake-completed:"+wakeCount));
    }catch(error){
      this.handleRuntimeError(error,run?.id);
      await this.options.events.publish(createEvent("NovaLifeWakeCompleted",{
        characterId,conversationId,wakeCount,reason:request.reason,...(run?{agentRunId:run.id}:{}),status:"failed"
      },"nova-life",this.clock,"nova-life:wake-completed-failed:"+wakeCount));
    }
  }

  private async buildContextMessages(reason:NovaLifeWakeReason,agentRunId:string,previousRuntimeMessages:readonly ChatMessage[]):Promise<readonly ChatMessage[]>{
    const characterId=this.state.characterId,conversationId=this.state.conversationId;
    if(!characterId||!conversationId)throw abortError();
    const conversation=await this.options.conversationManager.getConversation(characterId,conversationId);
    if(!conversation)throw new Error("Nova Life conversation was not found.");
    const lifeContext:ChatMessage={
      id:"nova-life-context:"+this.state.wakeCount+":"+agentRunId,
      role:"system",
      content:JSON.stringify({
        novaLife:{
          status:this.state.status,
          characterId,
          conversationId,
          wakeCount:this.state.wakeCount,
          wakeReason:reason,
          lastWakeAt:this.state.lastWakeAt??null,
          nextWakeAt:this.state.nextWakeAt??null,
          lastAction:this.state.lastAction??null,
          lastOutcome:this.state.lastOutcome??null,
          lastActivityAt:this.state.lastActivityAt??null
        }
      }),
      metadata:{contextSource:"nova_life",wakeReason:reason}
    };
    const assembled=await this.options.contextEngine.build({
      apiVersion:"1",schemaVersion:"1",characterId,conversationId,
      messages:[lifeContext,...conversation.messages,...previousRuntimeMessages],
      budget:this.options.contextBudget()
    });
    this.currentContextStats={
      contextMessageCount:assembled.messages.length,
      memoryCandidates:assembled.includedCandidates.filter(candidate=>candidate.source==="memory").length,
      coreBookCandidates:assembled.includedCandidates.filter(candidate=>candidate.source==="core_book").length,
      retrievalCandidates:assembled.includedCandidates.filter(candidate=>candidate.zone==="retrieved_core_book"||candidate.zone==="retrieved_memory").length
    };
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_CONTEXT_BUILT","Nova Life context assembled",{
      characterId,conversationId,wakeReason:reason,contextMessageCount:assembled.messages.length,
      memoryCandidates:this.currentContextStats.memoryCandidates,
      coreBookCandidates:this.currentContextStats.coreBookCandidates,retrievalCandidates:this.currentContextStats.retrievalCandidates,
      contextSources:["conversation","memory","core_book","life_state","wake_reason"]
    });
    return assembled.messages;
  }

  private async handleTerminalRun(run:AgentRun,reason:NovaLifeWakeReason,messageId?:string):Promise<void>{
    if(!this.isOn())return;
    this.state={
      ...this.state,
      activeAgentRunId:undefined,
      currentFocus:undefined,
      lastAction:run.lastAction,
      lastOutcome:run.lastOutcome,
      lastActivityAt:this.clock()
    };
    this.notify();

    if(run.state==="interrupted"){
      this.setWaiting();
      return;
    }
    if(run.state==="failed"){
      const category=run.lastErrorCategory??"runtime";
      this.state={...this.state,status:"error",lastOutcome:run.lastOutcome??"Cognition failed."};
      this.notify();
      await this.options.events.publish(createEvent("NovaLifeError",{
        characterId:this.state.characterId,
        conversationId:this.state.conversationId,
        reason:run.lastOutcome??"Cognition failed.",
        agentRunId:run.id,
        category,
        wakeCount:this.state.wakeCount,
        step:run.stepCount+1,
        provider:run.providerId??"default",
        model:run.model??""
      },"nova-life",this.clock,"nova-life:error:"+run.id));
      if(category==="protocol_model_output"||category==="budget"||category==="runtime"){
        this.setWaiting();
        return;
      }
      this.consecutiveFailures++;
      const configuredLimits=this.options.resolveAgentRunLimits?.()??{};
      const maxFailures=Math.max(1,configuredLimits.maxConsecutiveFailures??3);
      if(category==="rate_limit"||category==="timeout"||category==="network"||category==="server"||category==="transient_provider"){
        if(this.consecutiveFailures>maxFailures){
          this.setWaiting();
          return;
        }
        const base=this.resolveDelay(this.retryWakeMs,10000);
        const delay=Math.min(this.maximumWakeInterval(),base*Math.pow(2,this.consecutiveFailures-1));
        this.scheduleWake(delay,"retry");
      }else{
        this.setWaiting();
      }
      return;
    }
    if(run.lastAction==="respond"){
      if(run.stepCount<=1&&!this.allowsProactive(reason)){this.setWaiting();return;}
      const result=run.workingSummary?.trim();
      if(!result){
        this.state={...this.state,status:"error",lastOutcome:"Cognition finished without a user-facing result."};
        this.notify();
        this.setWaiting();
        return;
      }
      const assistant=await this.appendAssistant(run.id,result,false);
      await this.extractMemoryForUserMessage(run,messageId,assistant);
      const idleWakeMs=typeof this.idleWakeMs==="function"?this.idleWakeMs():this.idleWakeMs;
      if(typeof idleWakeMs==="number"&&Number.isFinite(idleWakeMs)&&idleWakeMs>0)this.scheduleWake(idleWakeMs,"scheduled_wake");
      else this.setWaiting();
      return;
    }
    if(run.lastAction==="ask_user"){
      if(!this.allowsProactive(reason)){this.setWaiting();return;}
      const question=this.extractWaitingText(run);
      if(question){
        const assistant=await this.appendAssistant(run.id,question,true);
        await this.extractMemoryForUserMessage(run,messageId,assistant);
      }
      this.setWaiting();
      return;
    }
    if(run.lastAction==="wait"){
      const defaultWaitMs=this.resolveDelay(this.options.defaultWaitMs,30000);
      this.scheduleWake(this.normalizeDelay(run.lastWaitMs??defaultWaitMs),"wait_completed");
      return;
    }
    this.setWaiting();
  }

  private allowsProactive(reason:NovaLifeWakeReason):boolean{
    if(reason==="user_message")return true;
    if(this.options.proactiveEnabled?.()===false||this.options.allowProactiveMessages?.()===false)return false;
    if(reason==="startup"&&this.options.startupBehavior?.()==="wait")return false;
    return true;
  }

  private async appendAssistant(agentRunId:string,content:string,isQuestion:boolean):Promise<ChatMessage>{
    const characterId=this.state.characterId,conversationId=this.state.conversationId;
    if(!characterId||!conversationId)throw abortError();
    const conversation=await this.options.conversationManager.getConversation(characterId,conversationId);
    if(!conversation)throw new Error("Nova Life conversation was not found.");
    const id="nova-life:"+agentRunId+":assistant";
    const existing=conversation.messages.find(message=>message.id===id);
    if(existing)return existing;
    const message:ChatMessage={
      id,role:"assistant",content,
      metadata:{streamStatus:"complete",novaLife:true,agentRunId,...(isQuestion?{agentMessageType:"question"}:{})}
    };
    await this.options.conversationManager.updateConversation(characterId,conversationId,{messages:[...conversation.messages,message]});
    this.state={...this.state,lastAction:isQuestion?"ask_user":"respond",lastOutcome:isQuestion?"waiting:"+content:"completed:"+content.slice(0,1000)};
    this.notify();
    return message;
  }

  private async extractMemoryForUserMessage(run:AgentRun,messageId:string|undefined,assistantMessage:ChatMessage):Promise<void>{
    if(!messageId||!this.options.extractMemory||(this.options.memoryExtractionEnabled?.()??true)===false)return;
    const characterId=this.state.characterId,conversationId=this.state.conversationId;
    if(!characterId||!conversationId)return;
    try{
      const conversation=await this.options.conversationManager.getConversation(characterId,conversationId);
      const userMessage=conversation?.messages.find(message=>message.id===messageId&&message.role==="user");
      if(!userMessage)return;
      const limit=Math.max(1,Math.min(32,this.options.recentConversationMessages?.()??8));
      const contextMessages=(conversation?.messages??[]).filter(message=>message.metadata?.contextSource===undefined||message.metadata?.contextSource==="conversation").slice(-limit).map(message=>({...message,...(message.metadata?{metadata:{...message.metadata}}:{})}));
      const request:MemoryExtractionRequest={
        apiVersion:"1",schemaVersion:"1",characterId,conversationId,turnId:run.id,
        model:run.model??"",providerId:run.providerId??"unknown",
        ...(this.options.getProviderPresetId?.()?{providerPresetId:this.options.getProviderPresetId()}:{}),
        userMessage:{...userMessage,...(userMessage.metadata?{metadata:{...userMessage.metadata}}:{})},
        assistantMessage:{...assistantMessage,...(assistantMessage.metadata?{metadata:{...assistantMessage.metadata}}:{})},
        contextMessages
      };
      void Promise.resolve(this.options.extractMemory(request)).catch(()=>undefined);
    }catch(error){
      this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_MEMORY_EXTRACTION_FAILED","Nova Life memory extraction could not be started.",{
        characterId,conversationId,error:error instanceof Error?error.message:String(error)
      });
    }
  }

  private extractWaitingText(run:AgentRun):string|undefined{
    const outcome=run.lastOutcome??"";
    if(!outcome.startsWith("waiting:"))return undefined;
    const value=outcome.slice("waiting:".length).trim();
    return value||undefined;
  }

  private taskFor(reason:NovaLifeWakeReason):string{
    switch(reason){
      case "user_message":return "Respond to the latest user message using the current conversation, memory, Core Book, retrieval, and life state. Do not ask for information that is already reasonably available."; 
      case "wait_completed":return "Re-evaluate the current life context after the scheduled wait. Speak only when there is a useful user-facing reason; otherwise choose wait."; 
      case "scheduled_wake":return "Re-evaluate the current life context at the scheduled wake. Speak only when there is a useful user-facing reason; otherwise choose wait."; 
      case "retry":return "Retry the current life cognition after a controlled failure. Re-check the current context before deciding what to do."; 
      case "startup":{
        const proactive=this.options.proactiveEnabled?.()!==false&&this.options.allowProactiveMessages?.()!==false;
        const behavior=this.options.startupBehavior?.()??"wait";
        const defaultWaitMs=this.resolveDelay(this.options.defaultWaitMs,30000);
        return behavior==="proactive"&&proactive
          ? "Evaluate the current life context now that Nova has been turned on. A useful proactive message is allowed; otherwise choose wait. Default scheduled wait is "+defaultWaitMs+"ms."
          : "Nova has just been turned on. Do not send a generic greeting. Choose wait unless there is a specific useful proactive reason. Default scheduled wait is "+defaultWaitMs+"ms.";
      }
      case "conversation_changed":return "Evaluate the newly active conversation and decide whether Nova should respond proactively or wait."; 
      case "character_changed":return "Evaluate the newly active Character context and continue Nova's life naturally."; 
      case "runtime_event":return "Evaluate the current runtime event and decide whether Nova should respond, act internally, or wait."; 
    }
  }

  private scheduleWake(delayMs:number,reason:NovaLifeWakeReason):void{
    if(!this.isOn())return;
    const delay=this.clampWakeDelay(delayMs);
    this.clearTimer();
    const nextWakeAt=new Date(Date.parse(this.clock())+delay).toISOString();
    const epoch=++this.timerEpoch;
    this.state={...this.state,status:"sleeping",nextWakeAt,wakeReason:reason,activeAgentRunId:undefined};
    this.notify();
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_SLEEPING","Nova Life scheduled next wake",{
      characterId:this.state.characterId!,conversationId:this.state.conversationId!,nextWakeAt,reason,delayMs:delay,wakeCount:this.state.wakeCount
    });
    void this.options.events.publish(createEvent("NovaLifeSleeping",{
      characterId:this.state.characterId!,conversationId:this.state.conversationId!,nextWakeAt,reason
    },"nova-life",this.clock,"nova-life:sleeping:"+epoch)).catch(()=>undefined);
    this.timer=setTimeout(()=>{
      if(epoch!==this.timerEpoch||!this.isOn())return;
      this.timer=undefined;
      void this.triggerWake({reason}).catch(error=>this.handleRuntimeError(error));
    },delay);
  }

  private setWaiting():void{
    if(!this.isOn())return;
    this.clearTimer();
    this.state={...this.state,status:"waiting",nextWakeAt:undefined,activeAgentRunId:undefined};
    this.notify();
  }

  private setStatus(status:NovaLifeStatus):void{
    if(!this.isOn()||this.state.status===status)return;
    this.state={...this.state,status};
    this.notify();
  }

  private clearTimer():void{
    this.timerEpoch++;
    if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
  }

  private handleRuntimeError(error:unknown,agentRunId?:string):void{
    if(!this.isOn())return;
    const message=error instanceof Error?error.message:String(error);
    this.state={...this.state,status:"error",lastOutcome:message,activeAgentRunId:undefined};
    this.notify();
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_RUNTIME_ERROR","Nova Life runtime error",{
      message,agentRunId,wakeCount:this.state.wakeCount,errorCategory:"runtime"
    });
    void this.options.events.publish(createEvent("NovaLifeError",{
      ...(this.state.characterId?{characterId:this.state.characterId}:{}),
      ...(this.state.conversationId?{conversationId:this.state.conversationId}:{}),
      reason:message,
      ...(agentRunId?{agentRunId}: {}),
      wakeCount:this.state.wakeCount,
      category:"runtime"
    },"nova-life",this.clock,"nova-life:runtime-error:"+Date.now())).catch(()=>undefined);
    this.setWaiting();
  }

  private notify():void{
    const snapshot=this.getState();
    for(const listener of [...this.listeners]){
      try{listener(snapshot)}catch{}
    }
  }

  private queueEventWake(request:WakeRequest):void{
    if(!this.isOn())return;
    this.pendingEventWake=this.mergeWake(this.pendingEventWake,request);
    if(this.eventTimer)return;
    const debounce=this.resolveDelay(this.options.eventDebounceMs,250);
    const minInterval=this.minimumWakeInterval();
    const lastWake=this.state.lastWakeAt?Date.parse(this.state.lastWakeAt):0;
    const elapsed=lastWake>0?Math.max(0,Date.now()-lastWake):Number.POSITIVE_INFINITY;
    const cooldown=Math.max(0,minInterval-elapsed);
    const delay=Math.max(debounce,cooldown);
    this.eventTimer=setTimeout(()=>{
      this.eventTimer=undefined;
      const next=this.pendingEventWake;
      this.pendingEventWake=undefined;
      if(next&&this.isOn())void this.triggerWake(next).catch(error=>this.handleRuntimeError(error));
    },delay);
  }

  private clearEventTimer():void{
    if(this.eventTimer){clearTimeout(this.eventTimer);this.eventTimer=undefined;}
    this.pendingEventWake=undefined;
  }

  private mergeWake(current:WakeRequest|undefined,next:WakeRequest):WakeRequest{
    if(!current)return next;
    const rank=(reason:NovaLifeWakeReason)=>reason==="user_message"?100:reason==="conversation_changed"?80:reason==="character_changed"?70:reason==="scheduled_wake"?60:reason==="wait_completed"?50:20;
    return rank(next.reason)>=rank(current.reason)?next:current;
  }

  private resolveDelay(value:number|(()=>number)|undefined,fallback:number):number{
    const resolved=typeof value==="function"?value():value;
    return this.normalizeDelay(typeof resolved==="number"&&Number.isFinite(resolved)?resolved:fallback);
  }

  private minimumWakeInterval():number{
    const value=this.resolveDelay(this.options.minimumWakeIntervalMs,1000);
    return Math.min(value,this.maximumWakeInterval());
  }

  private maximumWakeInterval():number{
    const raw=typeof this.options.maximumWakeIntervalMs==="function"?this.options.maximumWakeIntervalMs():this.options.maximumWakeIntervalMs;
    const value=Number.isFinite(raw as number)?Math.max(1,Math.floor(raw as number)):300000;
    return Math.max(this.minimumBaseWakeInterval(),Math.min(3600000,value));
  }

  private minimumBaseWakeInterval():number{
    const raw=typeof this.options.minimumWakeIntervalMs==="function"?this.options.minimumWakeIntervalMs():this.options.minimumWakeIntervalMs;
    return Number.isFinite(raw as number)?Math.max(1,Math.floor(raw as number)):1000;
  }

  private clampWakeDelay(value:number):number{
    const normalized=Number.isFinite(value)&&value>=1?Math.floor(value):1;
    return Math.min(this.maximumWakeInterval(),Math.max(this.minimumBaseWakeInterval(),normalized));
  }

  private normalizeDelay(value:number):number{
    if(!Number.isFinite(value)||value<1)return 1;
    return Math.min(300000,Math.floor(value));
  }
}
