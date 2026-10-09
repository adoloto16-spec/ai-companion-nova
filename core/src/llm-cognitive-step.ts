import type {AssembledContext,Character,ChatMessage,ChatRequest,ChatRequestOptions,ChatResponse,ContextBuildRequest,ContextBudget,Conversation,CognitiveScheduleSettings,MindExpressionCandidate,MindInitiativeUpdate,MindReactiveTurn,MindState,Thought} from "../../contracts/src";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,CONTEXT_API_VERSION,CONTEXT_SCHEMA_VERSION,validateMindInitiativeUpdate} from "../../contracts/src";
import type {CognitiveStep,CognitiveStepContext,CognitiveStepResult} from "./mind-runtime";

export interface CognitiveChatRuntime{chat(request:ChatRequest,providerPresetId?:string,options?:ChatRequestOptions):Promise<ChatResponse>;getActiveProviderPresetId?():string|undefined;getChatModel?():string;getChatModelForPreset?(providerPresetId:string):Promise<string>;}
export interface LLMCognitiveStepOptions{runtime:CognitiveChatRuntime;getCharacter:(characterId:string)=>Promise<Character|undefined>;getActiveConversation:(characterId:string)=>Promise<Conversation|undefined>;buildContext:(request:ContextBuildRequest)=>Promise<AssembledContext>;getContextBudget:()=>ContextBudget;getActiveProviderPresetId:()=>string|undefined;getChatModel:()=>string;getChatModelForPreset:(providerPresetId:string)=>Promise<string>;clock?:()=>string;getCognitiveSchedule?:()=>CognitiveScheduleSettings;}
const COGNITIVE_SYSTEM_PROMPT=[
"You are Nova, the character described in the supplied context, not an outside observer or technical agent.",
"Each cognitive step always creates exactly one short private internal thought. That thought stays private and is never copied into Chat.",
"For scheduled/background cognition, a public message is optional and private thought is the default. A correlated reactive user turn is different: its final cue requires a separate public chat reply.",
"Return one JSON object with a non-empty string field thought, an optional expression object and optional initiative update, and, when adaptive scheduling is enabled, an integer nextWakeInMs within the supplied bounds.",
"An initiative update is {\"decision\":\"continue|switch|pause|finish\"} with optional direction and progress strings. Use switch with a distinct non-empty focus (max 160 characters) to choose a new topic; continue keeps the current focus. pause temporarily defers the topic; finish marks it completed.",
"Direction (max 280 characters) should name a useful angle of inquiry. progress (max 1000 characters) must describe a real new insight from this step, not a plan or invented progress. Omit progress when nothing meaningful changed. If no focus exists, use switch to begin an initiative. Do not switch merely because another wake occurred. If an initiative is completed, do not continue it out of habit; begin a new topic only when there is a genuine new interest.",
"Use expression {\"kind\":\"internal\"} when there is nothing to share, or {\"kind\":\"chat\",\"content\":\"a separate finished message for the user\"} when you choose to speak.",
"The chat content must stand on its own as ordinary text for the user. Never put the private thought, raw internal reasoning, context dump, or technical JSON in that content.",
"You may continue a genuinely interesting topic, share a grounded observation from existing context, or ask a relevant question. You do not need to speak on every wake and must not automatically ask a question or append a question to every message.",
"The existence of a scheduled wake is never itself a reason to speak. Do not repeat the immediately preceding assistant message or paraphrase recent Thoughts without a real reason.",
"Make private Thoughts substantive: add an observation, reconsideration, or meaningful continuation of the actual topic when something has changed. Avoid diagnostic/test narration, prompt-compliance commentary, internal pipeline descriptions, and repeated statements of what you plan to do. Do not fill space with generic remarks about balance or testing. If nothing meaningful has changed, a brief Thought is acceptable.",
"Do not invent external events, actions, memories, or facts. Do not claim Nova did something unless it is supported by supplied context.",
"Do not include a reason for selecting the next interval or for deciding to speak.",
"Do not return tool calls, actions, plans, goals, speech instructions, emotion analysis, or any other behavior outside a private thought and optional plain-text chat expression."
].join("\n");
const COGNITIVE_USER_CUE="Continue Nova's internal cognition. Produce exactly one private Thought based on the actual topic and recent context. On this scheduled/background step, you may either keep the Thought private or send one distinct, meaningful chat expression. Do not repeat the previous message just to keep the loop active. If the user explicitly requested several separate messages, you may send at most one per step and should stop once that bounded request is complete.";
const REACTIVE_USER_CUE="You are Nova answering the latest persisted user message as Nova. This is a response-required user turn: include exactly one ordinary user-facing reply in expression {\"kind\":\"chat\",\"content\":\"...\"}. Consider the user's message and existing conversation context; do not narrate internal planning, diagnostics, prompt instructions, or the process by which you chose the words or next wake interval. Separately produce one private Thought. Keep that Thought out of the public reply.";
const LIFE_START_USER_CUE="This is a Life startup step. Produce one private Thought; do not send an unsolicited startup greeting by default. A public chat expression is not required.";
const OTHER_WAKE_USER_CUE="Continue private Nova cognition using the actual conversation topic and recent Thought history. A public chat expression is optional only when genuinely useful. Do not turn this into a narration of internal steps.";
function requestId():string{return "cognition-"+Date.now()+"-"+Math.random().toString(36).slice(2,10);}
interface ParsedCognitiveResponse{thought:string;nextWakeInMs?:unknown;expression?:MindExpressionCandidate;expressionInvalid?:boolean;initiative?:MindInitiativeUpdate;}
function parseCognitiveResponse(content:string):ParsedCognitiveResponse{
  const trimmed=content.trim();if(!trimmed)throw new Error("Cognitive provider returned an empty thought.");
  const fenced=trimmed.match(/^\u0060\u0060\u0060(?:json)?\s*([\s\S]*?)\s*\u0060\u0060\u0060$/i);
  const candidate=(fenced?.[1]??trimmed).trim();
  if(candidate.startsWith("{")||candidate.startsWith("[")){
    let parsed:unknown;
    try{parsed=JSON.parse(candidate);}catch{throw new Error("Cognitive provider returned malformed JSON.");}
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("Cognitive provider JSON is not an object.");
    const record=parsed as Record<string,unknown>;
    if(typeof record.thought!=="string"||!record.thought.trim())throw new Error("Cognitive provider JSON contains an invalid thought.");
    if(record.thought.length>8000)throw new Error("Cognitive provider thought exceeds the allowed length.");
    const allowedKeys=new Set(["thought","nextWakeInMs","expression","initiative"]);
    let expression:MindExpressionCandidate|undefined;
    let expressionInvalid=Object.keys(record).some(key=>!allowedKeys.has(key));
    if(Object.prototype.hasOwnProperty.call(record,"expression")){
      const raw=record.expression;
      if(raw&&typeof raw==="object"&&!Array.isArray(raw)){
        const value=raw as Record<string,unknown>,keys=Object.keys(value);
        if(value.kind==="internal"&&keys.length===1&&keys[0]==="kind"&&!expressionInvalid)expression={kind:"internal"};
        else if(value.kind==="chat"&&keys.length===2&&keys.includes("kind")&&keys.includes("content")&&typeof value.content==="string"&&value.content.trim().length>0&&value.content.length<=2000&&!expressionInvalid)expression={kind:"chat",content:value.content.trim()};
        else expressionInvalid=true;
      }else expressionInvalid=true;
    }
    if(expressionInvalid)expression=undefined;
    const initiative=Object.prototype.hasOwnProperty.call(record,"initiative")?validateMindInitiativeUpdate(record.initiative):undefined;
    return {thought:record.thought.trim(),...(Object.prototype.hasOwnProperty.call(record,"nextWakeInMs")?{nextWakeInMs:record.nextWakeInMs}:{}),...(expression?{expression}:{}),...(expressionInvalid?{expressionInvalid:true}:{}),...(initiative?{initiative}:{})};
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
    if(conversation.characterId!==character.id)throw new Error("Cognitive conversation character scope mismatch.");
    let reactiveUserMessage:ChatMessage|undefined;
    if(context.userTurn){
      const turn=context.userTurn;
      if(context.wakeReason!=="user-message"||turn.characterId!==character.id||turn.conversationId!==conversation.id)throw new Error("Reactive user turn scope does not match the active cognitive conversation.");
      const messages=[...conversation.messages];
      let latestUser:ChatMessage|undefined;
      for(let index=messages.length-1;index>=0;index--){if(messages[index]?.role==="user"){latestUser=messages[index];break;}}
      const userIndex=messages.findIndex(message=>message.id===turn.userMessageId);
      if(!latestUser||latestUser.id!==turn.userMessageId||userIndex<0||messages.slice(userIndex+1).some(message=>message.role==="assistant"))throw new Error("Reactive user turn is missing, stale, or already answered in the persisted conversation.");
      reactiveUserMessage=cloneMessage(latestUser);
    }
    throwIfAborted(context.signal);
    const assembled=await this.options.buildContext({apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION,characterId:character.id,conversationId:conversation.id,messages:conversation.messages,budget:this.options.getContextBudget()});
    throwIfAborted(context.signal);
    const schedule=this.options.getCognitiveSchedule?.();
    const scheduleContext=schedule?["[COGNITIVE SCHEDULE]","Mode: "+schedule.mode,"Default next wake interval: "+schedule.defaultIntervalMs+" ms","Allowed next wake interval: "+schedule.minIntervalMs+" to "+schedule.maxIntervalMs+" ms","Return nextWakeInMs as an integer in that range only when mode is adaptive. In fixed mode, do not select a different interval.","[/COGNITIVE SCHEDULE]"].join("\n"):"";
    const mindContext=[this.buildMindContext(context.state),scheduleContext].filter(Boolean).join("\n");
    const identityContext=["[IDENTITY / CHARACTER]","Name: "+character.name,"Description: "+character.description,"[/IDENTITY / CHARACTER]"].join("\n");
    const assembledMessages=assembled.messages.map(cloneMessage);
    if(reactiveUserMessage&&!assembledMessages.some(message=>message.id===reactiveUserMessage!.id))assembledMessages.push(reactiveUserMessage);
    const userCue=context.userTurn?REACTIVE_USER_CUE:context.wakeReason==="life-start"?LIFE_START_USER_CUE:context.wakeReason==="scheduled"?COGNITIVE_USER_CUE:OTHER_WAKE_USER_CUE;
    const contextMessages:ChatMessage[]=[
      {id:conversation.id+":cognition:system",role:"system",content:COGNITIVE_SYSTEM_PROMPT},
      {id:conversation.id+":cognition:identity",role:"system",content:identityContext},
      {id:conversation.id+":cognition:mind",role:"system",content:mindContext},
      ...assembledMessages,
      {id:conversation.id+":cognition:user-cue",role:"user",content:userCue}
    ];
    const providerPresetId=this.options.getActiveProviderPresetId();const model=providerPresetId?await this.options.getChatModelForPreset(providerPresetId):this.options.getChatModel();
    throwIfAborted(context.signal);
    const request=requestId();
    const baseRequest:ChatRequest={apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:request,model,context:{conversationId:conversation.id,messages:contextMessages},generation:{maxTokens:1024,responseFormat:{type:"text"}},metadata:{cognition:true}};
    const response=await this.options.runtime.chat(baseRequest,providerPresetId,{signal:context.signal});
    throwIfAborted(context.signal);
    const result=parseCognitiveResponse(response.message.content);
    return {thought:{characterId:context.characterId,id:"thought:"+request,timestamp:this.clock(),content:result.thought,expression:"internal"},nextWakeInMs:result.nextWakeInMs,...(result.expression?{expression:result.expression}:{}),...(result.expressionInvalid?{expressionInvalid:true}:{}),conversationId:conversation.id,requestId:response.requestId,providerId:response.providerId,model:response.model,...(providerPresetId?{providerPresetId}:{})};
  }
  private buildMindContext(state:Readonly<MindState>):string{
    const history=state.recentThoughts.length===0?"No previous internal thoughts.":state.recentThoughts.map((thought,index)=>"Thought "+(index+1)+": "+thought.content).join("\n");
    return ["[INTERNAL THOUGHT HISTORY]",history,"[/INTERNAL THOUGHT HISTORY]","[CURRENT MIND STATE]","Focus: "+(state.focus??"(none)"),"Initiative status: "+(state.initiative?.status??"(none)"),"Initiative direction: "+(state.initiative?.direction??"(none)"),"Last meaningful progress: "+(state.initiative?.lastProgress??"(none)"),"Lifecycle state: "+state.lifecycleState,"Last thought timestamp: "+(state.lastThoughtAt??"(none)"),"Last thought: "+(state.lastThought?.content??"(none)"),"[/CURRENT MIND STATE]","[COGNITION CONTEXT]","The internal thought history and initiative fields are private cognition context, not conversation messages. Do not output them as chat. Develop the actual topic with a substantive observation or revision rather than narrating plans or internal mechanisms.","[/COGNITION CONTEXT]"].join("\n");
  }
}
function MindRuntimeAbortError():Error{const error=new Error("Mind Runtime cognitive step aborted.");error.name="AbortError";return error;}
