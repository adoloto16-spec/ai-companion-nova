import type {AgentDecision,AgentOutputMode,ChatRequestOptions,DiagnosticsStore,SchemaValidator} from "../../contracts/src/index";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,STANDARD_SCHEMAS,StandardContractValidator} from "../../contracts/src/index";
import {AiRuntime,AiRuntimeError} from "./ai-runtime";
import {parseStructuredDecision,parseTaggedDecision} from "./agent-protocol";

export interface AgentCognitiveContext{
  runId:string;characterId:string;goal:string;task:string;state:string;stepIndex:number;
  workingSummary?:string;lastAction?:string;lastOutcome?:string;providerId?:string;model:string;
}
export interface AgentDecisionResult{decision:AgentDecision;outputMode:AgentOutputMode;}
export interface AgentCognitiveDecisionProvider{
  decide(context:AgentCognitiveContext,options?:ChatRequestOptions):Promise<AgentDecisionResult>;
}
export interface AgentCognitiveControllerOptions{
  validator?:SchemaValidator;diagnostics?:DiagnosticsStore;maxResponseChars?:number;
}

const STRUCTURED_PROMPT=[
  "You are Nova's cognitive controller.",
  "Select the next action required to advance the current goal.",
  "You are not executing actions directly. You are selecting one action for the Agent Kernel.",
  "Do not output chain-of-thought.",
  "Preferred output protocol: structured decision.",
  "Do not emit additional prose outside the required protocol."
].join("\n");

const TAGGED_PROMPT=[
  "You are Nova's cognitive controller.",
  "Select the next action required to advance the current goal.",
  "You are not executing actions directly. You are selecting one action for the Agent Kernel.",
  "Do not output chain-of-thought.",
  "Fallback protocol: output exactly one NOVA_ACTION block and no other prose.",
  "Allowed forms:",
  "<NOVA_ACTION>\ntype=continue\n</NOVA_ACTION>",
  "<NOVA_ACTION>\ntype=wait\nwait_ms=5000\n</NOVA_ACTION>",
  "<NOVA_ACTION>\ntype=ask_user\nquestion=...\n</NOVA_ACTION>",
  "<NOVA_ACTION>\ntype=finish\nresult=...\n</NOVA_ACTION>"
].join("\n");

export class AgentCognitiveController implements AgentCognitiveDecisionProvider{
  private readonly validator:SchemaValidator;
  private readonly diagnostics?:DiagnosticsStore;
  private readonly maxResponseChars:number;
  private requestSequence=0;
  constructor(private readonly aiRuntime:AiRuntime,options:AgentCognitiveControllerOptions={}){
    this.validator=options.validator??new StandardContractValidator();
    this.diagnostics=options.diagnostics;
    this.maxResponseChars=Math.max(256,options.maxResponseChars??8000);
  }

  async decide(context:AgentCognitiveContext,options:ChatRequestOptions={}):Promise<AgentDecisionResult>{
    const capabilities=this.aiRuntime.getProviderCapabilities(context.providerId);
    if(capabilities?.structuredOutput!==true)return this.tagged(context,options);
    try{
      const response=await this.generate(context,"structured",options);
      if(response.message.content.length>this.maxResponseChars)throw new Error("structured response exceeds bounded length");
      return {decision:parseStructuredDecision(response.message.content,this.validator),outputMode:"structured"};
    }catch(error){
      if(options.signal?.aborted||((error instanceof Error)&&error.name==="AbortError"))throw error;
      if(error instanceof AiRuntimeError){
        if(!this.isStructuredUnsupported(error))throw error;
        this.fallbackDiagnostic("provider capability unsupported");
      }else{
        this.fallbackDiagnostic("structured response invalid");
      }
      const result=await this.tagged(context,options);
      return result;
    }
  }

  private async tagged(context:AgentCognitiveContext,options:ChatRequestOptions):Promise<AgentDecisionResult>{
    const response=await this.generate(context,"tagged",options);
    if(response.message.content.length>this.maxResponseChars)throw new Error("tagged response exceeds bounded length");
    return {decision:parseTaggedDecision(response.message.content,this.validator),outputMode:"tagged"};
  }

  private async generate(context:AgentCognitiveContext,mode:"structured"|"tagged",options:ChatRequestOptions){
    const requestId="agent:"+context.runId+":"+context.stepIndex+":"+(++this.requestSequence);
    return this.aiRuntime.generate({
      apiVersion:CHAT_API_VERSION,
      schemaVersion:CHAT_SCHEMA_VERSION,
      requestId,
      ...(context.providerId?{providerId:context.providerId}:{}),
      model:context.model,
      context:{
        conversationId:"agent-run:"+context.runId,
        messages:[
          {role:"system",content:mode==="structured"?STRUCTURED_PROMPT:TAGGED_PROMPT},
          {role:"user",content:JSON.stringify({
            protocol:"nova-agent-decision-v1",characterId:context.characterId,goal:context.goal,task:context.task,
            state:context.state,stepIndex:context.stepIndex,
            ...(context.workingSummary?{workingSummary:context.workingSummary}:{}),
            ...(context.lastAction?{lastAction:context.lastAction}:{}),
            ...(context.lastOutcome?{lastOutcome:context.lastOutcome}:{}),
            availableInternalActions:["continue","wait","ask_user","finish"]
          })}
        ]
      },
      generation:{responseFormat:mode==="structured"
        ?{type:"json",schema:STANDARD_SCHEMAS["agent-decision"]! as Record<string,unknown>}
        :{type:"text"}}
    },options);
  }

  private isStructuredUnsupported(error:AiRuntimeError){
    const details=error.chatError.details??{};
    return details.structuredOutputUnsupported===true || (error.chatError.code==="UNSUPPORTED"&&details.category==="capability");
  }

  private fallbackDiagnostic(reason:string){
    this.diagnostics?.recordError("agent-cognitive","AGENT_STRUCTURED_OUTPUT_FALLBACK","Structured agent output fell back to tagged mode.",{reason});
  }
}
