import type {AssembledContext,Character,ChatMessage,ChatRequest,ChatRequestOptions,ChatResponse,ContextBuildRequest,ContextBudget,Conversation,CognitiveScheduleSettings,MindState,Thought} from "../../contracts/src";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,CONTEXT_API_VERSION,CONTEXT_SCHEMA_VERSION} from "../../contracts/src";
import type {CognitiveStep,CognitiveStepContext,CognitiveStepResult} from "./mind-runtime";

export interface CognitiveChatRuntime{chat(request:ChatRequest,providerPresetId?:string,options?:ChatRequestOptions):Promise<ChatResponse>;getActiveProviderPresetId?():string|undefined;getChatModel?():string;getChatModelForPreset?(providerPresetId:string):Promise<string>;}
export interface LLMCognitiveStepOptions{runtime:CognitiveChatRuntime;getCharacter:(characterId:string)=>Promise<Character|undefined>;getActiveConversation:(characterId:string)=>Promise<Conversation|undefined>;buildContext:(request:ContextBuildRequest)=>Promise<AssembledContext>;getContextBudget:()=>ContextBudget;getActiveProviderPresetId:()=>string|undefined;getChatModel:()=>string;getChatModelForPreset:(providerPresetId:string)=>Promise<string>;clock?:()=>string;getCognitiveSchedule?:()=>CognitiveScheduleSettings;}
const COGNITIVE_SYSTEM_PROMPT=["You are Nova.","You are in a continuous internal thinking process.","This step creates exactly one internal thought. You do not need to speak to the user.","A thought may continue or reconsider a previous thought, notice something relevant in the conversation, recall relevant memory, form interest, change focus, notice uncertainty, or simply consider something important to Nova.","Do not create fictional events. Do not claim Nova did something unless that action is present in context.","Do not invent external events that are not present in context.","Do not create meaningless thoughts merely to keep the loop running.","The existence of a new cognitive step is never itself a reason to answer the user.","Return one JSON object with a non-empty string field thought and, when adaptive scheduling is enabled, an integer nextWakeInMs within the supplied bounds.","Do not include a reason for the selected interval.","Do not write a chat response, speech, action, tool call, question to the user, goal, intention, plan, or emotion analysis."].join("\n");
const COGNITIVE_USER_CUE="Continue the internal cognition step. Produce exactly one internal thought based on the context above. Do not answer the user.";
function requestId():string{return "cognition-"+Date.now()+"-"+Math.random().toString(36).slice(2,10);}
function parseCognitiveResponse(content:string):{thought:string;nextWakeInMs?:unknown}{
  const trimmed=content.trim();if(!trimmed)throw new Error("Cognitive provider returned an empty thought.");
  const fenced=trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate=(fenced?.[1]??trimmed).trim();
  if(candidate.startsWith("{")||candidate.startsWith("[")){
    let parsed:unknown;
    try{parsed=JSON.parse(candidate);}catch{throw new Error("Cognitive provider returned malformed JSON.");}
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||!("thought" in parsed))throw new Error("Cognitive provider JSON is missing the thought field.");
    const record=parsed as {thought?:unknown;nextWakeInMs?:unknown};
    if(typeof record.thought!=="string"||!record.thought.trim())throw new Error("Cognitive provider JSON contains an invalid thought.");
    if(record.thought.length>8000)throw new Error("Cognitive provider thought exceeds the allowed length.");
    return {thought:record.thought.trim(),...(Object.prototype.hasOwnProperty.call(record,"nextWakeInMs")?{nextWakeInMs:record.nextWakeInMs}:{})};
  }
  const plain=fenced?candidate:trimmed;
  if(!plain||plain.length>8000)throw new Error("Cognitive provider thought is empty or exceeds the allowed length.");
  return {thought:plain};
}
function throwIfAborted(signal:AbortSignal):void{if(signal.aborted)throw MindRuntimeAbortError();}

function cloneMessage(message:ChatMessage):ChatMessage{return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})};}

