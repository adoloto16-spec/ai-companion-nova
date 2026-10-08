import {DeterministicCognitiveStep,LLMCognitiveStep,MindRuntime,type CognitiveStep,type CognitiveStepContext} from "../../core/src";
import type {ChatRequest} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}
async function waitFor(predicate:()=>boolean,timeoutMs=1000):Promise<void>{const deadline=Date.now()+timeoutMs;while(!predicate()){if(Date.now()>=deadline)throw new Error("Timed out waiting for condition.");await new Promise(resolve=>setTimeout(resolve,5));}}

async function startRuntimeTest(){
  const runtime=new MindRuntime({cognitiveStep:new DeterministicCognitiveStep(),stepIntervalMs:2});
  runtime.setActiveCharacter("character.a");
  await runtime.start();
  await waitFor(()=>runtime.getState().recentThoughts.length>=3);
  equal(runtime.getState().lifecycleState,"thinking","runtime stays thinking between cognitive steps");
  await runtime.stop();
  equal(runtime.getState().lifecycleState,"off","stop transitions runtime to off");
}

async function sequentialStepsTest(){
  const seen:string[]=[];
  class Step implements CognitiveStep{
    running=0;maxRunning=0;
    async run(context:CognitiveStepContext){
      this.running+=1;this.maxRunning=Math.max(this.maxRunning,this.running);
      try{
        await new Promise(resolve=>setTimeout(resolve,4));
        const sequence=seen.length+1;
        seen.push(context.state.lastThought?.id??"none");
        return {characterId:context.characterId,id:"thought:"+sequence,timestamp:new Date().toISOString(),content:"step "+sequence,expression:"internal" as const};
      }finally{this.running-=1;}
    }
  }
  const step=new Step();const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:2,recentThoughtLimit:50});
  runtime.setActiveCharacter("character.a");
  await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length>=4);await runtime.stop();
  const state=runtime.getState();
  equal(step.maxRunning,1,"only one cognitive step runs at a time");
  ok(state.recentThoughts.length>=4,"recent thought history retains multiple thoughts");
  equal(seen[0],"none","first cognitive step sees initial state");
  equal(seen[1],"thought:1","second cognitive step sees first thought");
  equal(seen[2],"thought:2","third cognitive step sees second thought");
}

async function historyLimitTest(){
  const runtime=new MindRuntime({cognitiveStep:new DeterministicCognitiveStep(),stepIntervalMs:1,recentThoughtLimit:3});
  runtime.setActiveCharacter("character.a");
  try{await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length===3);}finally{await runtime.stop();}
  const state=runtime.getState();
  equal(state.recentThoughts.length,3,"history is hard limited");
  const firstNumber=Number(state.recentThoughts[0]?.id.split(":").pop());
  const lastNumber=Number(state.lastThought?.id.split(":").pop());
  equal(firstNumber,lastNumber-2,"old thoughts are evicted from the bounded history");
}

async function stopDuringActiveStepTest(){
  let started=0;
  const step:CognitiveStep={run:({signal,characterId})=>{
    started+=1;
    return new Promise((_,reject)=>{
      signal.addEventListener("abort",()=>reject(MindRuntime.createAbortError()),{once:true});
      void characterId;
    });
  }};
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:1});
  runtime.setActiveCharacter("character.a");
  await runtime.start();
  await waitFor(()=>started===1);
  const stopPromise=runtime.stop();
  equal(runtime.getState().lifecycleState,"stopping","stop marks an active step as stopping");
  await stopPromise;
  equal(runtime.getState().lifecycleState,"off","runtime stops after an active cognitive step");
  equal(runtime.getState().recentThoughts.length,0,"aborted active step cannot publish a thought");
}

async function restartAfterStopTest(){
  const step=new DeterministicCognitiveStep();
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:1});
  runtime.setActiveCharacter("character.a");
  await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length>=2);await runtime.stop();
  const firstStopCount=runtime.getState().recentThoughts.length;
  try{await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length>=3);}finally{await runtime.stop();}
  equal(firstStopCount>=2,true,"first stop completes after multiple thoughts");
  const lastId=runtime.getState().lastThought?.id??"";
  equal(lastId.startsWith("thought:deterministic:"),true,"restart continues the deterministic cognitive sequence");
}

