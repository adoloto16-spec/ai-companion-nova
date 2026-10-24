import {assemblePromptInstructions,createDefaultPromptConfiguration} from "../../contracts/src";
import type {PromptId} from "../../contracts/src";
import type {
  AssembledContext,Character,ChatMessage,ChatRequest,ChatRequestOptions,ChatResponse,
  ChatStreamHandlers,ChatToolDefinition,ChatReasoningOptions,ContextBuildRequest,ContextBudget,
  Conversation,CognitiveScheduleSettings,MindReactiveTurn,ProviderCapabilities,JsonSchema,
  MindToolExecutor,NovaToolCall,NovaToolResult
} from "../../contracts/src";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,CONTEXT_API_VERSION,CONTEXT_SCHEMA_VERSION,parseNovaTurn} from "../../contracts/src";
import {cloneChatImageAttachments,restoreChatImageAttachments} from "./chat-message-attachments";
import {NOVA_TURN_MAX_SERIALIZED_CHARS} from "../../contracts/src/nova-turn";
import type {NovaTurn} from "../../contracts/src/nova-turn";
import type {CognitiveStep,CognitiveStepContext,CognitiveStepResult} from "./mind-runtime";

export interface CognitiveChatRuntime {
  chat(request:ChatRequest,providerPresetId?:string,options?:ChatRequestOptions):Promise<ChatResponse>;
  stream?(request:ChatRequest,handlers:ChatStreamHandlers,options?:ChatRequestOptions,providerPresetId?:string):Promise<ChatResponse>;
  getChatProviderCapabilities?(providerPresetId?:string):ProviderCapabilities;
  getActiveProviderPresetId?():string|undefined;
  getChatModel?():string;
  getChatModelForPreset?(providerPresetId:string):Promise<string>;
}
export interface LLMCognitiveStepOptions {
  runtime:CognitiveChatRuntime;
  getCharacter:(characterId:string)=>Promise<Character|undefined>;
  getActiveConversation:(characterId:string)=>Promise<Conversation|undefined>;
  buildContext:(request:ContextBuildRequest)=>Promise<AssembledContext>;
  getContextBudget:()=>ContextBudget;
  getActiveProviderPresetId:()=>string|undefined;
  getChatModel:()=>string;
  getChatModelForPreset:(providerPresetId:string)=>Promise<string>;
  getCognitiveSchedule?:()=>CognitiveScheduleSettings;
  getPrompt?:(id:PromptId,scenario?:string)=>string;
  getAvailableTools?:()=>readonly {name:string;description:string;parameters:unknown}[];
  executeTool?:MindToolExecutor["execute"];
  getReasoningOptions?:()=>ChatReasoningOptions;
  getShowReasoningInDiagnostics?:()=>boolean;
  getProviderIdForPreset?:(providerPresetId:string|undefined)=>string|undefined;
  onDiagnostic?:(code:string,message:string,metadata?:Record<string,unknown>)=>void;
  getGenerationOptions?:()=>import("../../contracts/src/index").ChatGenerationOptions|undefined;
  consumeRequestedWakeInterval?:(turnId:string)=>number|undefined;
  clock?:()=>string;
}

const MAX_NATIVE_TOOL_ROUNDS=12;
const MAX_NATIVE_TOOL_CALLS=64;
const MAX_TOOL_ARGUMENT_CHARS=4_000;
const MAX_TOOL_RESULT_CHARS=4_000;

function defaultCognitiveInterval(schedule:CognitiveScheduleSettings|undefined):number{
  if(!schedule)return 30_000;
  return Math.min(schedule.maxIntervalMs,Math.max(schedule.minIntervalMs,schedule.defaultIntervalMs));
}
function throwIfAborted(signal:AbortSignal):void {
  if(signal.aborted){const error=new Error("Mind Runtime cognitive step aborted.");error.name="AbortError";throw error;}
}
function cloneMessage(message:ChatMessage):ChatMessage{return {
  ...message,
  ...(message.metadata?{metadata:{...message.metadata}}:{}),
  ...(message.images?{images:cloneChatImageAttachments(message.images)}:{})
};}
function normalizeHistoricalMessage(message:ChatMessage):ChatMessage{
  if(message.role!=="assistant")return cloneMessage(message);
  const parsed=parseNovaTurn(message.content);
  if(!parsed.turn)return cloneMessage(message);
  return {...cloneMessage(message),content:parsed.turn.speech};
}
function safeToolResultText(value:unknown):string{
  let serialized:string;
  try{serialized=JSON.stringify(value)??"null";}catch{serialized=JSON.stringify({error:"Tool result was not serializable."})!;}
  if(serialized.length<=MAX_TOOL_RESULT_CHARS)return serialized;
  return JSON.stringify({truncated:true,preview:serialized.slice(0,MAX_TOOL_RESULT_CHARS-100)});
}
function requestId():string{return "nova-turn-"+Date.now()+"-"+Math.random().toString(36).slice(2,10);}

