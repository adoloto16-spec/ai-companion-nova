import type {AgentRun,AgentRunInput,ChatMessage,Conversation} from "../../../contracts/src/index";
import type {FoundationRuntime} from "../../../runtime/bootstrap/src/index";

export type AgentChatStatus="idle"|"starting"|"thinking"|"acting"|"waiting"|"completed"|"failed"|"interrupted";
export interface AgentChatSnapshot{
  status:AgentChatStatus;
  sending:boolean;
  messages:readonly ChatMessage[];
  runId?:string;
  stepCount:number;
  question?:string;
  result?:string;
  error?:string;
}
export type AgentChatActionResult=
  | {status:"completed"|"waiting"|"failed"|"interrupted";run:AgentRun}
  | {status:"rejected";reason:"empty"|"busy"|"not-waiting"|"answer-required"};

export type AgentConversationPersistence=(characterId:string,conversationId:string,messages:readonly ChatMessage[])=>Promise<Conversation>;
type AgentRuntime=Pick<FoundationRuntime,"startAgentRun"|"getAgentRun"|"interruptAgentRun"|"resumeAgentRun">;

let runSequence=0;
function cloneMessage(message:ChatMessage):ChatMessage{
  return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})};
}
function cloneMessages(messages:readonly ChatMessage[]):readonly ChatMessage[]{
  return messages.map(cloneMessage);
}
function nextRunId():string{
  runSequence+=1;
  return "agent-ui:"+Date.now().toString(36)+":"+runSequence;
}
function delay(ms:number):Promise<void>{
  return new Promise(resolve=>setTimeout(resolve,ms));
}
function statusForRun(run:AgentRun):AgentChatStatus{
  switch(run.state){
    case "starting":return "starting";
    case "thinking":case "planning":return "thinking";
    case "acting":return "acting";
    case "waiting":return "waiting";
    case "completed":return "completed";
    case "failed":return "failed";
    case "interrupted":return "interrupted";
    default:return "starting";
  }
}
function questionForRun(run:AgentRun):string|undefined{
  if(run.state!=="waiting"||run.lastAction!=="ask_user")return undefined;
  const prefix="waiting:";
  const value=run.lastOutcome?.startsWith(prefix)?run.lastOutcome.slice(prefix.length).trim():undefined;
  return value||undefined;
}
function errorForRun(run:AgentRun):string{
  return run.lastOutcome?.trim()||"Agent Run failed.";
}

export class AgentChatController{
  private conversation:Conversation;
  private snapshot:AgentChatSnapshot;
  private readonly listeners=new Set<(snapshot:AgentChatSnapshot)=>void>();
  private activeRunId?:string;
  private activePromise?:Promise<AgentRun>;
  private answerSequence=0;

  constructor(
    private readonly runtime:AgentRuntime,
    private readonly characterId:string,
    conversation:Conversation,
    private readonly persist:AgentConversationPersistence
  ){
    this.conversation={...conversation,messages:cloneMessages(conversation.messages)};
    this.snapshot={
      status:"idle",
      sending:false,
      messages:cloneMessages(conversation.messages),
      stepCount:0
    };
  }

  getSnapshot():AgentChatSnapshot{
    return {
      ...this.snapshot,
      messages:cloneMessages(this.snapshot.messages)
    };
  }

  subscribe(listener:(snapshot:AgentChatSnapshot)=>void):()=>void{
    this.listeners.add(listener);
    return ()=>{this.listeners.delete(listener)};
  }

  replaceConversation(conversation:Conversation):void{
    if(conversation.id!==this.conversation.id)return;
    this.conversation={...conversation,messages:cloneMessages(conversation.messages)};
    if(!this.snapshot.sending){
      this.snapshot={...this.snapshot,messages:cloneMessages(conversation.messages),error:undefined};
      this.notify();
    }
  }

