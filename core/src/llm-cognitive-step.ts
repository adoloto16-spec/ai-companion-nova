import {resolvePromptText} from "../../contracts/src";
import type {PromptId} from "../../contracts/src";
import type {AssembledContext,Character,ChatMessage,ChatRequest,ChatRequestOptions,ChatResponse,ChatStreamHandlers,ContextBuildRequest,ContextBudget,Conversation,CognitiveScheduleSettings,MindReactiveTurn,ProviderCapabilities} from "../../contracts/src";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION,CONTEXT_API_VERSION,CONTEXT_SCHEMA_VERSION,MinimalJsonSchemaValidator,parseNovaTurn,STANDARD_SCHEMAS} from "../../contracts/src";
import {NovaTurnJsonSpeechStreamDecoder,NovaTurnTaggedSpeechStreamDecoder} from "./nova-turn-stream-decoders";
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
  getOutputMode?:()=> "structured"|"plain";
  getPrompt?:(id:PromptId)=>string;
  getAvailableTools?:()=>readonly {name:string;description:string;parameters:unknown}[];
  clock?:()=>string;
}
function defaultCognitiveInterval(schedule:CognitiveScheduleSettings|undefined):number{
  if(!schedule)return 30_000;
  return Math.min(schedule.maxIntervalMs,Math.max(schedule.minIntervalMs,schedule.defaultIntervalMs));
}
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
    const outputMode=this.options.getOutputMode?.()??"structured";
    const promptText=(id:PromptId)=>this.options.getPrompt?.(id)??resolvePromptText(undefined,id);
    const schedule=this.options.getCognitiveSchedule?.();
    const scheduleContext=schedule?[
      "[COGNITIVE SCHEDULE]",
      "Default next wake interval: "+schedule.defaultIntervalMs+" ms",
      "Allowed next wake interval: "+schedule.minIntervalMs+" to "+schedule.maxIntervalMs+" ms",
      outputMode==="structured"
        ?"Return NEXT_WAKE_MS as a positive integer in these bounds. Runtime enforces the bounds."
        :"The runtime uses the configured default interval, clamped to these bounds. Do not output scheduling metadata.",
      "[/COGNITIVE SCHEDULE]",
    ].join("\n"):"";
    const toolDefinitions=outputMode==="structured"?(this.options.getAvailableTools?.()??[]):[];
    const toolContext=outputMode==="structured"
      ?["[REGISTERED TOOLS]",JSON.stringify(toolDefinitions),"Only these registered tools may be requested.","[/REGISTERED TOOLS]"].join("\n")
      :"";
    const identity=["[IDENTITY / CHARACTER]","Name: "+character.name,"Description: "+character.description,"[/IDENTITY / CHARACTER]"].join("\n");
    const messages=assembled.messages.map(message=>cloneMessage(message));
    if(reactiveUserMessage&&!messages.some(message=>message.id===reactiveUserMessage!.id))messages.push(cloneMessage(reactiveUserMessage));
    const cue=outputMode==="structured"
      ?promptText(context.userTurn?"nova-cue-reactive-tagged":"nova-cue-background-tagged")
      :promptText(context.userTurn?"nova-cue-reactive-plain":"nova-cue-background-plain");
    const contextMessages:ChatMessage[]=[
      {id:conversation.id+":nova-turn:system",role:"system",content:promptText(outputMode==="structured"?"nova-system-tagged":"nova-system-plain")},
      {id:conversation.id+":nova-turn:identity",role:"system",content:identity},
      {id:conversation.id+":nova-turn:schedule",role:"system",content:[scheduleContext,toolContext].filter(Boolean).join("\n")},
      ...messages,
      // Keep the synthetic user cue last; Mistral-compatible providers depend on valid final role ordering.
      {id:conversation.id+":nova-turn:user-cue",role:"user",content:cue},
    ];
    const providerPresetId=this.options.getActiveProviderPresetId()??this.options.runtime.getActiveProviderPresetId?.();
    const model=providerPresetId?await this.options.getChatModelForPreset(providerPresetId):this.options.getChatModel();
    throwIfAborted(context.signal);
    const request=requestId();
    const cueFor=(format:"native-json"|"tagged"|"plain"):string=>format==="plain"
      ?promptText(context.userTurn?"nova-cue-reactive-plain":"nova-cue-background-plain")
      :format==="tagged"
        ?promptText(context.userTurn?"nova-cue-reactive-tagged":"nova-cue-background-tagged")
        :promptText(context.userTurn?"nova-cue-reactive-json":"nova-cue-background-json");
    const requestFor=(id:string,format:"native-json"|"tagged"|"plain"):ChatRequest=>{
      const system=promptText(format==="plain"?"nova-system-plain":format==="tagged"?"nova-system-tagged":"nova-system-json");
      const finalMessages=contextMessages.map((message,index)=>{
        if(index===0)return {...message,content:system};
        if(index===contextMessages.length-1&&message.id===conversation.id+":nova-turn:user-cue")return {...message,content:cueFor(format)};
        if(format==="tagged"&&index<contextMessages.length-1&&message.role==="user")return {...message,content:escapeUntrustedUserText(message.content)};
        return message;
      });
      const responseFormat=format==="native-json"
        ?{type:"json-schema" as const,name:"nova_turn_v1",strict:false,schema:STANDARD_SCHEMAS["nova-turn"]!}
        :format==="tagged"?{type:"text" as const}:undefined;
      return {
        apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:id,model,
        context:{conversationId:conversation.id,messages:finalMessages},
        generation:{maxTokens:1800,...(responseFormat?{responseFormat}:{})},
        metadata:{cognition:true,protocol:format==="native-json"?"NOVA_TURN_JSON":format==="tagged"?"NOVA_TURN":"PLAIN_TEXT",protocolVersion:1,outputMode},
      };
    };
    const parseNative=(content:string):NovaTurn=>{
      if(content.length>32_000)throw new Error("Native NovaTurn JSON exceeds the 32000-character contract limit.");
      let raw:unknown;
      try{raw=JSON.parse(content);}catch{throw new Error("Provider returned invalid NovaTurn JSON.");}
      const valid=new MinimalJsonSchemaValidator().validate(raw,STANDARD_SCHEMAS["nova-turn"]!);
      if(!valid.valid)throw new Error("Provider JSON did not match NovaTurn v1: "+valid.errors.slice(0,8).join("; "));
      const value=raw as Record<string,unknown>;
      const tools=value.tools as {name:string;arguments:Record<string,unknown>}[];
      for(const tool of tools){
        if(!/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/i.test(tool.name)||JSON.stringify(tool.arguments).length>4_000)
          throw new Error("Provider JSON contains an invalid NovaTurn tool call.");
      }
      return {version:1,situation:value.situation as string,thoughts:value.thoughts as string,emotion:value.emotion as string,
        tools,toolResults:[],speech:value.speech as string,longMemory:typeof value.longMemory==="string"?value.longMemory:"",nextWakeMs:value.nextWakeMs as number};
    };
    const explicitlyUnsupported=(error:unknown):boolean=>{
      const root=error&&typeof error==="object"?error as Record<string,unknown>:{};
      const chat=root.chatError&&typeof root.chatError==="object"?root.chatError as Record<string,unknown>:{};
      const details=chat.details&&typeof chat.details==="object"?chat.details as Record<string,unknown>:{};
      const response=typeof details.providerResponse==="string"?details.providerResponse:"";
      const message=[root.message,chat.message,details.category,response].filter(item=>typeof item==="string").join(" ");
      return /(json[\s_-]*schema|response[\s_-]*format|structured[\s_-]*output)/i.test(message)&&
        /(unsupported|not supported|does not support|unknown parameter|unrecognized parameter|not implemented)/i.test(message);
    };
    const doRequest=async(format:"native-json"|"tagged"|"plain",id:string)=>{
      throwIfAborted(context.signal);
      const decoder=format==="native-json"?new NovaTurnJsonSpeechStreamDecoder():format==="tagged"?new NovaTurnTaggedSpeechStreamDecoder():undefined;
      let rawContent="",deltaCount=0;
      context.onSpeechEvent?.({type:"start",conversationId:conversation.id});
      const consume=(text:string)=>{
        if(!text)return;
        rawContent+=text;deltaCount++;
        const speech=format==="plain"?text:decoder instanceof NovaTurnJsonSpeechStreamDecoder?decoder.push(text):decoder instanceof NovaTurnTaggedSpeechStreamDecoder?decoder.push(text):"";
        if(speech)context.onSpeechEvent?.({type:"delta",conversationId:conversation.id,text:speech});
      };
      const req=requestFor(id,format);
      let response:ChatResponse;
      if(this.options.runtime.stream){
        response=await this.options.runtime.stream(req,{onEvent:async event=>{if(event.type==="delta")consume(event.text);}}, {signal:context.signal},providerPresetId);
        if(deltaCount===0&&response.message.content)consume(response.message.content);
      }else{
        response=await this.options.runtime.chat(req,providerPresetId,{signal:context.signal});
        consume(response.message.content);
      }
      throwIfAborted(context.signal);
      return {response,content:rawContent};
    };
    let effectiveFormat:"native-json"|"tagged"|"plain"=outputMode==="plain"?"plain":"native-json";
    let output:{response:ChatResponse;content:string};
    let protocolDiagnostics:readonly string[]=[];
    if(outputMode==="plain"){
      output=await doRequest("plain",request);
    }else{
      const capabilities=this.options.runtime.getChatProviderCapabilities?.(providerPresetId);
      if(capabilities?.structuredOutput===false){
        effectiveFormat="tagged";
        output=await doRequest("tagged",request);
        protocolDiagnostics=["structured-output-fallback:provider-capability"];
      }else{
        try{
          output=await doRequest("native-json",request);
        }catch(error){
          if(!explicitlyUnsupported(error))throw error;
          throwIfAborted(context.signal);
          context.onSpeechEvent?.({type:"reset",conversationId:conversation.id});
          effectiveFormat="tagged";
          output=await doRequest("tagged",request+"-tag-fallback");
          protocolDiagnostics=["structured-output-fallback:explicit-unsupported"];
        }
      }
    }
    throwIfAborted(context.signal);
    let turn:NovaTurn;
    if(effectiveFormat==="native-json")turn=parseNative(output.content);
    else if(effectiveFormat==="tagged"){
      const parsed=parseNovaTurn(output.content);
      if(!parsed.turn)throw new Error("Provider response did not contain one unambiguous, valid SPEECH block in NOVA_TURN v1. Diagnostics: "+parsed.diagnostics.join(", "));
      turn={...parsed.turn,toolResults:[],longMemory:parsed.turn.longMemory??""};
      protocolDiagnostics=[...protocolDiagnostics,...parsed.diagnostics];
    }else{
      const raw=output.content;
      if(context.userTurn&&!raw.trim())throw new Error("Nova returned no speech for this user message. Retry the Nova Life turn.");
      if(raw.length>4_000)throw new Error("Nova's plain-text response exceeds the 4000-character speech limit. Retry the Nova Life turn.");
      turn={version:1,situation:"",thoughts:"",emotion:"",tools:[],toolResults:[],speech:raw,nextWakeMs:defaultCognitiveInterval(schedule)};
    }
    if(context.userTurn&&!turn.speech.trim())throw new Error("Nova returned no speech for this user message. Retry the Nova Life turn.");
    return {turn,conversationId:conversation.id,requestId:output.response.requestId||request,providerId:output.response.providerId,model:output.response.model,
      ...(providerPresetId?{providerPresetId}:{}),protocolDiagnostics};

  }
}
