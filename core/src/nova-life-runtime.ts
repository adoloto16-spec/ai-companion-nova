import type {
  AgentRun,AgentDecisionAction,ChatMessage,Clock,ContextBudget,ContextEngine,DiagnosticsStore,EventBus,MemoryExtractionRequest,AgentRunInput
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
  retryWakeMs?:number;
  idleWakeMs?:number;
}

type WakeRequest={reason:NovaLifeWakeReason;messageId?:string};

type LifeSubscriber=(state:NovaLifeState)=>void;

function cloneState(state:NovaLifeState):NovaLifeState{return {...state};}
function abortError():Error{const error=new Error("Nova Life stopped.");error.name="AbortError";return error;}

export class NovaLifeRuntime{
  private readonly listeners=new Set<LifeSubscriber>();
  private readonly eventUnsubscribers:Array<()=>void>=[];
  private readonly clock:()=>string;
  private readonly retryWakeMs:number;
  private readonly idleWakeMs:number;
  private state:NovaLifeState={status:"off",wakeCount:0};
  private timer?:ReturnType<typeof setTimeout>;
  private timerEpoch=0;
  private activeWake?:Promise<void>;
  private pendingWake?:WakeRequest;
  private wakeSequence=0;

  constructor(private readonly options:NovaLifeRuntimeOptions){
    this.clock=options.clock?.now?()=>options.clock!.now():()=>new Date().toISOString();
    this.retryWakeMs=this.normalizeDelay(options.retryWakeMs??10000);
    this.idleWakeMs=options.idleWakeMs===undefined?0:this.normalizeDelay(options.idleWakeMs);
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
    this.pendingWake=undefined;
    this.state={status:"starting",characterId,conversationId,startedAt:this.clock(),wakeReason:"startup",wakeCount:0};
    this.notify();
    this.subscribeToRuntimeEvents();
    await this.options.events.publish(createEvent("NovaLifeStarted",{characterId,conversationId},"nova-life",this.clock,"nova-life:started:"+Date.now().toString(36)));
    await this.triggerWake({reason:"startup"});
    return this.getState();
  }

