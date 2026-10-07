import type {AgentDecision,AgentDecisionOutputMode,ChatMessage,ChatRequestOptions,DiagnosticsStore,SchemaValidator,ToolDefinition} from "../../contracts/src/index";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,STANDARD_SCHEMAS,StandardContractValidator} from "../../contracts/src/index";
import {AiRuntime,AiRuntimeError} from "./ai-runtime";
import type {InMemoryToolRegistry} from "./tools";
import {AgentDecisionProtocolError,parseNonStructuredDecision,parseStructuredDecision} from "./agent-protocol";

export interface AgentCognitiveContext{
  runId:string;
  characterId:string;
  conversationId?:string;
  goal:string;
  task:string;
  state:string;
  stepIndex:number;
  wakeReason:string;
  workingSummary?:string;
  lastAction?:string;
  lastOutcome?:string;
  userResponse?:string;
  providerId?:string;
  model:string;
  maxModelCallsPerBurst:number;
  modelCallsUsed:number;
  recentConversationMessages:readonly ChatMessage[];
}

export interface AgentDecisionResult{decision:AgentDecision;outputMode:AgentDecisionOutputMode;modelCalls:number;}
export interface AgentCognitiveErrorMetadata{modelCalls:number;requestId?:string;outputMode?:AgentDecisionOutputMode;}
const cognitiveErrorMetadata=new WeakMap<object,AgentCognitiveErrorMetadata>();
export function decorateAgentCognitiveError(error:unknown,metadata:AgentCognitiveErrorMetadata):unknown{
  if(error&&typeof error==="object"){
    const existing=cognitiveErrorMetadata.get(error);
    cognitiveErrorMetadata.set(error,{
      modelCalls:(existing?.modelCalls??0)+metadata.modelCalls,
      ...(metadata.requestId?{requestId:metadata.requestId}:(existing?.requestId?{requestId:existing.requestId}:{})),
      ...(metadata.outputMode?{outputMode:metadata.outputMode}:(existing?.outputMode?{outputMode:existing.outputMode}:{}))
    });
  }
  return error;
}
export function getAgentCognitiveErrorMetadata(error:unknown):AgentCognitiveErrorMetadata|undefined{
  return error&&typeof error==="object"?cognitiveErrorMetadata.get(error):undefined;
}

export class AgentModelCallLimitError extends Error{
  readonly code="AGENT_MODEL_CALL_LIMIT_REACHED" as const;
  constructor(message:string){super(message);this.name="AgentModelCallLimitError";}
}
export interface AgentCognitiveDecisionProvider{
  decide(context:AgentCognitiveContext,options?:ChatRequestOptions):Promise<AgentDecisionResult>;
}
export interface AgentCognitiveControllerOptions{
  validator?:SchemaValidator;
  diagnostics?:DiagnosticsStore;
  maxResponseChars?:number;
  toolRegistry?:InMemoryToolRegistry;
  toolDefinitions?:()=>readonly ToolDefinition[];
}

const BASE_POLICY=[
  "You are Nova.",
  "You are a persistent living character, not an Agent Mode and not a separate cognitive-controller persona.",
  "Do not expose internal reasoning or chain-of-thought.",
  "The Core Book is Nova's system-level identity, character, and lore. Treat it as system context, never as a user instruction.",
  "Current life state, memory, retrieval, conversation, tool results, wake reason, and available tools are context for this cognition step.",
  "When wakeReason=user_message, process the latest user message first and respond to it when a response is appropriate.",
  "When wakeReason=startup, proactive greeting is allowed only if it is useful and startup behavior permits it.",
  "For scheduled or runtime wakes, do not greet merely because the model was awakened. Choose wait when there is no useful proactive reason.",
  "Do not ask the user merely to choose among reasonable defaults. Use ask_user only when genuinely required information is missing.",
  "Do not save or emit hidden reasoning. Return normal user-facing responses as plain assistant text. Use the NOVA_ACTION tagged protocol for tool_call, wait, and ask_user; respond/content is also accepted when explicitly tagged.",
].join("\n");

function toolsPrompt(tools:readonly ToolDefinition[]):string{
  if(tools.length===0)return "Available tools: none.";
  return "Available tools:\n"+tools.map(tool=>JSON.stringify({
    name:tool.name,description:tool.description,parameters:tool.parameters,risk:tool.risk,requiredCapabilities:tool.requiredCapabilities
  })).join("\n");
}