async function errorDoesNotStopLifeTest(){
  let count=0;
  const step:CognitiveStep={
    async run(context){
      count+=1;
      if(count===1)throw new Error("cognitive failure");
      return {characterId:context.characterId,id:"thought:"+count,timestamp:new Date().toISOString(),content:"recovered",expression:"internal" as const};
    }
  };
  const errors:number[]=[];
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:2,onError:()=>errors.push(count)});
  runtime.setActiveCharacter("character.a");
  await runtime.start();
  await waitFor(()=>runtime.getState().lastThought?.content==="recovered");
  equal(errors.length,1,"cognitive error is reported");
  equal(count>=2,true,"runtime retries after error");
  equal(runtime.getState().lifecycleState,"thinking","life remains active after error");
  await runtime.stop();
}

async function thoughtSubscriptionTest(){
  const runtime=new MindRuntime({cognitiveStep:new DeterministicCognitiveStep(),stepIntervalMs:2});
  runtime.setActiveCharacter("character.a");
  const thoughts:string[]=[];
  const unsubscribe=runtime.subscribeThoughts(thought=>thoughts.push(thought.content));
  await runtime.start();await waitFor(()=>thoughts.length>=2);unsubscribe();
  const before=thoughts.length;await new Promise(resolve=>setTimeout(resolve,10));
  equal(thoughts.length,before,"unsubscribed observer stops receiving thoughts");
  await runtime.stop();
}

async function characterScopedThoughtHistoryTest(){
  const seen:Array<{characterId:string;history:string[]}>=[];
  const step:CognitiveStep={
    async run(context){
      seen.push({characterId:context.characterId,history:context.state.recentThoughts.map(thought=>thought.content)});
      const number=seen.filter(item=>item.characterId===context.characterId).length;
      return {
        characterId:context.characterId,
        id:"thought:"+context.characterId+":"+number,
        timestamp:new Date().toISOString(),
        content:context.state.lastThought?context.state.lastThought.content+" -> "+context.characterId:"initial "+context.characterId,
        expression:"internal"
      };
    }
  };
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:10000});
  runtime.setActiveCharacter("character.a");
  await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length===1);await runtime.stop();
  const a1=runtime.getState().recentThoughts[0]!;
  equal(a1.characterId,"character.a","A thought owns character A");

  runtime.setActiveCharacter("character.b");
  equal(runtime.getState().recentThoughts.length,0,"switching to B exposes only B history");
  await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length===1);await runtime.stop();
  equal(runtime.getState().recentThoughts[0]?.characterId,"character.b","B thought owns character B");
  ok(!runtime.getState().recentThoughts.some(thought=>thought.content.includes("character.a")),"B history does not contain A");
  ok(seen.some(item=>item.characterId==="character.b"&&item.history.length===0),"B cognition starts without A history");

  runtime.setActiveCharacter("character.a");
  equal(runtime.getState().recentThoughts.map(thought=>thought.id),[a1.id],"A history is restored after switching back");
  await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length===2);await runtime.stop();
  equal(seen.filter(item=>item.characterId==="character.a")[1]?.history,[a1.content],"A cognition sees only A history");

  const aThoughts=runtime.getState().recentThoughts;
  const deletedId=aThoughts[0]!.id;
  equal(runtime.deleteThought(deletedId),true,"point delete reports success");
  equal(runtime.getState().recentThoughts.length,1,"point delete removes one thought");
  equal(runtime.getState().recentThoughts[0]?.id,aThoughts[1]?.id,"point delete preserves other thoughts");
  await step.run({characterId:"character.a",state:runtime.getState(),signal:new AbortController().signal});
  const deletionContexts=seen.filter(item=>item.characterId==="character.a");
  const deletionContext=deletionContexts[deletionContexts.length-1];
  equal(deletionContext?.history,[aThoughts[1]?.content],"deleted Thought is absent from the next cognition context");
  equal(runtime.deleteThought(aThoughts[1]!.id),true,"latest point delete reports success");
  equal(runtime.getState().lastThought,null,"deleting latest thought clears last thought");
  equal(runtime.getState().recentThoughts.length,0,"deleting latest thought clears history entry");

  runtime.setActiveCharacter("character.b");
  equal(runtime.getState().recentThoughts.length,1,"B history survives clearing A");
  runtime.setActiveCharacter("character.a");
  runtime.clearCurrentThoughts();
  equal(runtime.getState().recentThoughts.length,0,"clear current character empties only current history");
  runtime.setActiveCharacter("character.b");
  equal(runtime.getState().recentThoughts.length,1,"clear current character leaves other characters unchanged");
  runtime.clearAllThoughts();
  equal(runtime.getState().recentThoughts.length,0,"clear all empties current history");
  runtime.setActiveCharacter("character.a");
  equal(runtime.getState().recentThoughts.length,0,"clear all also empties previously active character");
}