  async stop():Promise<NovaLifeState>{
    if(this.state.status==="off")return this.getState();
    this.timerEpoch++;
    this.clearTimer();
    this.pendingWake=undefined;
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
      this.state={...this.state,conversationId:payload.conversationId,lastActivityAt:this.clock()};
      this.notify();
      void this.triggerWake({reason:"conversation_changed"}).catch(error=>this.handleRuntimeError(error));
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("ActiveCharacterChanged",event=>{
      const payload=event.payload as {characterId:string};
      if(!this.isOn())return;
      void this.followCharacter(payload.characterId).catch(error=>this.handleRuntimeError(error));
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("AppChanged",()=>{
      if(this.isOn())void this.triggerWake({reason:"runtime_event"}).catch(error=>this.handleRuntimeError(error));
    }));
    this.eventUnsubscribers.push(this.options.events.subscribe("WindowChanged",()=>{
      if(this.isOn())void this.triggerWake({reason:"runtime_event"}).catch(error=>this.handleRuntimeError(error));
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
    await this.triggerWake({reason:"character_changed"});
  }

  private async triggerWake(request:WakeRequest):Promise<void>{
    if(!this.isOn())return;
    this.clearTimer();
    if(this.activeWake){
      this.pendingWake=request;
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
    this.state={...this.state,status:"awake",wakeReason:request.reason,lastWakeAt:this.clock(),nextWakeAt:undefined,activeAgentRunId:undefined,currentFocus:undefined,wakeCount};
    this.notify();
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
        ...(providerId?{providerId}:{}),
        ...(model?{model}: {})
      };
      run=await this.options.agentKernel.createRun(input);
      this.state={...this.state,status:"thinking",activeAgentRunId:run.id,currentFocus:task};
      this.notify();
      terminal=await this.options.agentKernel.run(run.id,{
        contextProvider:()=>this.buildContextMessages(request.reason,run!.id)
      });
      await this.handleTerminalRun(terminal,request.reason,request.messageId);
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

  private async buildContextMessages(reason:NovaLifeWakeReason,agentRunId:string):Promise<readonly ChatMessage[]>{
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
      messages:[lifeContext,...conversation.messages],
      budget:this.options.contextBudget()
    });
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_CONTEXT_BUILT","Nova Life context assembled",{
      characterId,conversationId,wakeReason:reason,contextMessageCount:assembled.messages.length,
      memoryCandidates:assembled.includedCandidates.filter(candidate=>candidate.source==="memory").length,
      coreBookCandidates:assembled.includedCandidates.filter(candidate=>candidate.source==="core_book").length
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
      this.state={...this.state,status:"error",lastOutcome:run.lastOutcome??"Cognition failed."};
      this.notify();
      await this.options.events.publish(createEvent("NovaLifeError",{
        characterId:this.state.characterId,
        conversationId:this.state.conversationId,
        reason:run.lastOutcome??"Cognition failed.",
        agentRunId:run.id
      },"nova-life",this.clock,"nova-life:error:"+run.id));
      this.scheduleWake(this.retryWakeMs,"retry");
      return;
    }
    if(run.lastAction==="finish"){
      const result=run.workingSummary?.trim();
      if(!result){
        this.state={...this.state,status:"error",lastOutcome:"Cognition finished without a user-facing result."};
        this.notify();
        this.scheduleWake(this.retryWakeMs,"retry");
        return;
      }
      const assistant=await this.appendAssistant(run.id,result,false);
      await this.extractMemoryForUserMessage(run,messageId,assistant);
      if(this.idleWakeMs>0)this.scheduleWake(this.idleWakeMs,"scheduled_wake");
      else this.setWaiting();
      return;
    }
    if(run.lastAction==="ask_user"){
      const question=this.extractWaitingText(run);
      if(question){
        const assistant=await this.appendAssistant(run.id,question,true);
        await this.extractMemoryForUserMessage(run,messageId,assistant);
      }
      this.setWaiting();
      return;
    }
    if(run.lastAction==="wait"){
      this.scheduleWake(this.normalizeDelay(run.lastWaitMs??30000),"wait_completed");
      return;
    }
    this.setWaiting();
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
    this.state={...this.state,lastAction:isQuestion?"ask_user":"finish",lastOutcome:isQuestion?"waiting:"+content:"completed:"+content.slice(0,1000)};
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
      case "startup":return "Evaluate the current life context now that Nova has been turned on. She may proactively greet the user or choose to wait."; 
      case "conversation_changed":return "Evaluate the newly active conversation and decide whether Nova should respond proactively or wait."; 
      case "character_changed":return "Evaluate the newly active Character context and continue Nova's life naturally."; 
      case "runtime_event":return "Evaluate the current runtime event and decide whether Nova should respond, act internally, or wait."; 
    }
  }

  private scheduleWake(delayMs:number,reason:NovaLifeWakeReason):void{
    if(!this.isOn())return;
    const delay=this.normalizeDelay(delayMs);
    this.clearTimer();
    const nextWakeAt=new Date(Date.parse(this.clock())+delay).toISOString();
    const epoch=++this.timerEpoch;
    this.state={...this.state,status:"sleeping",nextWakeAt,wakeReason:reason,activeAgentRunId:undefined};
    this.notify();
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
    this.options.diagnostics?.recordError("nova-life","NOVA_LIFE_RUNTIME_ERROR","Nova Life runtime error",{message,agentRunId});
    void this.options.events.publish(createEvent("NovaLifeError",{
      ...(this.state.characterId?{characterId:this.state.characterId}:{}),
      ...(this.state.conversationId?{conversationId:this.state.conversationId}:{}),
      reason:message,
      ...(agentRunId?{agentRunId}: {})
    },"nova-life",this.clock,"nova-life:runtime-error:"+Date.now())).catch(()=>undefined);
    this.scheduleWake(this.retryWakeMs,"retry");
  }

  private notify():void{
    const snapshot=this.getState();
    for(const listener of [...this.listeners]){
      try{listener(snapshot)}catch{}
    }
  }

  private normalizeDelay(value:number):number{
    if(!Number.isFinite(value)||value<1)return 1;
    return Math.min(300000,Math.floor(value));
  }
}