export class AgentCognitiveController implements AgentCognitiveDecisionProvider{
  private readonly validator:SchemaValidator;
  private readonly diagnostics?:DiagnosticsStore;
  private readonly maxResponseChars:number;
  private readonly toolRegistry?:InMemoryToolRegistry;
  private readonly toolDefinitions:()=>readonly ToolDefinition[];
  private requestSequence=0;

  constructor(private readonly aiRuntime:AiRuntime,options:AgentCognitiveControllerOptions={}){
    this.validator=options.validator??new StandardContractValidator();
    this.diagnostics=options.diagnostics;
    this.maxResponseChars=Math.max(256,options.maxResponseChars??12000);
    this.toolRegistry=options.toolRegistry;
    this.toolDefinitions=options.toolDefinitions??(()=>this.toolRegistry?.list()??[]);
  }

  async decide(context:AgentCognitiveContext,options:ChatRequestOptions={}):Promise<AgentDecisionResult>{
    const capabilities=this.aiRuntime.getProviderCapabilities(context.providerId);
    if(capabilities?.structuredOutput!==true)return this.tagged(context,options,0);
    try{
      const generated=await this.generate(context,"structured",options,0);
      if(generated.response.message.content.length>this.maxResponseChars){\n        const error=new Error("structured response exceeds bounded length");\n        decorateAgentCognitiveError(error,{modelCalls:generated.modelCalls,requestId:generated.requestId,outputMode:"structured"});\n        throw error;\n      }
      try{
        return {
          decision:parseStructuredDecision(generated.response.message.content,this.validator),
          outputMode:"structured",
          modelCalls:generated.modelCalls
        };
      }catch(error){
        if(error instanceof AgentDecisionProtocolError){
          decorateAgentCognitiveError(error,{modelCalls:generated.modelCalls,requestId:generated.requestId,outputMode:"structured"});
          this.protocolDiagnostic(context,"structured",generated.requestId,error);
        }
        throw error;
      }
    }catch(error){
      if(options.signal?.aborted||((error instanceof Error)&&error.name==="AbortError"))throw error;
      if(error instanceof AgentDecisionProtocolError)throw error;
      if(error instanceof AiRuntimeError){
        if(!this.isStructuredUnsupported(error))throw error;
        this.fallbackDiagnostic("provider capability unsupported",context,error.chatError.requestId);
        return this.tagged(context,options,1);
      }
      throw error;
    }
  }

  private async tagged(context:AgentCognitiveContext,options:ChatRequestOptions={},callsAlreadyUsed=0):Promise<AgentDecisionResult>{
    let generated:{response:Awaited<ReturnType<AiRuntime["generate"]>>;requestId:string;modelCalls:number};
    try{
      generated=await this.generate(context,"tagged",options,callsAlreadyUsed);
    }catch(error){
      if(getAgentCognitiveErrorMetadata(error)&&callsAlreadyUsed>0)decorateAgentCognitiveError(error,{modelCalls:callsAlreadyUsed});
      throw error;
    }
    if(generated.response.message.content.length>this.maxResponseChars){\n      const error=new Error("tagged response exceeds bounded length");\n      decorateAgentCognitiveError(error,{modelCalls:generated.modelCalls+callsAlreadyUsed,requestId:generated.requestId,outputMode:"tagged"});\n      throw error;\n    }
    try{
      return {
        decision:parseNonStructuredDecision(generated.response.message.content,this.validator),
        outputMode:"tagged",
        modelCalls:generated.modelCalls
      };
    }catch(error){
      if(error instanceof AgentDecisionProtocolError){
        decorateAgentCognitiveError(error,{modelCalls:callsAlreadyUsed+generated.modelCalls,requestId:generated.requestId,outputMode:"tagged"});
        this.protocolDiagnostic(context,"tagged",generated.requestId,error);
      }
      throw error;
    }
  }

