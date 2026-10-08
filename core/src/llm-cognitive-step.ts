import type {AssembledContext,Character,ChatMessage,ChatRequest,ChatResponse,ContextBuildRequest,ContextBudget,Conversation,MindState,Thought} from "../../contracts/src";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,CONTEXT_API_VERSION,CONTEXT_SCHEMA_VERSION} from "../../contracts/src";
import type {CognitiveStep,CognitiveStepContext} from "./mind-runtime";

export interface CognitiveChatRuntime{chat(request:ChatRequest,providerPresetId?:string):Promise<ChatResponse>;getActiveProviderPresetId?():string|undefined;getChatModel?():string;getChatModelForPreset?(providerPresetId:string):Promise<string>;}
export interface LLMCognitiveStepOptions{runtime:CognitiveChatRuntime;getCharacter:(characterId:string)=>Promise<Character|undefined>;getActiveConversation:(characterId:string)=>Promise<Conversation|undefined>;buildContext:(request:ContextBuildRequest)=>Promise<AssembledContext>;getContextBudget:()=>ContextBudget;getActiveProviderPresetId:()=>string|undefined;getChatModel:()=>string;getChatModelForPreset:(providerPresetId:string)=>Promise<string>;clock?:()=>string;}
const COGNITIVE_SYSTEM_PROMPT=["You are Nova.","You are in a continuous internal thinking process.","This step creates exactly one internal thought. You do not need to speak to the user.","A thought may continue or reconsider a previous thought, notice something relevant in the conversation, recall relevant memory, form interest, change focus, notice uncertainty, or simply consider something important to Nova.","Do not create fictional events. Do not claim Nova did something unless that action is present in context.","Do not invent external events that are not present in context.","Do not create meaningless thoughts merely to keep the loop running.","The existence of a new cognitive step is never itself a reason to answer the user.","Return only the thought content. Do not write a chat response, speech, action, tool call, question to the user, goal, intention, plan, or emotion analysis."].join("\n");
function requestId():string{return "cognition-"+Date.now()+"-"+Math.random().toString(36).slice(2,10);}
function parseThoughtContent(content:string):string{
  const trimmed=content.trim();if(!trimmed)throw new Error("Cognitive provider returned an empty thought.");
  const withoutFence=trimmed.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
  try{const parsed=JSON.parse(withoutFence) as unknown;if(parsed&&typeof parsed==="object"&&"thought" in parsed){const thought=(parsed as {thought?:unknown}).thought;if(typeof thought==="string"&&thought.trim())return thought.trim();}}catch{/* plain text is the safe fallback */}
  return trimmed;
}
function cloneMessage(message:ChatMessage):ChatMessage{return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})};}

export class LLMCognitiveStep implements CognitiveStep{
  private readonly clock:()=>string;constructor(private readonly options:LLMCognitiveStepOptions){this.clock=options.clock??(()=>new Date().toISOString());}
  async run(context:CognitiveStepContext):Promise<Thought>{
    if(context.signal.aborted)throw MindRuntimeAbortError();
    const character=await this.options.getCharacter(context.characterId);if(!character)throw new Error("Cognitive character is not available.");
    const conversation=await this.options.getActiveConversation(context.characterId);if(!conversation)throw new Error("No active conversation is available for cognitive step.");
    const assembled=await this.options.buildContext({apiVersion:CONTEXT_API_VERSION,schemaVersion:CONTEXT_SCHEMA_VERSION,characterId:character.id,conversationId:conversation.id,messages:conversation.messages,budget:this.options.getContextBudget()});
    const mindContext=this.buildMindContext(context.state);
    const identityContext=["[IDENTITY / CHARACTER]","Name: "+character.name,"Description: "+character.description,"[/IDENTITY / CHARACTER]"].join("\n");
    const contextMessages:ChatMessage[]=[{id:conversation.id+":cognition:system",role:"system",content:COGNITIVE_SYSTEM_PROMPT},{id:conversation.id+":cognition:identity",role:"system",content:identityContext},{id:conversation.id+":cognition:mind",role:"system",content:mindContext},...assembled.messages.map(cloneMessage)];
    const providerPresetId=this.options.getActiveProviderPresetId();const model=providerPresetId?await this.options.getChatModelForPreset(providerPresetId):this.options.getChatModel();
    const baseRequest:ChatRequest={apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:requestId(),model,context:{conversationId:conversation.id,messages:contextMessages},generation:{maxTokens:256,responseFormat:{type:"text"}},metadata:{cognition:true}};
    const response=await this.options.runtime.chat(baseRequest,providerPresetId);
    const content=parseThoughtContent(response.message.content);
    return {characterId:context.characterId,id:"thought:"+requestId(),timestamp:this.clock(),content,expression:"internal"};
  }
  private buildMindContext(state:Readonly<MindState>):string{
    const history=state.recentThoughts.length===0?"No previous internal thoughts.":state.recentThoughts.map((thought,index)=>"Thought "+(index+1)+": "+thought.content).join("\n");
    return ["[INTERNAL THOUGHT HISTORY]",history,"[/INTERNAL THOUGHT HISTORY]","[CURRENT MIND STATE]","Focus: "+(state.focus??"(none)"),"Lifecycle state: "+state.lifecycleState,"Last thought timestamp: "+(state.lastThoughtAt??"(none)"),"Last thought: "+(state.lastThought?.content??"(none)"),"[/CURRENT MIND STATE]","[COGNITION CONTEXT]","The internal thought history above is private cognition context. It is not a conversation message and must not be emitted as chat.","[/COGNITION CONTEXT]"].join("\n");
  }
}
function MindRuntimeAbortError():Error{const error=new Error("Mind Runtime cognitive step aborted.");error.name="AbortError";return error;}