import type {AssembledContext,Character,ChatMessage,ChatRequest,ChatRequestOptions,ChatResponse,ContextBuildRequest,ContextBudget,Conversation,CognitiveScheduleSettings,MindReactiveTurn} from "../../contracts/src";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,CONTEXT_API_VERSION,CONTEXT_SCHEMA_VERSION,parseNovaTurn} from "../../contracts/src";
import type {NovaTurn} from "../../contracts/src/nova-turn";
import type {CognitiveStep,CognitiveStepContext,CognitiveStepResult} from "./mind-runtime";

export interface CognitiveChatRuntime {
  chat(request:ChatRequest,providerPresetId?:string,options?:ChatRequestOptions):Promise<ChatResponse>;
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
  getAvailableTools?:()=>readonly {name:string;description:string;parameters:unknown}[];
  clock?:()=>string;
}
const NOVA_TURN_SYSTEM_PROMPT=[
  "You are Nova. Return exactly one complete NOVA_TURN protocol version 1, as plain text with tags, not JSON and not Markdown fences.",
  "The top-level field order is SITUATION, THOUGHTS, EMOTION, TOOLS, SPEECH, NEXT_WAKE_MS. Each field occurs once. Escape literal XML-like text in field content as &lt; and &gt;, and &amp; for ampersands, so quoted input or examples resembling tags are never mistaken for control delimiters.",
  "SITUATION is a concise view of the current situation, current focus, and continuation or change of initiative. Keep initiative continuation here; do not produce a separate initiative object.",
  "THOUGHTS contains private internal notes. Never copy it into SPEECH, and never use it as the public answer. EMOTION is a brief description of the current emotional state.",
  "TOOLS contains zero or more calls. Each call is a tag whose name exactly matches a registered tool name and whose content is a JSON object of validated arguments. Request only tools listed below. Do not invent tools or claim a result before it is returned. A tool call is not a claim that it succeeded.",
  "SPEECH is the ready-to-send user-facing text, or empty only for a background wake when there is no useful thing to say. On a reactive turn answering a persisted user message, SPEECH must be non-empty and answer that user.",
  "NEXT_WAKE_MS must be a positive integer number of milliseconds within the supplied schedule bounds. Output all required tags even when TOOLS and SPEECH are empty.",
  "Example with two tool calls: <NOVA_TURN version=\"1\"><SITUATION>Check saved preferences and confirm the source.</SITUATION><THOUGHTS>Use only actual tool results.</THOUGHTS><EMOTION>Focused.</EMOTION><TOOLS><read_memory>{\"query\":\"saved travel preferences\"}</read_memory><browser.navigate>{\"url\":\"https://wikipedia.org/\"}</browser.navigate></TOOLS><SPEECH>I’ll check the relevant details.</SPEECH><NEXT_WAKE_MS>30000</NEXT_WAKE_MS></NOVA_TURN>",
  "Never return text outside the NOVA_TURN wrapper. Never replace missing fields with a raw response, guessed fact, invented tool output, or private thoughts.",
].join("\n");
const REACTIVE_CUE="Answer the latest persisted user message now. This is a response-required turn: NOVA_TURN.SPEECH must be non-empty and directly answer the user. Use context and registered tools as needed. Preserve the required protocol exactly.";
const BACKGROUND_CUE="Continue Nova's cognition from the actual conversation context. Speaking is optional; if there is nothing useful to tell the user, leave SPEECH empty. Use the single NovaTurn format. Do not narrate internal processing.";
function throwIfAborted(signal:AbortSignal):void { if(signal.aborted){const error=new Error("Mind Runtime cognitive step aborted.");error.name="AbortError";throw error;} }
function cloneMessage(message:ChatMessage):ChatMessage { return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})}; }
function escapeUntrustedUserText(value:string):string {
  return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function requestId():string { return "nova-turn-"+Date.now()+"-"+Math.random().toString(36).slice(2,10); }

export class LLMCognitiveStep implements CognitiveStep {
  private readonly clock:()=>string;
  constructor(private readonly options:LLMCognitiveStepOptions){this.clock=options.clock??(()=>new Date().toISOString());}
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
      apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION,characterId:character.id,conversationId:conversation.id,
      messages:conversation.messages,budget:this.options.getContextBudget(),
    });
    throwIfAborted(context.signal);
    const schedule=this.options.getCognitiveSchedule?.();
    const scheduleContext=schedule?[
      "[COGNITIVE SCHEDULE]",
      "Default next wake interval: "+schedule.defaultIntervalMs+" ms",
      "Allowed next wake interval: "+schedule.minIntervalMs+" to "+schedule.maxIntervalMs+" ms",
      "Return NEXT_WAKE_MS as a positive integer in these bounds. Runtime enforces the bounds.",
      "[/COGNITIVE SCHEDULE]",
    ].join("\n"):"";
    const toolDefinitions=this.options.getAvailableTools?.()??[];
    const toolContext=["[REGISTERED TOOLS]",JSON.stringify(toolDefinitions),"Only these registered tools may be requested.","[/REGISTERED TOOLS]"].join("\n");
    const identity=["[IDENTITY / CHARACTER]","Name: "+character.name,"Description: "+character.description,"[/IDENTITY / CHARACTER]"].join("\n");
    const messages=assembled.messages.map(message=>{
      const copy=cloneMessage(message);
      // Keep user-supplied tag-like text as content rather than allowing it to imitate protocol delimiters.
      if(copy.role==="user")copy.content=escapeUntrustedUserText(copy.content);
      return copy;
    });
    if(reactiveUserMessage&&!messages.some(message=>message.id===reactiveUserMessage!.id)){
      const copy=cloneMessage(reactiveUserMessage);copy.content=escapeUntrustedUserText(copy.content);messages.push(copy);
    }
    const cue=context.userTurn?REACTIVE_CUE:BACKGROUND_CUE;
    const contextMessages:ChatMessage[]=[
      {id:conversation.id+":nova-turn:system",role:"system",content:NOVA_TURN_SYSTEM_PROMPT},
      {id:conversation.id+":nova-turn:identity",role:"system",content:identity},
      {id:conversation.id+":nova-turn:schedule",role:"system",content:[scheduleContext,toolContext].filter(Boolean).join("\n")},
      ...messages,
      // Keep the synthetic user cue last; Mistral-compatible providers depend on valid final role ordering.
      {id:conversation.id+":nova-turn:user-cue",role:"user",content:cue},
    ];
    const providerPresetId=this.options.getActiveProviderPresetId();
    const model=providerPresetId?await this.options.getChatModelForPreset(providerPresetId):this.options.getChatModel();
    throwIfAborted(context.signal);
    const request=requestId();
    const chatRequest:ChatRequest={
      apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:request,model,
      context:{conversationId:conversation.id,messages:contextMessages},
      generation:{maxTokens:1800,responseFormat:{type:"text"}},
      metadata:{cognition:true,protocol:"NOVA_TURN",protocolVersion:1},
    };
    const response=await this.options.runtime.chat(chatRequest,providerPresetId,{signal:context.signal});
    throwIfAborted(context.signal);
    const parsed=parseNovaTurn(response.message.content);
    if(!parsed.turn)throw new Error("Provider response did not contain one unambiguous, valid SPEECH block in NOVA_TURN v1. Diagnostics: "+parsed.diagnostics.join(", "));
    if(parsed.diagnostics.length&&!parsed.complete){
      // A unique valid SPEECH may be committed while malformed optional fields remain empty and diagnosed.
    }
    const turn:NovaTurn=parsed.turn;
    return {
      turn,conversationId:conversation.id,requestId:response.requestId||request,providerId:response.providerId,model:response.model,
      ...(providerPresetId?{providerPresetId}:{}),protocolDiagnostics:parsed.diagnostics,
    };
  }
}