export class LLMCognitiveStep implements CognitiveStep {
  private readonly clock:()=>string;
  private readonly nativeToolResultCache=new Map<string,NovaToolResult>();
  constructor(private readonly options:LLMCognitiveStepOptions){this.clock=options.clock??(()=>new Date().toISOString());}

  private diagnostic(code:string,message:string,metadata?:Record<string,unknown>):void{
    try{this.options.onDiagnostic?.(code,message,metadata);}catch{/* diagnostics must not interrupt cognition */}
  }

  async run(context:CognitiveStepContext):Promise<CognitiveStepResult>{
    throwIfAborted(context.signal);
    const character=await this.options.getCharacter(context.characterId);
    if(!character)throw new Error("Cognitive character is not available.");
    throwIfAborted(context.signal);
    const conversation=await this.options.getActiveConversation(context.characterId);
    if(!conversation)throw new Error("No active conversation is available for cognitive step.");
    if(conversation.characterId!==character.id)throw new Error("Cognitive conversation character scope mismatch.");

    let reactiveUserMessage:ChatMessage|undefined;
    if(context.userTurn){
      const turn:MindReactiveTurn=context.userTurn;
      if(context.wakeReason!=="user-message"||turn.characterId!==character.id||turn.conversationId!==conversation.id)throw new Error("Reactive user turn scope does not match the active cognitive conversation.");
      const messages=[...conversation.messages];
      let latestUser:ChatMessage|undefined;
      for(let i=messages.length-1;i>=0;i--){if(messages[i]?.role==="user"){latestUser=messages[i];break;}}
      const userIndex=messages.findIndex(message=>message.id===turn.userMessageId);
      if(!latestUser||latestUser.id!==turn.userMessageId||userIndex<0||messages.slice(userIndex+1).some(message=>message.role==="assistant"))throw new Error("Reactive user turn is missing, stale, or already answered in the persisted conversation.");
      reactiveUserMessage=cloneMessage(latestUser);
    }
    throwIfAborted(context.signal);
    const assembled=await this.options.buildContext({
      apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION,characterId:character.id,
      conversationId:conversation.id,messages:conversation.messages,budget:this.options.getContextBudget(),
    });
    throwIfAborted(context.signal);
    const promptScenario=context.userTurn?"reactive":"background";
    const promptTextForScenario=(scenario:string)=>this.options.getPrompt
      ?this.options.getPrompt("nova-system-plain",scenario)
      :assemblePromptInstructions(createDefaultPromptConfiguration(),"nova",scenario).text;
    const initialPromptText=promptTextForScenario(promptScenario);
    const schedule=this.options.getCognitiveSchedule?.();
    const scheduleContext=schedule?[
      "Cognitive schedule data (milliseconds):",
      "default="+schedule.defaultIntervalMs,
      "minimum="+schedule.minIntervalMs,
      "maximum="+schedule.maxIntervalMs
    ].join("\n"):"";
    const identity=["[IDENTITY / CHARACTER]","Name: "+character.name,"Description: "+character.description,"[/IDENTITY / CHARACTER]"].join("\n");
    const messages=restoreChatImageAttachments(
      assembled.messages.map(message=>normalizeHistoricalMessage(message)),
      conversation.messages
    );
    if(reactiveUserMessage&&!messages.some(message=>message.id===reactiveUserMessage!.id))messages.push(cloneMessage(reactiveUserMessage));
    const baseMessages:ChatMessage[]=[
      {id:conversation.id+":nova-turn:system",role:"system",content:initialPromptText},
      {id:conversation.id+":nova-turn:identity",role:"system",content:identity},
      {id:conversation.id+":nova-turn:schedule",role:"system",content:scheduleContext},
      ...messages,
    ];
    const providerPresetId=this.options.getActiveProviderPresetId()??this.options.runtime.getActiveProviderPresetId?.();
    const model=providerPresetId?await this.options.getChatModelForPreset(providerPresetId):this.options.getChatModel();
    throwIfAborted(context.signal);
    const request=requestId();
    const turnId=context.userTurn?.turnId??request;
    const capabilities=this.options.runtime.getChatProviderCapabilities?.(providerPresetId);
    const advertised=this.options.getAvailableTools?.()??[];
    const toolDefinitions:ChatToolDefinition[]=capabilities?.toolCalling
      ?advertised.map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters as JsonSchema}))
      :[];
    const allowedToolNames=new Set(toolDefinitions.map(tool=>tool.name));
    const configuredReasoning=this.options.getReasoningOptions?.();
    const reasoningOptions=configuredReasoning&&(configuredReasoning.mode!=="provider-default"||capabilities?.reasoning)?configuredReasoning:undefined;
    const history:ChatMessage[]=[];
    let output:{response:ChatResponse;content:string}={response:undefined as unknown as ChatResponse,content:""};
    let combinedReasoning="";
    let executedCallCount=0;
    let roundsWithToolCalls=0;
    const configuredGeneration=this.options.getGenerationOptions?.();
    const requestGeneration:import("../../contracts/src/index").ChatGenerationOptions={
      ...(configuredGeneration?.temperature!==undefined?{temperature:configuredGeneration.temperature}:{}),
      ...(configuredGeneration?.topP!==undefined?{topP:configuredGeneration.topP}:{}),
      maxTokens:configuredGeneration?.maxTokens??1800,
      ...(configuredGeneration?.repeatPenalty!==undefined?{repeatPenalty:configuredGeneration.repeatPenalty}:{}),
      ...(configuredGeneration?.repeatLastN!==undefined?{repeatLastN:configuredGeneration.repeatLastN}:{}),
      ...(configuredGeneration?.responseFormat!==undefined?{responseFormat:configuredGeneration.responseFormat}:{}),
    };
    let activePromptScenario=promptScenario;
    let activePromptText=initialPromptText;
    const reqFor=(id:string):ChatRequest=>{
      const nextScenario=roundsWithToolCalls>0?promptScenario+"+after-tool":promptScenario;
      if(nextScenario!==activePromptScenario){
        activePromptScenario=nextScenario;
        activePromptText=promptTextForScenario(nextScenario);
      }
      const requestMessages=[...baseMessages.map(cloneMessage),...history.map(cloneMessage)];
      const systemPromptIndex=requestMessages.findIndex(message=>message.id===conversation.id+":nova-turn:system");
      if(systemPromptIndex<0)throw new Error("Nova cognitive request is missing its configured system prompt message.");
      requestMessages[systemPromptIndex]={...requestMessages[systemPromptIndex]!,content:activePromptText};
      return {
        apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:id,model,
        context:{conversationId:conversation.id,messages:requestMessages},
        generation:requestGeneration,
        ...(toolDefinitions.length?{tools:toolDefinitions}:{}),
        ...(reasoningOptions?{reasoning:reasoningOptions}:{}),
        metadata:{cognition:true,protocol:"NATIVE_TOOL_CALLS",protocolVersion:2,outputMode:"plain"},
      };
    };
    while(true){
      throwIfAborted(context.signal);
      const currentRequestId=roundsWithToolCalls===0?request:request+"-tool-"+roundsWithToolCalls;
      const req=reqFor(currentRequestId);
      let rawContent="";
      let deltaCount=0;
      let streamedReasoning="";
      await context.onSpeechEvent?.({type:"start",conversationId:conversation.id});
      const consume=async(text:string)=>{
        if(!text)return;
        rawContent+=text;
        deltaCount++;
        if(rawContent.length>NOVA_TURN_MAX_SERIALIZED_CHARS)throw new Error("Nova's plain-text response exceeds the existing 32000-character cognitive reply safety limit.");
        await context.onSpeechEvent?.({type:"delta",conversationId:conversation.id,text});
      };
      let response:ChatResponse;
      const providerStartedAt=Date.now();
      const providerContext={
        requestId:currentRequestId,turnId,model,toolRound:roundsWithToolCalls,
        ...(providerPresetId?{providerPresetId}:{}),
        ...(this.options.getProviderIdForPreset?.(providerPresetId)?{providerId:this.options.getProviderIdForPreset(providerPresetId)}:{})
      };
      this.diagnostic("nova_life.provider_request.started","Nova Life provider request started.",providerContext);
      try{
        if(this.options.runtime.stream){
          const handlers:ChatStreamHandlers={onEvent:async event=>{
            if(event.type==="delta")await consume(event.text);
            else if(event.type==="reasoning")streamedReasoning+=event.text;
          }};
          response=await this.options.runtime.stream(req,handlers,{signal:context.signal},providerPresetId);
        }else{
          response=await this.options.runtime.chat(req,providerPresetId,{signal:context.signal});
        }
        this.diagnostic("nova_life.provider_request.completed","Nova Life provider request completed.",{
          ...providerContext,durationMs:Math.max(0,Date.now()-providerStartedAt),status:"completed",
          finishReason:response.finishReason,responseCharacters:response.message.content.length,
          toolCallCount:response.message.toolCalls?.length??0
        });
      }catch(error){
        this.diagnostic("nova_life.provider_request.failed","Nova Life provider request failed.",{
          ...providerContext,durationMs:Math.max(0,Date.now()-providerStartedAt),
          status:"failed",errorType:error instanceof Error?error.name:"UnknownError",
          ...(error&&typeof error==="object"&&"code" in error&&typeof (error as {code?:unknown}).code==="string"?{errorCode:(error as {code:string}).code}:{})
        });
        throw error;
      }
      if(this.options.runtime.stream){
        if(deltaCount===0&&response.message.content)await consume(response.message.content);
      }else{
        await consume(response.message.content);
      }
      throwIfAborted(context.signal);
      if(streamedReasoning)combinedReasoning+=streamedReasoning;
      else if(response.reasoning)combinedReasoning+=response.reasoning;
      output={response,content:rawContent};
      const calls=response.message.toolCalls??[];
      if(calls.length===0)break;
      roundsWithToolCalls++;
      if(roundsWithToolCalls>MAX_NATIVE_TOOL_ROUNDS||executedCallCount+calls.length>MAX_NATIVE_TOOL_CALLS){
        throw new Error("Native tool-call loop exceeded its safety limit.");
      }
      history.push({
        id:response.message.id,role:"assistant",content:response.message.content,
        toolCalls:calls.map(call=>({id:call.id,name:call.name,arguments:{...call.arguments}})),
      });
      for(const [index,call] of calls.entries()){
        throwIfAborted(context.signal);
        if(!call.name||JSON.stringify(call.arguments).length>MAX_TOOL_ARGUMENT_CHARS||!call.arguments||typeof call.arguments!=="object"||Array.isArray(call.arguments)){
          throw new Error("Provider returned an invalid native tool call.");
        }
        const callId=turnId+":native-tool:"+call.id;
        let result=this.nativeToolResultCache.get(callId);
        if(!result){
          const nativeCall:NovaToolCall={name:call.name,arguments:call.arguments};
          if(!allowedToolNames.has(call.name)){
            result={callId,name:call.name,status:"unknown-tool",error:"Tool is not registered or was not advertised to this provider."};
          }else if(!this.options.executeTool){
            result={callId,name:call.name,status:"unknown-tool",error:"Secure tool execution is not configured."};
          }else{
            const toolContext={
              characterId:context.characterId,conversationId:conversation.id,turnId,
              ...(context.userTurn?{userMessageId:context.userTurn.userMessageId}:{}),
              requestId:response.requestId,providerId:response.providerId,model:response.model,
              ...(providerPresetId?{providerPresetId}:{}),signal:context.signal,callId,index:executedCallCount,
            };
            try{result=await this.options.executeTool(nativeCall,toolContext);}
            catch(error){result={callId,name:call.name,status:"error",error:error instanceof Error?error.message.slice(0,MAX_TOOL_RESULT_CHARS):"Tool execution failed."};}
          }
          this.nativeToolResultCache.set(callId,result);
          if(this.nativeToolResultCache.size>500)this.nativeToolResultCache.delete(this.nativeToolResultCache.keys().next().value!);
        }
        executedCallCount++;
        history.push({
          id:callId,role:"tool",toolCallId:call.id,toolName:call.name,
          content:safeToolResultText({
            status:result.status,
            ...(result.output===undefined?{}:{output:result.output}),
            ...(result.error?{error:result.error}:{}),
          }),
        });
      }
    }
    throwIfAborted(context.signal);
    if(context.userTurn&&!output.content.trim())throw new Error("Nova returned no speech for this user message. Retry the Nova Life turn.");
    const scheduledInterval=this.options.consumeRequestedWakeInterval?.(turnId);
    const turn:NovaTurn={
      version:1,situation:"",thoughts:"",emotion:"",tools:[],toolResults:[],
      speech:output.content,nextWakeMs:typeof scheduledInterval==="number"?scheduledInterval:defaultCognitiveInterval(schedule),
    };
    return {
      turn,conversationId:conversation.id,requestId:output.response.requestId||request,providerId:output.response.providerId,model:output.response.model,
      ...(providerPresetId?{providerPresetId}:{}),
      ...(this.options.getShowReasoningInDiagnostics?.()&&combinedReasoning?{reasoning:combinedReasoning.slice(0,8_000)}:{}),
      protocolDiagnostics:["native-tool-protocol"],
    };
  }
}