  async submit(task:string,providerId?:string,model?:string):Promise<AgentChatActionResult>{
    const text=task.trim();
    if(!text)return {status:"rejected",reason:"empty"};
    if(this.snapshot.sending)return {status:"rejected",reason:"busy"};
    const runId=nextRunId();
    const userMessage:ChatMessage={id:runId+":user",role:"user",content:text};
    try{
      await this.persistMessages([...this.conversation.messages,userMessage]);
    }catch(error){
      this.snapshot={...this.snapshot,status:"failed",sending:false,error:error instanceof Error?error.message:"Conversation could not be saved."};
      this.notify();
      return {status:"failed",run:this.syntheticFailureRun(runId,text,error)};
    }
    this.snapshot={status:"starting",sending:true,messages:cloneMessages(this.conversation.messages),runId,stepCount:0};
    this.notify();
    const input:AgentRunInput={
      id:runId,
      characterId:this.characterId,
      goal:"Provide the final answer to the user's current request.",
      task:text,
      ...(providerId?{providerId}:{}),
      ...(model?{model}:{})
    };
    return this.startAndMonitor(runId,input);
  }

  async interrupt(reason="Interrupted by user."):Promise<AgentChatActionResult>{
    const runId=this.activeRunId;
    if(!runId)return {status:"rejected",reason:"busy"};
    try{
      await this.runtime.interruptAgentRun(runId,reason);
      const promise=this.activePromise;
      if(promise)await promise;
      const run=this.runtime.getAgentRun(runId);
      if(run)return this.applyTerminal(run);
      return {status:"interrupted",run:this.syntheticFailureRun(runId,"",new Error(reason),"interrupted")};
    }catch(error){
      this.snapshot={...this.snapshot,sending:false,status:"failed",error:error instanceof Error?error.message:"Agent Run interruption failed."};
      this.notify();
      return {status:"failed",run:this.syntheticFailureRun(runId,"",error)};
    }
  }

  async resume(answer?:string):Promise<AgentChatActionResult>{
    const waitingRun=this.snapshot.runId?this.runtime.getAgentRun(this.snapshot.runId):undefined;
    if(!waitingRun||waitingRun.state!=="waiting")return {status:"rejected",reason:"not-waiting"};
    const question=questionForRun(waitingRun);
    const text=answer?.trim()||"";
    if(question&&!text)return {status:"rejected",reason:"answer-required"};
    if(text){
      const answerMessage:ChatMessage={
        id:waitingRun.id+":answer:"+(++this.answerSequence),
        role:"user",
        content:text
      };
      try{await this.persistMessages([...this.conversation.messages,answerMessage])}
      catch(error){
        this.snapshot={...this.snapshot,status:"failed",sending:false,error:error instanceof Error?error.message:"Conversation could not be saved."};
        this.notify();
        return {status:"failed",run:this.syntheticFailureRun(waitingRun.id,text,error)};
      }
    }
    this.snapshot={...this.snapshot,status:"starting",sending:true,question:undefined,error:undefined};
    this.notify();
    return this.startAndMonitor(waitingRun.id,undefined,text);
  }

  private async startAndMonitor(runId:string,input?:AgentRunInput,userResponse?:string):Promise<AgentChatActionResult>{
    try{
      const promise=input?this.runtime.startAgentRun(input):this.runtime.resumeAgentRun(runId,userResponse);
      this.activeRunId=runId;
      this.activePromise=promise;
      let settled=false;
      void promise.then(()=>{settled=true},()=>{settled=true});
      while(!settled){
        const live=this.runtime.getAgentRun(runId);
        if(live)this.applyRun(live);
        await delay(25);
      }
      const run=await promise;
      this.applyRun(run);
      return this.applyTerminal(run);
    }catch(error){
      this.activeRunId=undefined;
      this.activePromise=undefined;
      this.snapshot={...this.snapshot,status:"failed",sending:false,error:error instanceof Error?error.message:"Agent Run failed."};
      this.notify();
      return {status:"failed",run:this.syntheticFailureRun(runId,"",error)};
    }finally{
      this.activeRunId=undefined;
      this.activePromise=undefined;
    }
  }

