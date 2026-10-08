import type {AgentDecision,AgentRun,AgentRunInput,AgentRunLimits,ChatMessage,Clock,ContextBudget,ContextEngine,DiagnosticsStore,EventBus,MemoryExtractionRequest} from "../../contracts/src/index";
import {createEvent} from "../../contracts/src/index";
import type {ConversationManager} from "./conversation-manager";
import type {AgentKernel} from "./agent-kernel";
import type {NovaAutonomyCore,NovaAutonomyState,NovaGoal,NovaIntent,NovaPendingActivity} from "./nova-autonomy-core";

export type NovaLifeStatus="off"|"starting"|"thinking"|"acting"|"idle"|"stopping"|"error";
export type NovaLifeWakeReason="startup"|"user_message"|"intent_due"|"tool_result"|"runtime_event";
export interface NovaLifeState{
  status:NovaLifeStatus;
  characterId?:string;
  conversationId?:string;
  startedAt?:string;
  lastWakeAt?:string;
  wakeReason?:NovaLifeWakeReason;
  trigger?:NovaLifeWakeReason;
  activeAgentRunId?:string;
  currentFocus?:string|null;
  activeIntentions?:readonly NovaIntent[];
  activeGoals?:readonly NovaGoal[];
  pendingActivities?:readonly NovaPendingActivity[];
  lastMeaningfulInteraction?:string|null;
  lastDecisionAt?:string|null;
  nextRelevantDeadline?:string|null;
  lastAction?:AgentDecision;
  lastOutcome?:string;
  lastActivityAt?:string;
  lastDecision?:AgentDecision;
  lastToolName?:string;
  toolCallCount?:number;
  pendingTriggers?:readonly NovaLifeWakeReason[];
  wakeCount:number;
}
export interface NovaLifeRuntimeOptions{
  agentKernel:AgentKernel;
  autonomy:NovaAutonomyCore;
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
}
type WakeRequest={reason:NovaLifeWakeReason;messageId?:string};
type LifeSubscriber=(state:NovaLifeState)=>void;
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value)) as T}
function abortError(){const e=new Error("Nova Life stopped.");e.name="AbortError";return e}

export class NovaLifeRuntime{
  private readonly listeners=new Set<LifeSubscriber>();
  private readonly eventUnsubscribers:Array<()=>void>=[];
  private readonly clock:()=>string;
  private state:NovaLifeState={status:"off",wakeCount:0};
  private deadlineTimer?:ReturnType<typeof setTimeout>;
  private deadlineEpoch=0;
  private activeWake?:Promise<void>;
  private pendingWake?:WakeRequest;
  private wakeSequence=0;

  constructor(private readonly options:NovaLifeRuntimeOptions){
    this.clock=options.clock?()=>options.clock!.now():()=>new Date().toISOString();
  }
  getState(){return clone(this.state)}
  isOn(){return this.state.status!=="off"&&this.state.status!=="stopping"}
  subscribe(listener:LifeSubscriber){this.listeners.add(listener);listener(this.getState());return ()=>this.listeners.delete(listener)}

  async start(characterId:string,conversationId:string){
    if(this.isOn())throw new Error("Nova Life is already running.");
    if(!characterId.trim()||!conversationId.trim())throw new Error("Nova Life requires characterId and conversationId.");
    this.clearDeadline();this.pendingWake=undefined;await this.options.autonomy.initialize(characterId);
    this.state=this.withAutonomy({status:"starting",characterId,conversationId,startedAt:this.clock(),wakeReason:"startup",trigger:"startup",wakeCount:0},this.options.autonomy.getState());
    this.notify();this.subscribeToEvents();
    await this.options.events.publish(createEvent("NovaLifeStarted",{characterId,conversationId},"nova-life",this.clock,"nova-life:started:"+Date.now().toString(36)));
    await this.triggerWake({reason:"startup"});
    return this.getState();
  }

  async stop(){
    if(this.state.status==="off")return this.getState();
    this.clearDeadline();this.pendingWake=undefined;
    const runId=this.state.activeAgentRunId;
    const previous=this.state;
    this.state={...this.state,status:"stopping",activeAgentRunId:undefined};this.notify();
    if(runId){try{await this.options.agentKernel.interrupt(runId,"Nova Life stopped by user.")}catch{}}
    try{await this.activeWake}catch{}
    this.unsubscribeFromEvents();
    this.state={...this.state,status:"off",activeAgentRunId:undefined};this.notify();
    await this.options.events.publish(createEvent("NovaLifeStopped",{...(previous.characterId?{characterId:previous.characterId}:{}),...(previous.conversationId?{conversationId:previous.conversationId}:{})},"nova-life",this.clock,"nova-life:stopped:"+Date.now().toString(36)));
    return this.getState();
  }