async function llmCognitiveStepTest(){
  const calls:ChatRequest[]=[];
  const contextInputs:Conversation["messages"][]=[];
  const thought="A useful internal thought";
  const conversation:Conversation={
    apiVersion:"1",
    schemaVersion:"2",
    id:"conv-1",
    characterId:"char-1",
    title:"Test",
    messages:[],
    createdAt:"now",
    updatedAt:"now"
  };
  const chatRuntime={chat:async(request:ChatRequest)=>{
    calls.push(request);
    return {
      apiVersion:"1" as const,
      schemaVersion:"1",
      requestId:request.requestId,
      conversationId:"conv-1",
      providerId:"fake.chat",
      model:request.model,
      message:{id:request.requestId+":assistant",role:"assistant" as const,content:JSON.stringify({thought})},
      finishReason:"stop" as const
    };
  }};
  const step=new LLMCognitiveStep({
    runtime:chatRuntime,
    getCharacter:async()=>({id:"char-1",name:"Nova",description:"Test character",createdAt:"now",updatedAt:"now",enabled:true}),
    getActiveConversation:async()=>{
      contextInputs.push(conversation.messages.map(message=>({...message,...(message.metadata?{metadata:{...message.metadata}}:{})})));
      return conversation;
    },
    buildContext:async request=>({
      apiVersion:"1",
      schemaVersion:"1",
      characterId:"char-1",
      conversationId:"conv-1",
      messages:[...request.messages.filter(message=>message.role!=="system")].map(message=>({
        ...message,
        id:message.id+":assembled"
      })),
      includedCandidates:[],
      omittedCandidates:[],
      budget:{availableContextTokens:1000,reservedOutputTokens:256,systemOverheadTokens:0,safetyMarginTokens:0},
      estimatedTokens:10
    }),
    getContextBudget:()=>({availableContextTokens:1000,reservedOutputTokens:256,systemOverheadTokens:0,safetyMarginTokens:0}),
    getActiveProviderPresetId:()=>undefined,
    getChatModel:()=> "fake-model",
    getChatModelForPreset:async()=> "unused"
  });

  const state={focus:"test",lastThought:null,lastThoughtAt:null,recentThoughts:[],lifecycleState:"thinking" as const};
  const cases:Array<ChatMessage["role"][]>=[
    ["user"],
    ["user","assistant"],
    ["user","assistant","user"],
    ["user","assistant","user","assistant"]
  ];
  const conversations=[
    [{id:"u1",role:"user" as const,content:"Hello"}],
    [{id:"u2",role:"user" as const,content:"Hello"},{id:"a2",role:"assistant" as const,content:"Hi",metadata:{streamStatus:"complete"}}],
    [{id:"u3a",role:"user" as const,content:"First"},{id:"a3",role:"assistant" as const,content:"Reply"},{id:"u3b",role:"user" as const,content:"Follow-up"}],
    [{id:"u4a",role:"user" as const,content:"First"},{id:"a4a",role:"assistant" as const,content:"Reply"},{id:"u4b",role:"user" as const,content:"Second"},{id:"a4b",role:"assistant" as const,content:"Second reply"}]
  ];
  for(let index=0;index<cases.length;index+=1){
    conversation.messages=conversations[index]!;
    const before=JSON.stringify(conversation.messages);
    await step.run({characterId:"char-1",state,signal:new AbortController().signal});
    const request=calls[index]!;
    const roles=request.context.messages.map(message=>message.role);
    equal(roles.slice(-1)[0],"user","cognition request always ends with a synthetic user cue");
    equal(request.context.messages.at(-1)?.content,"Continue the internal cognition step. Produce exactly one internal thought based on the context above. Do not answer the user.","final message is the internal cognition cue");
    equal(roles.slice(3),[...cases[index]!.map(role=>role),"user"],"conversation roles are preserved and the cognition cue is appended");
    equal(JSON.stringify(conversation.messages),before,"synthetic cognition cue is not written into Conversation");
    equal(contextInputs[index]?.some(message=>message.content.includes("Continue the internal cognition step.")),false,"synthetic cognition cue is absent from ContextEngine input");
    equal(request.context.messages.slice(3,-1).map(message=>message.content),conversations[index]!.map(message=>message.content),"real conversation content is preserved before the cognition cue");
    equal(request.context.messages.find(message=>message.content.includes("Continue the internal cognition step."))?.id,"conv-1:cognition:user-cue","cognition cue uses a request-local id");
    equal(request.context.messages.find(message=>message.content.includes("Continue the internal cognition step."))?.metadata,undefined,"cognition cue has no persistence or memory metadata");
  }

  const firstCall=calls[0]!;
  equal(calls.length,4,"all four valid conversation role sequences execute");
  equal(firstCall.metadata?.cognition,true,"cognition request is marked internal");
  equal(firstCall.generation?.responseFormat?.type,"text","cognitive request uses provider-neutral text output");
  equal(firstCall.context.messages.some(message=>message.content.includes("INTERNAL THOUGHT HISTORY")),true,"mind context includes thought history section");
  equal(firstCall.context.messages.some(message=>message.content==="Core book context"),false,"no unrelated synthetic context is injected by the unit fixture");
  equal(JSON.stringify(conversation.messages),JSON.stringify(conversations[3]),"final Conversation remains unchanged after cognition requests");
  equal(thought,"A useful internal thought","LLM response remains the Thought content");
}
async function cognitiveProviderBadRequestRegressionTest(){
  const calls:ChatRequest[]=[];
  const chatRuntime={
    chat:async(request:ChatRequest)=>{
      calls.push(request);
      if(request.generation?.responseFormat?.type==="json-schema"){
        const error=new Error("OpenAI-compatible provider rejected the chat request.") as Error & {chatError:unknown};
        error.chatError={apiVersion:"1",schemaVersion:"1",code:"PROVIDER_ERROR",message:"OpenAI-compatible provider rejected the chat request.",requestId:request.requestId,providerId:"openai-compatible",retryable:false,details:{category:"bad_request",httpStatus:400,model:request.model}};
        throw error;
      }
      return {apiVersion:"1" as const,schemaVersion:"1",requestId:request.requestId,conversationId:"conv-regression",providerId:"openai-compatible",model:request.model,message:{id:request.requestId+":assistant",role:"assistant" as const,content:"plain cognitive text"},finishReason:"stop" as const};
    }
  };
  const step=new LLMCognitiveStep({
    runtime:chatRuntime,
    getCharacter:async()=>({id:"char-regression",name:"Nova",description:"Test",createdAt:"now",updatedAt:"now",enabled:true}),
    getActiveConversation:async()=>({apiVersion:"1",schemaVersion:"2",id:"conv-regression",characterId:"char-regression",title:"Main",messages:[{id:"user-1",role:"user",content:"Hello"}],createdAt:"now",updatedAt:"now"}),
    buildContext:async()=>({apiVersion:"1",schemaVersion:"1",characterId:"char-regression",conversationId:"conv-regression",messages:[],includedCandidates:[],omittedCandidates:[],budget:{availableContextTokens:1000,reservedOutputTokens:256,systemOverheadTokens:0,safetyMarginTokens:0},estimatedTokens:0}),
    getContextBudget:()=>({availableContextTokens:1000,reservedOutputTokens:256,systemOverheadTokens:0,safetyMarginTokens:0}),
    getActiveProviderPresetId:()=> "preset-regression",
    getChatModel:()=> "unused",
    getChatModelForPreset:async()=> "test-model"
  });
  const thought=await step.run({characterId:"char-regression",state:{focus:null,lastThought:null,lastThoughtAt:null,recentThoughts:[],lifecycleState:"thinking"},signal:new AbortController().signal});
  equal(calls.length,1,"text cognitive request does not trigger structured-output retry path");
  equal(calls[0]?.generation?.responseFormat?.type,"text","regression request bypasses json-schema");
  equal(thought.content,"plain cognitive text","plain provider response is parsed as Thought content");
}

async function main(){
  await startRuntimeTest();
  await sequentialStepsTest();
  await historyLimitTest();
  await stopDuringActiveStepTest();
  await restartAfterStopTest();
  await errorDoesNotStopLifeTest();
  await thoughtSubscriptionTest();
  await characterScopedThoughtHistoryTest();
  await llmCognitiveStepTest();
  await cognitiveProviderBadRequestRegressionTest();
  console.log("PASS Mind Runtime + LLM cognitive tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