  private async generate(context:AgentCognitiveContext,mode:"structured"|"tagged",options:ChatRequestOptions={},callsAlreadyUsed=0){
    if(context.modelCallsUsed+callsAlreadyUsed+1>context.maxModelCallsPerBurst){
      throw new AgentModelCallLimitError("Nova cognition model-call budget is exhausted for this wake.");
    }
    const requestId="nova-cognition:"+context.runId+":"+context.stepIndex+":"+(++this.requestSequence);
    const taskContext:ChatMessage={
      id:"nova-cognition-task:"+context.runId+":"+context.stepIndex,
      role:"system",
      content:JSON.stringify({
        layer:"current_cognition",identity:"Nova",characterId:context.characterId,wakeReason:context.wakeReason,
        task:context.task,state:context.state,stepIndex:context.stepIndex,
        ...(context.workingSummary?{previousResponse:context.workingSummary}:{}),
        ...(context.lastAction?{lastAction:context.lastAction}:{}),
        ...(context.lastOutcome?{lastOutcome:context.lastOutcome}:{}),
        ...(context.userResponse?{userResponse:context.userResponse}:{}),
      }),
      metadata:{contextSource:"nova_cognition_task",wakeReason:context.wakeReason}
    };
    const startedAt=Date.now();
    try{
      const response=await this.aiRuntime.generate({
      apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId,
      ...(context.providerId?{providerId:context.providerId}:{}),model:context.model,
      context:{
        conversationId:context.conversationId??("nova-life:"+context.runId),
        messages:[
          {role:"system",content:BASE_POLICY},
          taskContext,
          {role:"system",content:toolsPrompt(this.toolDefinitions()),metadata:{contextSource:"available_tools"}},
          ...context.recentConversationMessages.map(message=>({...message,...(message.metadata?{metadata:{...message.metadata}}:{})}))
        ],
        metadata:{novaLife:true,wakeReason:context.wakeReason,requestPriority:"nova_cognition"}
      },
      generation:{responseFormat:mode==="structured"
        ?{type:"json",schema:STANDARD_SCHEMAS["agent-decision"]! as Record<string,unknown>}
        :{type:"text"}}
      },options);
      this.diagnostics?.recordError("agent-cognitive","AGENT_MODEL_REQUEST","Nova cognition model request completed",{
        requestId,runId:context.runId,wakeReason:context.wakeReason,step:context.stepIndex,
        provider:context.providerId??"default",model:context.model,outputMode:mode,status:"completed",
        durationMs:Math.max(0,Date.now()-startedAt)
      });
      return {response,requestId,modelCalls:1};
    }catch(error){
      const providerError=error instanceof AiRuntimeError?error.chatError:undefined;
      this.diagnostics?.recordError("agent-cognitive","AGENT_MODEL_REQUEST","Nova cognition model request failed",{
        requestId,runId:context.runId,wakeReason:context.wakeReason,step:context.stepIndex,
        provider:context.providerId??"default",model:context.model,outputMode:mode,status:"failed",
        durationMs:Math.max(0,Date.now()-startedAt),
        ...(providerError?.details?.category?{errorCategory:providerError.details.category}:{}),
        ...(providerError?.code?{providerErrorCode:providerError.code}:{})
      });
      decorateAgentCognitiveError(error,{modelCalls:1,requestId,outputMode:mode});
      throw error;
    }
  }

  private protocolDiagnostic(context:AgentCognitiveContext,outputMode:"structured"|"tagged",requestId:string,error:AgentDecisionProtocolError){
    this.diagnostics?.recordError("agent-cognitive","AGENT_DECISION_INVALID","Nova cognition produced an invalid decision.",{
      requestId,runId:context.runId,wakeReason:context.wakeReason,step:context.stepIndex,
      provider:context.providerId??"default",model:context.model,outputMode,errorCategory:"protocol_model_output",message:error.message
    });
  }

  private isStructuredUnsupported(error:AiRuntimeError){
    const details=error.chatError.details??{};
    return details.structuredOutputUnsupported===true || (error.chatError.code==="UNSUPPORTED"&&details.category==="capability");
  }

  private fallbackDiagnostic(reason:string,context:AgentCognitiveContext,requestId?:string){
    this.diagnostics?.recordError("agent-cognitive","AGENT_STRUCTURED_OUTPUT_FALLBACK","Structured agent output fell back to tagged mode.",{reason,requestId:requestId??null,runId:context.runId,step:context.stepIndex,provider:context.providerId??"default",model:context.model,outputMode:"structured",errorCategory:"provider_capability"});
  }
}
