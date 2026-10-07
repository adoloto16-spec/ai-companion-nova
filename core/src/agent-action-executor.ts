import type {ActionBroker,ActorCredential,AgentDecision,AgentRun,AgentStepOutcome,ChatMessage} from "../../contracts/src/index";
import {FOUNDATION_SCHEMA_VERSION} from "../../contracts/src/index";
import type {InMemoryToolRegistry} from "./tools";

export interface AgentActionExecution{
  outcome:AgentStepOutcome;
  nextState:"thinking"|"waiting"|"completed";
  summary?:string;
  waitMs?:number;
  contextMessages?:readonly ChatMessage[];
}
export interface AgentActionExecutionContext{signal?:AbortSignal;}
export interface AgentActionExecutor{
  execute(run:AgentRun,decision:AgentDecision,context?:AgentActionExecutionContext):Promise<AgentActionExecution>;
}

function serialize(value:unknown):string{
  try{return JSON.stringify(value);}
  catch{return String(value);}
}

export interface DefaultAgentActionExecutorOptions{
  toolRegistry:InMemoryToolRegistry;
  actionBroker:ActionBroker;
  credential:ActorCredential;
}

export class DefaultAgentActionExecutor implements AgentActionExecutor{
  constructor(private readonly options:DefaultAgentActionExecutorOptions){}
  async execute(_run:AgentRun,decision:AgentDecision,context:AgentActionExecutionContext={}):Promise<AgentActionExecution>{
    if(context.signal?.aborted){
      const error=new Error("Agent action operation aborted.");error.name="AbortError";throw error;
    }
    switch(decision.action){
      case "respond":
        return {outcome:"responded",nextState:"completed",summary:decision.result};
      case "wait":
        return {outcome:"waiting",nextState:"waiting",summary:"wait:"+decision.waitMs,waitMs:decision.waitMs};
      case "ask_user":
        return {outcome:"waiting",nextState:"waiting",summary:decision.question};
      case "tool_call":{
        const tool=this.options.toolRegistry.get(decision.toolName);
        if(!tool)throw new Error("Tool not found: "+decision.toolName);
        const request={
          id:decision.callId,
          schemaVersion:FOUNDATION_SCHEMA_VERSION,
          tool:decision.toolName,
          arguments:decision.arguments,
          metadata:{agentRun:true,toolName:decision.toolName}
        };
        const result=await this.options.actionBroker.execute({request,credential:this.options.credential});
        if(context.signal?.aborted){
          const error=new Error("Agent action operation aborted.");error.name="AbortError";throw error;
        }
        const toolMessage:ChatMessage={
          id:"tool:"+decision.callId,
          role:"tool",
          content:serialize(result),
          toolCallId:decision.callId,
          metadata:{contextSource:"agent_tool_result",toolName:decision.toolName,callId:decision.callId,status:result.status}
        };
        const callMessage:ChatMessage={
          id:"tool-call:"+decision.callId,
          role:"assistant",
          content:"",
          toolCallId:decision.callId,
          metadata:{contextSource:"agent_tool_call",toolName:decision.toolName,callId:decision.callId}
        };
        return {
          outcome:"tool_called",
          nextState:"thinking",
          summary:"tool:"+decision.toolName+":"+result.status,
          contextMessages:[callMessage,toolMessage]
        };
      }
    }
  }
}