  async wake(reason:NovaLifeWakeReason="runtime_event"){if(!this.isOn())return this.getState();await this.triggerWake({reason});return this.getState()}

  notifyUserMessage(characterId:string,conversationId:string,messageId:string){
    if(!this.isOn()||characterId!==this.state.characterId||conversationId!==this.state.conversationId)return;
    void this.options.autonomy.noteEvent("user_message").then(s=>{
      this.applyAutonomy(s);this.clearDeadline();return this.triggerWake({reason:"user_message",messageId})
    }).catch(error=>this.handleRuntimeError(error));
  }

  notifyToolResult(runId:string){
    if(!this.isOn()||runId===this.state.activeAgentRunId)return;
    void this.options.autonomy.noteEvent("tool_result").then(s=>{
      this.applyAutonomy(s);return this.triggerWake({reason:"tool_result"})
    }).catch(error=>this.handleRuntimeError(error));
  }

  private subscribeToEvents(){
    this.unsubscribeFromEvents();
    this.eventUnsubscribers.push(this.options.events.subscribe("UserMessageReceived",event=>{
      const payload=event.payload as {characterId:string;conversationId:string;messageId:string};
      this.notifyUserMessage(payload.characterId,payload.conversationId,payload.messageId);
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("ToolResultReceived",event=>{
      this.notifyToolResult((event.payload as {runId:string}).runId);
    }));
    for(const type of ["GoalCreated","GoalCompleted","GoalFailed"] as const){
      this.eventUnsubscribers.push(this.options.events.subscribe(type,()=>{
        if(!this.isOn())return;
        void this.options.autonomy.noteEvent("runtime_event").then(s=>{
          this.applyAutonomy(s);return this.triggerWake({reason:"runtime_event"})
        }).catch(error=>this.handleRuntimeError(error));
      }));
    }
    this.eventUnsubscribers.push(this.options.events.subscribe("ActiveConversationChanged",event=>{
      const payload=event.payload as {characterId:string;conversationId:string};
      if(!this.isOn()||payload.characterId!==this.state.characterId)return;
      this.state={...this.state,conversationId:payload.conversationId};this.notify();
      void this.options.autonomy.noteEvent("runtime_event").then(s=>{
        this.applyAutonomy(s);return this.triggerWake({reason:"runtime_event"})
      }).catch(error=>this.handleRuntimeError(error));
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("ActiveCharacterChanged",event=>{
      if(!this.isOn())return;
      void this.followCharacter((event.payload as {characterId:string}).characterId).catch(error=>this.handleRuntimeError(error));
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("AgentStateChanged",event=>{
      const payload=event.payload as {runId:string;state:string};
      if(payload.runId!==this.state.activeAgentRunId||!this.isOn())return;
      if(payload.state==="thinking"||payload.state==="planning")this.setStatus("thinking");
      else if(payload.state==="acting")this.setStatus("acting");
    }));
  }

  private async followCharacter(characterId:string){
    if(!characterId.trim())return;
    const conversation=await this.options.conversationManager.getActiveConversation(characterId);
    const autonomy=await this.options.autonomy.initialize(characterId);
    this.state=this.withAutonomy({...this.state,characterId,conversationId:conversation.id},autonomy);this.notify();
    await this.triggerWake({reason:"runtime_event"});
  }

  private unsubscribeFromEvents(){while(this.eventUnsubscribers.length>0)this.eventUnsubscribers.pop()!()}

  private async triggerWake(request:WakeRequest){
    if(!this.isOn())return;
    if(this.activeWake){this.pendingWake=this.mergeWake(this.pendingWake,request);return this.activeWake}
    const wake=this.executeWake(request);this.activeWake=wake;
    try{await wake}
    finally{
      if(this.activeWake===wake)this.activeWake=undefined;
      const pending=this.pendingWake;this.pendingWake=undefined;
      if(pending&&this.isOn())void this.triggerWake(pending).catch(error=>this.handleRuntimeError(error));
    }
  }

  private async executeWake(request:WakeRequest){
    const characterId=this.state.characterId,conversationId=this.state.conversationId;
    if(!characterId||!conversationId)return;
    const wakeCount=++this.wakeSequence;
    this.clearDeadline();
    this.state={...this.state,status:"thinking",wakeReason:request.reason,trigger:request.reason,lastWakeAt:this.clock(),activeAgentRunId:undefined,wakeCount};
    this.notify();
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_WAKE_STARTED","Nova cognition triggered",{characterId,conversationId,trigger:request.reason,wakeCount});
    await this.options.events.publish(createEvent("NovaLifeWakeStarted",{characterId,conversationId,wakeCount,reason:request.reason,agentRunId:"pending"},"nova-life",this.clock,"nova-life:wake-started:"+wakeCount));
    let run:AgentRun|undefined;
    try{
      const providerId=this.options.resolveProviderId();
      const model=await this.options.resolveModel(providerId);
      const input:AgentRunInput={
        id:"nova-life:"+Date.now().toString(36)+":"+wakeCount,
        characterId,conversationId,
        goal:"Evaluate Nova's current life and continue a meaningful ongoing activity.",
        task:this.taskFor(request.reason),
        wakeReason:request.reason,
        ...(providerId?{providerId}:{}),...(model?{model}:{}),
        limits:this.options.resolveAgentRunLimits?.()
      };
      run=await this.options.agentKernel.createRun(input);
      this.state={...this.state,activeAgentRunId:run.id};this.notify();
      const terminal=await this.options.agentKernel.run(run.id,{
        contextProvider:(_run,_step,previousRuntimeMessages)=>this.buildContextMessages(request.reason,run!.id,previousRuntimeMessages),
        onDecision:(_run,decision)=>this.options.autonomy.applyDecision(decision).then(s=>this.applyAutonomy(s))
      });
      await this.handleTerminalRun(terminal,request.reason,request.messageId);
      this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_WAKE_COMPLETED","Nova cognition completed",{
        characterId,conversationId,wakeCount,trigger:request.reason,agentRunId:terminal.id,status:terminal.status,
        decision:terminal.lastDecision??terminal.lastAction??null,tools:terminal.toolCallCount,models:terminal.modelCallCount,
        activeIntentions:this.state.activeIntentions?.length??0,activeGoals:this.state.activeGoals?.length??0,
        pendingActivities:this.state.pendingActivities?.length??0,nextRelevantDeadline:this.state.nextRelevantDeadline??null
      });
      await this.options.events.publish(createEvent("NovaLifeWakeCompleted",{characterId,conversationId,wakeCount,reason:request.reason,agentRunId:terminal.id,status:terminal.status},"nova-life",this.clock,"nova-life:wake-completed:"+wakeCount));
    }catch(error){
      this.handleRuntimeError(error,run?.id);
      await this.options.events.publish(createEvent("NovaLifeWakeCompleted",{characterId,conversationId,wakeCount,reason:request.reason,...(run?{agentRunId:run.id}:{}),status:"failed"},"nova-life",this.clock,"nova-life:wake-failed:"+wakeCount));
    }
  }

  private async buildContextMessages(reason:NovaLifeWakeReason,agentRunId:string,previousRuntimeMessages:readonly ChatMessage[]){
    const characterId=this.state.characterId,conversationId=this.state.conversationId;
    if(!characterId||!conversationId)throw abortError();
    const conversation=await this.options.conversationManager.getConversation(characterId,conversationId);
    if(!conversation)throw new Error("Nova Life conversation was not found.");
    const autonomy=this.options.autonomy.getState();
    const system:ChatMessage={
      id:"nova-life-context:"+this.state.wakeCount+":"+agentRunId,
      role:"system",
      content:JSON.stringify({
        novaLife:{status:this.state.status,characterId,conversationId,trigger:reason,currentTime:this.clock(),
          currentFocus:autonomy.currentFocus,activeIntentions:autonomy.activeIntentions,activeGoals:autonomy.activeGoals,
          pendingActivities:autonomy.pendingActivities,lastMeaningfulInteraction:autonomy.lastMeaningfulInteraction,
          lastDecisionAt:autonomy.lastDecisionAt,nextRelevantDeadline:autonomy.nextRelevantDeadline,recentEvents:[reason]}
      }),
      metadata:{contextSource:"nova_life",trigger:reason}
    };
    const assembled=await this.options.contextEngine.build({
      apiVersion:"1",schemaVersion:"1",characterId,conversationId,
      messages:[system,...conversation.messages,...previousRuntimeMessages],budget:this.options.contextBudget()
    });
    return assembled.messages;
  }

  private async handleTerminalRun(run:AgentRun,reason:NovaLifeWakeReason,messageId?:string){
    if(!this.isOn())return;
    this.state={...this.state,activeAgentRunId:undefined,lastAction:run.lastDecision,lastDecision:run.lastDecision,lastToolName:run.lastToolName,toolCallCount:run.toolCallCount,lastOutcome:run.lastOutcome,lastActivityAt:this.clock(),lastDecisionAt:this.options.autonomy.getState().lastDecisionAt};
    this.applyAutonomy(this.options.autonomy.getState());
    if(run.state==="interrupted"){this.enterIdle();return}
    if(run.state==="failed"){
      await this.options.events.publish(createEvent("NovaLifeError",{characterId:this.state.characterId,conversationId:this.state.conversationId,reason:run.lastOutcome??"Cognition failed.",agentRunId:run.id,category:run.lastErrorCategory??"runtime",wakeCount:this.state.wakeCount},"nova-life",this.clock,"nova-life:error:"+run.id));
      this.enterIdle();return;
    }
    if(run.lastAction==="respond"){
      const allowed=reason==="user_message"||((this.options.proactiveEnabled?.()??true)&&(this.options.allowProactiveMessages?.()??true));
      const text=run.workingSummary?.trim();
      if(text&&allowed){const assistant=await this.appendAssistant(run.id,text,false);await this.extractMemoryForUserMessage(run,messageId,assistant)}
    }else if(run.lastAction==="ask_user"){
      const allowed=reason==="user_message"||((this.options.proactiveEnabled?.()??true)&&(this.options.allowProactiveMessages?.()??true));
      const question=this.extractWaitingText(run);
      if(question&&allowed){const assistant=await this.appendAssistant(run.id,question,true);await this.extractMemoryForUserMessage(run,messageId,assistant)}
    }
    this.enterIdle();
  }

  private enterIdle(){
    if(!this.isOn())return;
    this.clearDeadline();
    const autonomy=this.options.autonomy.getState();
    this.state=this.withAutonomy({...this.state,status:"idle",activeAgentRunId:undefined,pendingTriggers:this.pendingWake?[this.pendingWake.reason]:[]},autonomy);this.notify();
    void this.options.events.publish(createEvent("NovaLifeIdle",{characterId:this.state.characterId!,conversationId:this.state.conversationId!,nextRelevantDeadline:autonomy.nextRelevantDeadline,trigger:this.state.trigger??"runtime_event"},"nova-life",this.clock,"nova-life:idle:"+Date.now().toString(36))).catch(()=>undefined);
    this.armDeadline();
  }

  private armDeadline(){
    if(!this.isOn())return;
    this.clearDeadline();
    const deadline=this.options.autonomy.getState().nextRelevantDeadline;
    if(!deadline){this.state={...this.state,nextRelevantDeadline:null};this.notify();return}
    const due=Date.parse(deadline),now=Date.parse(this.clock());
    if(!Number.isFinite(due)||due<=now){void this.handleDeadline().catch(error=>this.handleRuntimeError(error));return}
    const epoch=++this.deadlineEpoch;
    this.state={...this.state,nextRelevantDeadline:deadline};this.notify();
    this.deadlineTimer=setTimeout(()=>{
      if(epoch!==this.deadlineEpoch||!this.isOn())return;
      this.deadlineTimer=undefined;
      void this.handleDeadline().catch(error=>this.handleRuntimeError(error));
    },Math.max(1,due-now));
  }

  private async handleDeadline(){
    if(!this.isOn())return;
    const due=this.options.autonomy.getDueIntentions(this.clock());
    if(due.length===0){this.armDeadline();return}
    const snapshot=await this.options.autonomy.markIntentTriggered(due.map(item=>item.id));
    this.applyAutonomy(snapshot);await this.triggerWake({reason:"intent_due"});
  }

  private async appendAssistant(agentRunId:string,content:string,isQuestion:boolean){
    const characterId=this.state.characterId,conversationId=this.state.conversationId;
    if(!characterId||!conversationId)throw abortError();
    const conversation=await this.options.conversationManager.getConversation(characterId,conversationId);
    if(!conversation)throw new Error("Nova Life conversation was not found.");
    const id="nova-life:"+agentRunId+":assistant";
    const existing=conversation.messages.find(message=>message.id===id);if(existing)return existing;
    const message:ChatMessage={id,role:"assistant",content,metadata:{streamStatus:"complete",novaLife:true,agentRunId,...(isQuestion?{agentMessageType:"question"}:{})}};
    await this.options.conversationManager.updateConversation(characterId,conversationId,{messages:[...conversation.messages,message]});
    return message;
  }

  private async extractMemoryForUserMessage(run:AgentRun,messageId:string|undefined,assistantMessage:ChatMessage){
    if(!messageId||!this.options.extractMemory||(this.options.memoryExtractionEnabled?.()??true)===false)return;
    const characterId=this.state.characterId,conversationId=this.state.conversationId;if(!characterId||!conversationId)return;
    try{
      const conversation=await this.options.conversationManager.getConversation(characterId,conversationId);
      const userMessage=conversation?.messages.find(message=>message.id===messageId&&message.role==="user");if(!userMessage)return;
      const limit=Math.max(1,Math.min(32,this.options.recentConversationMessages?.()??8));
      const contextMessages=(conversation?.messages??[]).filter(message=>message.metadata?.contextSource===undefined||message.metadata?.contextSource==="conversation").slice(-limit);
      const request:MemoryExtractionRequest={apiVersion:"1",schemaVersion:"1",characterId,conversationId,turnId:run.id,model:run.model??"",providerId:run.providerId??"unknown",...(this.options.getProviderPresetId?.()?{providerPresetId:this.options.getProviderPresetId()}:{}),userMessage,assistantMessage,contextMessages};
      void Promise.resolve(this.options.extractMemory(request)).catch(()=>undefined);
    }catch(error){
      this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_MEMORY_EXTRACTION_FAILED","Nova Life memory extraction could not be started.",{characterId,conversationId,error:error instanceof Error?error.message:String(error)});
    }
  }

  private taskFor(reason:NovaLifeWakeReason){
    if(reason==="user_message")return "Process the latest user message and continue relevant unfinished intentions when appropriate.";
    if(reason==="intent_due")return "A meaningful intention is due now. Evaluate the whole life state and continue, complete, update, or act on it when appropriate.";
    if(reason==="tool_result")return "A tool result arrived outside the current cognition turn. Evaluate it and continue the relevant unfinished activity.";
    if(reason==="runtime_event")return "A meaningful runtime event occurred. Evaluate the whole life state and decide whether useful action or continuation is warranted.";
    return "Nova has started Life. Evaluate identity, goals, intentions, unfinished activities and current events. Choose a meaningful next activity, speak when natural, or idle when nothing is worth doing now.";
  }

  private extractWaitingText(run:AgentRun){const value=(run.lastOutcome??"").startsWith("waiting:")?(run.lastOutcome??"").slice(8).trim():"";return value||undefined}
  private clearDeadline(){this.deadlineEpoch++;if(this.deadlineTimer){clearTimeout(this.deadlineTimer);this.deadlineTimer=undefined}}
  private setStatus(status:NovaLifeStatus){if(this.isOn()&&this.state.status!==status){this.state={...this.state,status};this.notify()}}
  private withAutonomy(state:NovaLifeState,a:NovaAutonomyState):NovaLifeState{return {...state,currentFocus:a.currentFocus,activeIntentions:a.activeIntentions,activeGoals:a.activeGoals,pendingActivities:a.pendingActivities,lastMeaningfulInteraction:a.lastMeaningfulInteraction,lastDecisionAt:a.lastDecisionAt,nextRelevantDeadline:a.nextRelevantDeadline}}
  private applyAutonomy(a:NovaAutonomyState){this.state=this.withAutonomy(this.state,a);this.notify()}
  private handleRuntimeError(error:unknown,agentRunId?:string){
    if(!this.isOn())return;
    this.state={...this.state,status:"error",activeAgentRunId:undefined,lastOutcome:error instanceof Error?error.message:String(error)};this.notify();
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_RUNTIME_ERROR","Nova Life runtime error",{message:this.state.lastOutcome,agentRunId,wakeCount:this.state.wakeCount});
    this.enterIdle();
  }
  private mergeWake(current:WakeRequest|undefined,next:WakeRequest){
    if(!current)return next;
    const rank=(reason:NovaLifeWakeReason)=>reason==="user_message"?100:reason==="intent_due"?90:reason==="tool_result"?80:50;
    return rank(next.reason)>=rank(current.reason)?next:current;
  }
  private notify(){const snapshot=this.getState();for(const listener of [...this.listeners]){try{listener(snapshot)}catch{}}}
}
