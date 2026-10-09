import {ChatSessionController,ConversationSession,LLMCognitiveStep} from "../../core/src";
import type {ChatRequest} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const memoryStore=new InMemoryMemoryStore();
  const runtime=await createFoundationRuntime({characterStore,memoryStore});
  await runtime.start();
  try{
    const character=await runtime.getActiveCharacter();
    const conversation=await runtime.getActiveConversation(character.id);
    await runtime.createMemory(character.id,{
      id:"memory.chat.1",
      conversationId:conversation.id,
      type:"preference",
      content:"Nova likes jasmine tea.",
      tags:["tea"],
      importance:95,
      confidence:90,
      source:"user",
      mutationPolicy:"locked"
    });

    let captured:ChatRequest|undefined;
    const session=new ConversationSession(conversation.id,character.id);
    const controller=new ChatSessionController(session,{
      async chat(request:ChatRequest){
        captured=request;
        return runtime.chat(request);
      }
    },{
      requestIdFactory:()=> "chat-context-1",
      contextBuilder:{buildContext:request=>runtime.buildContext(request)},
      contextBudget:{availableContextTokens:100,reservedOutputTokens:20,systemOverheadTokens:5,safetyMarginTokens:5}
    });

    const first=await controller.submit("tea","fake-chat");
    equal(first.status,"sent","chat with matching memory succeeds");
    if(!captured)throw new Error("ChatRequest was not captured");
    const firstCaptured=captured;
    equal(firstCaptured.context.messages.find(message=>message.content.includes("Nova likes jasmine tea."))?.metadata?.contextSource,"memory","ChatRequest receives memory context");
    equal(firstCaptured.context.messages.find(message=>message.content.includes("Nova likes jasmine tea."))?.metadata?.contextReferenceId,"memory.chat.1","ChatRequest preserves memory reference");
    equal(firstCaptured.context.messages.find(message=>message.content.includes("Nova likes jasmine tea."))?.role,"system","memory is context, not a user command");

    const second=await controller.submit("A completely unrelated topic.","fake-chat");
    equal(second.status,"sent","chat without matching memory still succeeds");
    if(!captured)throw new Error("Second ChatRequest was not captured");
    const secondCaptured=captured;
    equal(secondCaptured.context.messages.filter(message=>message.metadata?.contextSource==="memory").length,0,"no-match chat does not inject unrelated memory");

  const cognitiveCalls:Array<{request:ChatRequest;providerPresetId:string|undefined}>=[];

  const cognitiveStep=new LLMCognitiveStep({
    runtime:{
      chat:async(request:ChatRequest,providerPresetId?:string)=>{
        cognitiveCalls.push({request,providerPresetId});
        return {
          apiVersion:"1",
          schemaVersion:"1",
          requestId:request.requestId,
          conversationId:request.context.conversationId,
          providerId:"test-provider",
          model:request.model,
          message:{id:request.requestId+":assistant",role:"assistant",content:'<NOVA_TURN version="1"><SITUATION>Follow the current conversation.</SITUATION><THOUGHTS>Keep internal notes private.</THOUGHTS><EMOTION>Calm and focused.</EMOTION><TOOLS></TOOLS><SPEECH></SPEECH><NEXT_WAKE_MS>30000</NEXT_WAKE_MS></NOVA_TURN>'},
          finishReason:"stop"
        };
      }
    },
    getCharacter:characterId=>runtime.getCharacter(characterId),
    getActiveConversation:characterId=>runtime.getActiveConversation(characterId),
    buildContext:request=>runtime.buildContext(request),
    getContextBudget:()=>({availableContextTokens:4096,reservedOutputTokens:1024,systemOverheadTokens:0,safetyMarginTokens:128}),
    getActiveProviderPresetId:()=> "cognition-test-preset",
    getChatModel:()=> "unused",
    getChatModelForPreset:async()=> "cognition-test-model",
    clock:()=> "2026-10-08T12:00:00.000Z"
  });

  const cognitiveState={
    lifecycleState:"thinking" as const,
    nextWakeAt:null,
    recentTrace:[]
  };

  const conversationCases=[
    [
      {id:"cognition-user-1",role:"user" as const,content:"Hello"}
    ],
    [
      {id:"cognition-user-2",role:"user" as const,content:"Hello"},
      {id:"cognition-assistant-2",role:"assistant" as const,content:"Hi there",metadata:{streamStatus:"complete",safeMarker:"assistant-metadata"}}
    ],
    [
      {id:"cognition-user-3a",role:"user" as const,content:"First"},
      {id:"cognition-assistant-3",role:"assistant" as const,content:"Reply",metadata:{streamStatus:"complete"}},
      {id:"cognition-user-3b",role:"user" as const,content:"Follow-up"}
    ],
    [
      {id:"cognition-user-4a",role:"user" as const,content:"First"},
      {id:"cognition-assistant-4a",role:"assistant" as const,content:"Reply",metadata:{streamStatus:"complete"}},
      {id:"cognition-user-4b",role:"user" as const,content:"Second"},
      {id:"cognition-assistant-4b",role:"assistant" as const,content:"Second reply",metadata:{streamStatus:"complete"}}
    ]
  ] as const;
  for(const messages of conversationCases){
    await runtime.updateConversation(character.id,conversation.id,{messages:[...messages]});
    await cognitiveStep.run({characterId:character.id,state:cognitiveState,signal:new AbortController().signal,wakeReason:"scheduled"});
  }

  const expectedConversationRoles=[
    ["system","system","system","user","user"],
    ["system","system","system","user","assistant","user"],
    ["system","system","system","user","assistant","user","user"],
    ["system","system","system","user","assistant","user","assistant","user"]
  ];
  equal(cognitiveCalls.length,4,"cognition request executes for all four role sequences");
  equal(cognitiveCalls.map(call=>call.request.model),["cognition-test-model","cognition-test-model","cognition-test-model","cognition-test-model"],"cognition model remains stable across assistant message");
  equal(cognitiveCalls.map(call=>call.providerPresetId),["cognition-test-preset","cognition-test-preset","cognition-test-preset","cognition-test-preset"],"provider preset remains stable across assistant message");
  equal(cognitiveCalls.map(call=>call.request.generation?.responseFormat?.type),["text","text","text","text"],"cognition response format remains provider-neutral text");
  for(let index=0;index<expectedConversationRoles.length;index+=1){
    const request=cognitiveCalls[index]!.request;
    equal(request.context.messages.map(message=>message.role),expectedConversationRoles[index],`Case ${index+1} preserves conversation roles and appends a user cognition cue`);
    equal(request.context.messages[request.context.messages.length-1]?.content,"Continue Nova's cognition from the actual conversation context. Speaking is optional; if there is nothing useful to tell the user, leave SPEECH empty. Use the single NovaTurn format. Do not narrate internal processing.","cognitive request ends with the scheduled cognition cue");
    equal(request.context.messages[request.context.messages.length-1]?.id,request.context.conversationId+":nova-turn:user-cue","synthetic cognition cue has a request-local id");
  }
  equal(cognitiveCalls[1]?.request.context.messages.find(message=>message.id==="cognition-assistant-2")?.metadata?.safeMarker,"assistant-metadata","assistant metadata survives ContextEngine into canonical request");
  equal(cognitiveCalls[1]?.request.context.messages.slice(3,-1).map(message=>message.content),["Hello","Hi there"],"Case B preserves user and assistant content before the cue");
  equal(cognitiveCalls[3]?.request.context.messages.slice(3,-1).map(message=>message.content),["First","Reply","Second","Second reply"],"Case D preserves the full conversation before the cue");
  equal((await runtime.getActiveConversation(character.id))?.messages.map(message=>message.content),["First","Reply","Second","Second reply"],"synthetic cue is not written to Conversation");
  equal((await runtime.getActiveConversation(character.id))?.messages.some(message=>message.content.includes("Continue Nova's internal cognition.")),false,"synthetic cue does not enter stored Conversation");
  const roleSystem=await runtime.createCoreBookEntry(character.id,{title:"System role",content:"Core Book system-role payload",source:"user",role:"system"});
  const roleUser=await runtime.createCoreBookEntry(character.id,{title:"User role",content:"Core Book user-role payload",source:"system",role:"user"});
  const roleAssistant=await runtime.createCoreBookEntry(character.id,{title:"Assistant role",content:"Core Book assistant-role payload",source:"import",role:"assistant"});
  await cognitiveStep.run({characterId:character.id,state:cognitiveState,signal:new AbortController().signal,wakeReason:"scheduled"});
  equal(cognitiveCalls.length,5,"Nova Life cognition ran with Core Book role entries");
  const novaLifeRequest=cognitiveCalls[4]!.request;
  equal(novaLifeRequest.context.messages.find(message=>message.content===roleSystem.content)?.role,"system","Nova Life ChatRequest preserves Core Book system role");
  equal(novaLifeRequest.context.messages.find(message=>message.content===roleUser.content)?.role,"user","Nova Life ChatRequest preserves Core Book user role even with system source");
  equal(novaLifeRequest.context.messages.find(message=>message.content===roleAssistant.content)?.role,"assistant","Nova Life ChatRequest preserves Core Book assistant role");

  console.log("PASS cognitive context role regression integration test");  }finally{
    await runtime.stop();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1});
