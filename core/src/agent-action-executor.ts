import type {AgentDecision,AgentRun,AgentStepOutcome} from "../../contracts/src/index";

export interface AgentActionExecution{outcome:AgentStepOutcome;nextState:"thinking"|"waiting"|"completed";summary?:string;waitMs?:number;}
export interface AgentActionExecutionContext{signal?:AbortSignal;}
export interface AgentActionExecutor{
  execute(run:AgentRun,decision:AgentDecision,context?:AgentActionExecutionContext):Promise<AgentActionExecution>;
}

export class DefaultAgentActionExecutor implements AgentActionExecutor{
  async execute(_run:AgentRun,decision:AgentDecision,context:AgentActionExecutionContext={}):Promise<AgentActionExecution>{
    if(context.signal?.aborted){
      const error=new Error("Agent action operation aborted.");error.name="AbortError";throw error;
    }
    switch(decision.action){
      case "continue":return {outcome:"continued",nextState:"thinking",...(decision.workingSummary?{summary:decision.workingSummary}: {})};
      case "wait":return {outcome:"waiting",nextState:"waiting",summary:"wait:"+decision.waitMs,waitMs:decision.waitMs};
      case "ask_user":return {outcome:"waiting",nextState:"waiting",summary:decision.question};
      case "finish":return {outcome:"completed",nextState:"completed",summary:decision.result};
    }
  }
}