export class LLMCognitiveStep implements CognitiveStep{
  private readonly clock:()=>string;constructor(private readonly options:LLMCognitiveStepOptions){this.clock=options.clock??(()=>new Date().toISOString());}
  async run(context:CognitiveStepContext):Promise<CognitiveStepResult>{
    throwIfAborted(context.signal);
    const character=await this.options.getCharacter(context.characterId);if(!character)throw new Error("Cognitive character is not available.");
    throwIfAborted(context.signal);
    const conversation=await this.options.getActiveConversation(context.characterId);if(!conversation)throw new Error("No active conversation is available for cognitive step.");
    throwIfAborted(context.signal);
    const assembled=await this.options.buildContext({apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION,characterId:character.id,conversationId:conversation.id,messages:conversation.messages,budget:this.options.getContextBudget()});
    throwIfAborted(context.signal);
    const schedule=this.options.getCognitiveSchedule?.();
    const scheduleContext=schedule?["[COGNITIVE SCHEDULE]","Mode: "+schedule.mode,"Default next wake interval: "+schedule.defaultIntervalMs+" ms","Allowed next wake interval: "+schedule.minIntervalMs+" to "+schedule.maxIntervalMs+" ms","Return nextWakeInMs as an integer in that range only when mode is adaptive. In fixed mode, do not select a different interval.","[/COGNITIVE SCHEDULE]"].join("\n"):"";
    const mindContext=[this.buildMindContext(context.state),scheduleContext].filter(Boolean).join("\n");
    const identityContext=["[IDENTITY / CHARACTER]","Name: "+character.name,"Description: "+character.description,"[/IDENTITY / CHARACTER]"].join("\n");
    const contextMessages:ChatMessage[]=[
      {id:conversation.id+":cognition:system",role:"system",content:COGNITIVE_SYSTEM_PROMPT},
      {id:conversation.id+":cognition:identity",role:"system",content:identityContext},
      {id:conversation.id+":cognition:mind",role:"system",content:mindContext},
      ...assembled.messages.map(cloneMessage),
      {id:conversation.id+":cognition:user-cue",role:"user",content:COGNITIVE_USER_CUE}
    ];
    const providerPresetId=this.options.getActiveProviderPresetId();const model=providerPresetId?await this.options.getChatModelForPreset(providerPresetId):this.options.getChatModel();
    throwIfAborted(context.signal);
    const request=requestId();
    const baseRequest:ChatRequest={apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:request,model,context:{conversationId:conversation.id,messages:contextMessages},generation:{maxTokens:256,responseFormat:{type:"text"}},metadata:{cognition:true}};
    const response=await this.options.runtime.chat(baseRequest,providerPresetId,{signal:context.signal});
    throwIfAborted(context.signal);
    const result=parseCognitiveResponse(response.message.content);
    return {thought:{characterId:context.characterId,id:"thought:"+request,timestamp:this.clock(),content:result.thought,expression:"internal"},nextWakeInMs:result.nextWakeInMs,requestId:response.requestId,providerId:response.providerId};
  }
  private buildMindContext(state:Readonly<MindState>):string{
    const history=state.recentThoughts.length===0?"No previous internal thoughts.":state.recentThoughts.map((thought,index)=>"Thought "+(index+1)+": "+thought.content).join("\n");
    return ["[INTERNAL THOUGHT HISTORY]",history,"[/INTERNAL THOUGHT HISTORY]","[CURRENT MIND STATE]","Focus: "+(state.focus??"(none)"),"Lifecycle state: "+state.lifecycleState,"Last thought timestamp: "+(state.lastThoughtAt??"(none)"),"Last thought: "+(state.lastThought?.content??"(none)"),"[/CURRENT MIND STATE]","[COGNITION CONTEXT]","The internal thought history above is private cognition context. It is not a conversation message and must not be emitted as chat.","[/COGNITION CONTEXT]"].join("\n");
  }
}
function MindRuntimeAbortError():Error{const error=new Error("Mind Runtime cognitive step aborted.");error.name="AbortError";return error;}