  private applyRun(run:AgentRun):void{
    const status=statusForRun(run);
    this.snapshot={
      ...this.snapshot,
      status,
      sending:run.state!=="waiting"&&run.state!=="completed"&&run.state!=="failed"&&run.state!=="interrupted",
      runId:run.id,
      stepCount:run.stepCount,
      question:questionForRun(run),
      error:run.state==="failed"?errorForRun(run):undefined,
      result:run.state==="completed"&&run.lastAction==="finish"?run.workingSummary:undefined
    };
    this.notify();
  }

  private async applyTerminal(run:AgentRun):Promise<AgentChatActionResult>{
    if(run.state==="completed"){
      const result=run.lastAction==="finish"?run.workingSummary?.trim():"";
      if(!result){
        this.snapshot={...this.snapshot,status:"failed",sending:false,error:"Agent Run completed without a final result."};
        this.notify();
        return {status:"failed",run};
      }
      const assistantId=run.id+":assistant";
      const assistant:ChatMessage={
        id:assistantId,
        role:"assistant",
        content:result,
        metadata:{streamStatus:"complete",agentRunId:run.id}
      };
      const nextMessages=this.conversation.messages.some(message=>message.id===assistantId)
        ?this.conversation.messages.map(message=>message.id===assistantId?assistant:message)
        :[...this.conversation.messages,assistant];
      try{
        await this.persistMessages(nextMessages);
      }catch(error){
        this.snapshot={...this.snapshot,status:"failed",sending:false,error:error instanceof Error?error.message:"Conversation could not be saved."};
        this.notify();
        return {status:"failed",run};
      }
      this.snapshot={status:"completed",sending:false,messages:cloneMessages(this.conversation.messages),runId:run.id,stepCount:run.stepCount,result};
      this.notify();
      return {status:"completed",run};
    }
    if(run.state==="waiting"){
      const question=questionForRun(run);
      if(question){
        const questionId=run.id+":question";
        if(!this.conversation.messages.some(message=>message.id===questionId)){
          const questionMessage:ChatMessage={
            id:questionId,
            role:"assistant",
            content:question,
            metadata:{streamStatus:"complete",agentRunId:run.id,agentMessageType:"question"}
          };
          try{
            await this.persistMessages([...this.conversation.messages,questionMessage]);
          }catch(error){
            this.snapshot={...this.snapshot,status:"failed",sending:false,error:error instanceof Error?error.message:"Conversation could not be saved."};
            this.notify();
            return {status:"failed",run};
          }
        }
      }
      this.snapshot={...this.snapshot,status:"waiting",sending:false,messages:cloneMessages(this.conversation.messages),runId:run.id,stepCount:run.stepCount,question,error:undefined};
      this.notify();
      return {status:"waiting",run};
    }
    if(run.state==="interrupted"){
      this.snapshot={...this.snapshot,status:"interrupted",sending:false,messages:cloneMessages(this.conversation.messages),runId:run.id,stepCount:run.stepCount,error:undefined};
      this.notify();
      return {status:"interrupted",run};
    }
    this.snapshot={status:"failed",sending:false,messages:cloneMessages(this.conversation.messages),runId:run.id,stepCount:run.stepCount,error:errorForRun(run)};
    this.notify();
    return {status:"failed",run};
  }

  private async persistMessages(messages:readonly ChatMessage[]):Promise<void>{
    const updated=await this.persist(this.characterId,this.conversation.id,messages);
    this.conversation={...updated,messages:cloneMessages(updated.messages)};
    this.snapshot={...this.snapshot,messages:cloneMessages(updated.messages)};
  }

  private syntheticFailureRun(runId:string,task:string,error:unknown,state:"failed"|"interrupted"="failed"):AgentRun{
    const now=new Date().toISOString();
    return {
      id:runId,
      characterId:this.characterId,
      goal:"Provide the final answer to the user's current request.",
      task,
      state,
      status:state,
      stepCount:0,
      startedAt:now,
      updatedAt:now,
      lastOutcome:error instanceof Error?error.message:String(error),
      limits:{maxSteps:20,maxDurationMs:60000,maxConsecutiveFailures:3}
    };
  }

  private notify():void{
    const snapshot=this.getSnapshot();
    for(const listener of [...this.listeners]){
      try{listener(snapshot)}catch{}
    }
  }
}
