import {DeterministicCognitiveStep,LLMCognitiveStep,MindRuntime,type CognitiveStep,type CognitiveStepContext} from "../../core/src";
import type {ChatMessage,ChatRequest,Conversation} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}
async function waitFor(predicate:()=>boolean,timeoutMs=1000):Promise<void>{const deadline=Date.now()+timeoutMs;while(!predicate()){if(Date.now()>=deadline)throw new Error("Timed out waiting for condition.");await new Promise(resolve=>setTimeout(resolve,5));}}

async function startRuntimeTest(){
  const runtime=new MindRuntime({cognitiveStep:new DeterministicCognitiveStep(),stepIntervalMs:2});
  runtime.setActiveCharacter("character.a");
  try{await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length>=3&&runtime.getState().lifecycleState==="waiting");equal(runtime.getState().lifecycleState,"waiting","runtime waits between cognitive steps");}
  finally{await runtime.stop();}
  equal(runtime.getState().lifecycleState,"off","stop transitions runtime to off");
}

async function sequentialStepsTest(){
  const seen:string[]=[];
  class Step implements CognitiveStep{
    running=0;maxRunning=0;
    async run(context:CognitiveStepContext){
      this.running+=1;this.maxRunning=Math.max(this.maxRunning,this.running);
      try{await new Promise(resolve=>setTimeout(resolve,4));const sequence=seen.length+1;seen.push(context.state.lastThought?.id??"none");return {characterId:context.characterId,id:"thought:"+sequence,timestamp:new Date().toISOString(),content:"step "+sequence,expression:"internal" as const};}
      finally{this.running-=1;}
    }
  }
  const step=new Step();const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:2,recentThoughtLimit:50});
  runtime.setActiveCharacter("character.a");
  try{await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length>=4);}finally{await runtime.stop();}
  const state=runtime.getState();equal(step.maxRunning,1,"only one cognitive step runs at a time");ok(state.recentThoughts.length>=4,"recent thought history retains multiple thoughts");equal(seen[0],"none","first cognitive step sees initial state");equal(seen[1],"thought:1","second cognitive step sees first thought");equal(seen[2],"thought:2","third cognitive step sees second thought");
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
  const step:CognitiveStep={run:({signal,characterId})=>{started+=1;return new Promise((_,reject)=>{signal.addEventListener("abort",()=>reject(MindRuntime.createAbortError()),{once:true});void characterId;});}};
  const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:1});runtime.setActiveCharacter("character.a");
  try{await runtime.start();await waitFor(()=>started===1);const stopPromise=runtime.stop();equal(runtime.getState().lifecycleState,"stopping","stop marks an active step as stopping");await stopPromise;equal(runtime.getState().lifecycleState,"off","runtime stops after an active cognitive step");equal(runtime.getState().recentThoughts.length,0,"aborted active step cannot publish a thought");}
  finally{await runtime.stop();}
}

async function restartAfterStopTest(){
  const step=new DeterministicCognitiveStep();const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:1});runtime.setActiveCharacter("character.a");let firstStopCount=0;
  try{await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length>=2);await runtime.stop();firstStopCount=runtime.getState().recentThoughts.length;await runtime.start();await waitFor(()=>runtime.getState().recentThoughts.length>=firstStopCount+1);}
  finally{await runtime.stop();}
  equal(firstStopCount>=2,true,"first stop completes after multiple thoughts");const lastId=runtime.getState().lastThought?.id??"";equal(lastId.startsWith("thought:deterministic:"),true,"restart continues the deterministic cognitive sequence");
}

async function errorDoesNotStopLifeTest(){
  let count=0;
  const step:CognitiveStep={async run(context){count+=1;if(count===1)throw new Error("cognitive failure");return {characterId:context.characterId,id:"thought:"+count,timestamp:new Date().toISOString(),content:"recovered",expression:"internal" as const};}};
  const errors:number[]=[];const runtime=new MindRuntime({cognitiveStep:step,stepIntervalMs:2,onError:()=>errors.push(count)});runtime.setActiveCharacter("character.a");
  try{await runtime.start();await waitFor(()=>runtime.getState().lastThought?.content==="recovered"&&runtime.getState().lifecycleState==="waiting");equal(errors.length,1,"cognitive error is reported");equal(count>=2,true,"runtime retries after error");equal(runtime.getState().lifecycleState,"waiting","life remains active and waits after error");}
  finally{await runtime.stop();}
}

async function thoughtSubscriptionTest(){
  const runtime=new MindRuntime({cognitiveStep:new DeterministicCognitiveStep(),stepIntervalMs:2});runtime.setActiveCharacter("character.a");const thoughts:string[]=[];const unsubscribe=runtime.subscribeThoughts(thought=>thoughts.push(thought.content));
  try{await runtime.start();await waitFor(()=>thoughts.length>=2);unsubscribe();const before=thoughts.length;await new Promise(resolve=>setTimeout(resolve,10));equal(thoughts.length,before,"unsubscribed observer stops receiving thoughts");}
  finally{unsubscribe();await runtime.stop();}
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
  try{
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
  await step.run({characterId:"character.a",state:runtime.getState(),signal:new AbortController().signal,wakeReason:"scheduled"});
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
  }finally{await runtime.stop();}
}

async function llmCognitiveStepTest(){
  const calls:ChatRequest[]=[];
  const contextInputs:Conversation["messages"][]=[];
  const thought="A useful internal thought";
  let cognitiveContent=JSON.stringify({thought,nextWakeInMs:45000});
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
      message:{id:request.requestId+":assistant",role:"assistant" as const,content:cognitiveContent},
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
  let cognitiveResult:Awaited<ReturnType<typeof step.run>>|undefined;
  for(let index=0;index<cases.length;index+=1){
    conversation.messages=conversations[index]!;
    const before=JSON.stringify(conversation.messages);
    cognitiveResult=await step.run({characterId:"char-1",state,signal:new AbortController().signal,wakeReason:"scheduled"});
    const request=calls[index]!;
    const roles=request.context.messages.map(message=>message.role);
    equal(roles.slice(-1)[0],"user","cognition request always ends with a synthetic user cue");
    equal(request.context.messages[request.context.messages.length-1]?.content,"Continue Nova's internal cognition. Produce exactly one private thought based on the context above and, only if useful, an optional separate chat expression in the required JSON object. Do not answer the user's current message; ordinary Chat handles that response.","final message is the internal cognition cue");
    equal(roles.slice(3),[...cases[index]!.map(role=>role),"user"],"conversation roles are preserved and the cognition cue is appended");
    equal(JSON.stringify(conversation.messages),before,"synthetic cognition cue is not written into Conversation");
    equal(contextInputs[index]?.some(message=>message.content.includes("Continue Nova's internal cognition.")),false,"synthetic cognition cue is absent from ContextEngine input");
    equal(request.context.messages.slice(3,-1).map(message=>message.content),conversations[index]!.map(message=>message.content),"real conversation content is preserved before the cognition cue");
    equal(request.context.messages.find(message=>message.content.includes("Continue Nova's internal cognition."))?.id,"conv-1:cognition:user-cue","cognition cue uses a request-local id");
    equal(request.context.messages.find(message=>message.content.includes("Continue Nova's internal cognition."))?.metadata,undefined,"cognition cue has no persistence or memory metadata");
  }

  const firstCall=calls[0]!;
  equal(calls.length,4,"all four valid conversation role sequences execute");
  equal(firstCall.metadata?.cognition,true,"cognition request is marked internal");
  equal(firstCall.generation?.responseFormat?.type,"text","cognitive request uses provider-neutral text output");
  equal(firstCall.context.messages.some(message=>message.content.includes("INTERNAL THOUGHT HISTORY")),true,"mind context includes thought history section");
  equal(firstCall.context.messages.some(message=>message.content==="Core book context"),false,"no unrelated synthetic context is injected by the unit fixture");
  equal(JSON.stringify(conversation.messages),JSON.stringify(conversations[3]),"final Conversation remains unchanged after cognition requests");
  equal(cognitiveResult?.thought.content,"A useful internal thought","LLM response remains the Thought content");
  equal(cognitiveResult?.nextWakeInMs,45000,"LLM response exposes the parsed adaptive wake interval");
  cognitiveContent=String.fromCharCode(96).repeat(3)+"json\n"+JSON.stringify({thought,nextWakeInMs:45000,expression:{kind:"chat",content:"A separate public message"}})+"\n"+String.fromCharCode(96).repeat(3);
  const publicResult=await step.run({characterId:"char-1",state,signal:new AbortController().signal,wakeReason:"scheduled"});
  equal(publicResult.thought.content,thought,"public expression never replaces private Thought");
  equal(publicResult.thought.expression,"internal","Thought remains private even when a message is proposed");
  equal(publicResult.expression,{kind:"chat",content:"A separate public message"},"chat text is parsed as separate expression content");
  equal(publicResult.conversationId,"conv-1","expression retains the exact source conversation");
  cognitiveContent="plain text fallback";
  const plainResult=await step.run({characterId:"char-1",state,signal:new AbortController().signal,wakeReason:"scheduled"});
  equal(plainResult.thought.content,"plain text fallback","plain-text fallback is retained as an internal Thought");
  equal(plainResult.expression,undefined,"plain-text fallback never creates a public expression");
  cognitiveContent=JSON.stringify({thought,expression:{kind:"chat",content:"   "}});
  const invalidEmpty=await step.run({characterId:"char-1",state,signal:new AbortController().signal,wakeReason:"scheduled"});
  equal(invalidEmpty.thought.content,thought,"invalid expression does not discard a valid Thought");
  equal(invalidEmpty.expression,undefined,"empty public expression is rejected");
  equal(invalidEmpty.expressionInvalid,true,"empty public expression is traceable as invalid");
  cognitiveContent=JSON.stringify({thought,expression:{kind:"chat",content:"x".repeat(2001)}});
  const invalidLong=await step.run({characterId:"char-1",state,signal:new AbortController().signal,wakeReason:"scheduled"});
  equal(invalidLong.expression,undefined,"overlong public expression is rejected");
  equal(invalidLong.thought.content,thought,"overlong expression keeps the private Thought");
  cognitiveContent=JSON.stringify({thought,expression:{kind:"chat",content:"not permitted"},tool_call:{name:"arbitrary"}});
  const unknownField=await step.run({characterId:"char-1",state,signal:new AbortController().signal,wakeReason:"scheduled"});
  equal(unknownField.expression,undefined,"unknown fields never authorize public output");
  equal(unknownField.expressionInvalid,true,"unknown response fields invalidate the expression");
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
  const thought=await step.run({characterId:"char-regression",state:{focus:null,lastThought:null,lastThoughtAt:null,recentThoughts:[],lifecycleState:"thinking"},signal:new AbortController().signal,wakeReason:"scheduled"});
  equal(calls.length,1,"text cognitive request does not trigger structured-output retry path");
  equal(calls[0]?.generation?.responseFormat?.type,"text","regression request bypasses json-schema");
  equal(thought.thought.content,"plain cognitive text","plain provider response is parsed as Thought content");
  equal(thought.nextWakeInMs,undefined,"plain-text response leaves interval unset so Runtime uses the configured default");
}

function makeThought(characterId:string,id:string,content=id){return {characterId,id,timestamp:new Date().toISOString(),content,expression:"internal" as const};}

async function adaptiveIntervalPolicyTest(){
  const proposed:unknown[]=[650,40,9999,"invalid",undefined];
  let calls=0;
  const runtime=new MindRuntime({
    cognitiveStep:{run:async({characterId})=>{
      const nextWakeInMs=proposed[calls++];
      return {thought:makeThought(characterId,"adaptive:"+calls),nextWakeInMs};
    }},
    schedule:{mode:"adaptive",defaultIntervalMs:400,minIntervalMs:200,maxIntervalMs:1000,maxRequestsPerHour:120}
  });
  runtime.setActiveCharacter("character.a");
  try{
    await runtime.start();
    await waitFor(()=>Boolean(runtime.getState().recentTrace?.some(entry=>entry.result==="success")));
    let trace=runtime.getState().recentTrace??[];
    equal(trace[trace.length-1]?.appliedIntervalMs,650,"adaptive mode applies an in-range model interval");
    runtime.wake("user-message");
    await waitFor(()=>runtime.getState().recentThoughts.length>=2);
    trace=runtime.getState().recentTrace??[];
    equal(trace[trace.length-1]?.requestedNextWakeInMs,40,"trace records a too-small numeric proposal");
    equal(trace[trace.length-1]?.appliedIntervalMs,200,"too-small interval is clamped to configured minimum");
    runtime.wake("user-message");
    await waitFor(()=>runtime.getState().recentThoughts.length>=3);
    trace=runtime.getState().recentTrace??[];
    equal(trace[trace.length-1]?.appliedIntervalMs,1000,"too-large interval is clamped to configured maximum");
    runtime.wake("user-message");
    await waitFor(()=>runtime.getState().recentThoughts.length>=4);
    trace=runtime.getState().recentTrace??[];
    equal(trace[trace.length-1]?.appliedIntervalMs,400,"invalid interval uses configured default");
    equal(trace[trace.length-1]?.intervalDecision,"invalid-interval-default","invalid interval decision is traceable");
    runtime.wake("user-message");
    await waitFor(()=>runtime.getState().recentThoughts.length>=5);
    trace=runtime.getState().recentTrace??[];
    equal(trace[trace.length-1]?.appliedIntervalMs,400,"missing interval uses configured default");
  }finally{await runtime.stop();}
}

async function fixedIntervalIgnoresModelTest(){
  const runtime=new MindRuntime({
    cognitiveStep:{run:async({characterId})=>({thought:makeThought(characterId,"fixed"),nextWakeInMs:900})},
    schedule:{mode:"fixed",defaultIntervalMs:300,minIntervalMs:200,maxIntervalMs:1000,maxRequestsPerHour:20}
  });
  runtime.setActiveCharacter("character.fixed");
  try{
    await runtime.start();
    await waitFor(()=>Boolean(runtime.getState().recentTrace?.some(entry=>entry.result==="success")));
    const entry=(runtime.getState().recentTrace??[]).slice(-1)[0];
    equal(entry?.appliedIntervalMs,300,"fixed mode always applies the configured interval");
    equal(entry?.intervalDecision,"fixed-mode","trace identifies fixed scheduling");
  }finally{await runtime.stop();}
}

async function proactiveExpressionPolicyTest(){
  let now=1_000_000;
  let stepNumber=0;
  const published:string[]=[];
  const runtime=new MindRuntime({
    cognitiveStep:{run:async({characterId})=>({
      thought:makeThought(characterId,"proactive:"+ ++stepNumber,"private thought"),
      nextWakeInMs:60_000,
      expression:{kind:"chat",content:"A distinct public expression"},
      conversationId:"conversation.a"
    })},
    schedule:{mode:"fixed",defaultIntervalMs:60_000,minIntervalMs:10_000,maxIntervalMs:60_000,maxRequestsPerHour:120},
    proactiveChat:{enabled:true,minMessageIntervalMs:120_000,maxMessagesPerHour:1},
    expressionPublisher:{publish:async expression=>{
      published.push(expression.expressionId);
      return {status:"published" as const,messageId:"message:"+expression.expressionId,conversationId:expression.conversationId};
    }},
    isExpressionContextCurrent:(characterId,conversationId)=>characterId==="character.a"&&conversationId==="conversation.a",
    now:()=>now,
    clock:()=>new Date(now).toISOString()
  });
  runtime.setActiveCharacter("character.a");
  try{
    await runtime.start();
    await waitFor(()=>(runtime.getState().recentTrace?.length??0)>=1&&runtime.getState().lifecycleState==="waiting");
    equal(published.length,0,"life-start creates private thought but does not publish");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionSuppressionReason,"life-start-wake","life-start suppression is traced");
    runtime.wake("scheduled");
    await waitFor(()=>(runtime.getState().recentTrace?.length??0)>=2&&runtime.getState().lifecycleState==="waiting");
    equal(published.length,1,"scheduled wake publishes one eligible expression");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionStatus,"published","published expression appears in trace");
    runtime.wake("scheduled");
    await waitFor(()=>(runtime.getState().recentTrace?.length??0)>=3&&runtime.getState().lifecycleState==="waiting");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionSuppressionReason,"cooldown","minimum expression interval is enforced");
    now+=120_000;
    runtime.wake("scheduled");
    await waitFor(()=>(runtime.getState().recentTrace?.length??0)>=4&&runtime.getState().lifecycleState==="waiting");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionSuppressionReason,"hourly-limit","rolling hourly expression limit is enforced");
    runtime.wake("user-message");
    await waitFor(()=>(runtime.getState().recentTrace?.length??0)>=5&&runtime.getState().lifecycleState==="waiting");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionSuppressionReason,"user-message-wake","user-message wake is prevented from sending a second answer");
    runtime.updateProactiveChat({enabled:false,minMessageIntervalMs:120_000,maxMessagesPerHour:1});
    runtime.wake("scheduled");
    await waitFor(()=>(runtime.getState().recentTrace?.length??0)>=6&&runtime.getState().lifecycleState==="waiting");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionSuppressionReason,"disabled","disabled proactivity continues thought but suppresses publication");
    equal(published.length,1,"suppressed expressions never reach the publisher");
    await runtime.stop();
    runtime.updateProactiveChat({enabled:true,minMessageIntervalMs:120_000,maxMessagesPerHour:1});
    await runtime.start();
    await waitFor(()=>(runtime.getState().recentTrace?.length??0)>=7&&runtime.getState().lifecycleState==="waiting");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionSuppressionReason,"life-start-wake","OFF/ON still suppresses automatic life-start publication");
    runtime.wake("scheduled");
    await waitFor(()=>(runtime.getState().recentTrace?.length??0)>=8&&runtime.getState().lifecycleState==="waiting");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionSuppressionReason,"hourly-limit","OFF/ON cannot reset the rolling expression limit");
    equal(published.length,1,"restarted Life remains inside the existing hourly quota");
  }finally{await runtime.stop();}
}


async function reactiveTurnBypassesProactiveAndRequestLimitsTest(){
  let now=2_000_000,steps=0;
  const publications:import("../../contracts/src").MindExpressionPublication[]=[];
  const runtime=new MindRuntime({
    cognitiveStep:{run:async context=>{
      steps++;const turn=context.userTurn;
      return {thought:makeThought(context.characterId,"reactive-quota:"+steps,turn?"considering the user's actual question":"private startup thought"),
        ...(turn?{expression:{kind:"chat" as const,content:"A direct answer from Nova Life"},conversationId:turn.conversationId,model:"cognitive-model",providerId:"fake.cognitive",providerPresetId:"preset.cognitive"}:{expression:{kind:"internal" as const},conversationId:"conversation.reactive"})};
    }},
    schedule:{mode:"fixed",defaultIntervalMs:10_000,minIntervalMs:10_000,maxIntervalMs:10_000,maxRequestsPerHour:1},
    proactiveChat:{enabled:false,minMessageIntervalMs:10_000,maxMessagesPerHour:1},
    expressionPublisher:{publish:async expression=>{
      publications.push(expression);
      return {status:"published" as const,messageId:"message:"+expression.expressionId,conversationId:expression.conversationId};
    }},
    isExpressionContextCurrent:(characterId,conversationId)=>characterId==="character.reactive"&&conversationId==="conversation.reactive",
    now:()=>now,clock:()=>new Date(now).toISOString()
  });
  runtime.setActiveCharacter("character.reactive");
  try{
    await runtime.start();
    await waitFor(()=>Boolean(runtime.getState().recentTrace?.length)&&runtime.getState().lifecycleState==="waiting");
    equal(steps,1,"startup cognition uses the only background request quota slot");
    equal(runtime.wakeForUserMessage({characterId:"character.reactive",conversationId:"conversation.reactive",userMessageId:"persisted-user-1",turnId:"turn-1"}),true,"correlated user message wakes Life");
    await waitFor(()=>runtime.getState().recentTrace?.some(entry=>entry.expressionStatus==="published"&&entry.expressionRequired===true)&&runtime.getState().lifecycleState==="waiting");
    equal(steps,2,"reactive answer bypasses exhausted background cognition quota");
    equal(publications.length,1,"reply publishes while proactiveChat is disabled");
    equal(publications[0]?.intent,"reactive","publication carries reactive intent");
    equal(publications[0]?.userMessageId,"persisted-user-1","publication carries the exact user message id");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionRequired,true,"trace records required expression");
    equal(runtime.getState().recentTrace?.at(-1)?.expressionStatus,"published","trace records successful publication");
    now+=20_000;runtime.wake("user-message");
    await waitFor(()=>Boolean(runtime.getState().recentTrace?.some(entry=>entry.wakeReason==="user-message"&&!entry.expressionRequired)));
    equal(publications.length,1,"arbitrary uncorrelated user wake cannot publish a reply");
  }finally{await runtime.stop();}
}

async function cancellationDuringExpressionPublicationTest(){
  let publishCount=0;
  let notifyPublisherStarted:()=>void=()=>undefined;
  const publisherStarted=new Promise<void>(resolve=>{notifyPublisherStarted=resolve;});
  const runtime=new MindRuntime({
    cognitiveStep:{run:async({characterId})=>({
      thought:makeThought(characterId,"expression-cancel:"+publishCount,"private thought"),
      expression:{kind:"chat",content:"public content"},
      conversationId:"conversation.cancelled"
    })},
    schedule:{mode:"fixed",defaultIntervalMs:60_000,minIntervalMs:10_000,maxIntervalMs:60_000,maxRequestsPerHour:120},
    expressionPublisher:{publish:async()=>{
      publishCount++;
      notifyPublisherStarted();
      return new Promise(()=>{});
    }},
    isExpressionContextCurrent:()=>true
  });
  runtime.setActiveCharacter("character.cancelled");
  try{
    await runtime.start();
    await waitFor(()=>(runtime.getState().recentTrace?.length??0)>=1&&runtime.getState().lifecycleState==="waiting");
    runtime.wake("scheduled");
    await publisherStarted;
    await runtime.stop();
    equal(runtime.getState().lifecycleState,"off","cancelling a pending expression publisher does not hang Life shutdown");
    equal(publishCount,1,"cancelled pending expression is not regenerated");
  }finally{await runtime.stop();}
}

async function wakeEventsCoalesceTest(){
  let starts=0;
  const runtime=new MindRuntime({
    cognitiveStep:{run:({signal,characterId})=>{
      starts+=1;
      if(starts===1)return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(MindRuntime.createAbortError()),{once:true}));
      return Promise.resolve(makeThought(characterId,"coalesced:"+starts));
    }},
    schedule:{mode:"adaptive",defaultIntervalMs:500,minIntervalMs:200,maxIntervalMs:1000,maxRequestsPerHour:20}
  });
  runtime.setActiveCharacter("character.a");
  try{
    await runtime.start();await waitFor(()=>starts===1);
    runtime.wake("user-message");runtime.wake("user-message");runtime.wake("user-message");
    await waitFor(()=>runtime.getState().recentThoughts.length===1&&starts===2);
    equal(starts,2,"rapid wake events collapse into a single pending cognitive step");
    ok((runtime.getState().recentTrace??[]).some(entry=>entry.result==="cancelled"),"superseded step is traced as cancelled");
  }finally{await runtime.stop();}
}

async function characterSwitchCancelsOldContextTest(){
  const seen:string[]=[];
  const runtime=new MindRuntime({
    cognitiveStep:{run:({signal,characterId})=>{
      seen.push(characterId);
      if(characterId==="character.a")return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(MindRuntime.createAbortError()),{once:true}));
      return Promise.resolve(makeThought(characterId,"thought:"+characterId));
    }},
    schedule:{mode:"adaptive",defaultIntervalMs:500,minIntervalMs:200,maxIntervalMs:1000,maxRequestsPerHour:20}
  });
  runtime.setActiveCharacter("character.a");
  try{
    await runtime.start();await waitFor(()=>seen.length===1);
    runtime.setActiveCharacter("character.b");
    await waitFor(()=>runtime.getState().lastThought?.characterId==="character.b");
    equal(runtime.getState().recentThoughts.map(thought=>thought.characterId),["character.b"],"old character result does not enter active history");
    ok((runtime.getState().recentTrace??[]).some(entry=>entry.characterId==="character.a"&&entry.result==="cancelled"),"old character step is cancelled and traced");
    equal(seen,["character.a","character.b"],"character switch triggers exactly one fresh step for the current character");
  }finally{await runtime.stop();}
}

async function hourlyQuotaDefersBackgroundCallsTest(){
  let calls=0;
  const runtime=new MindRuntime({
    cognitiveStep:{run:async({characterId})=>{calls+=1;return makeThought(characterId,"quota:"+calls)}},
    schedule:{mode:"adaptive",defaultIntervalMs:150,minIntervalMs:100,maxIntervalMs:500,maxRequestsPerHour:1}
  });
  runtime.setActiveCharacter("character.quota");
  try{
    await runtime.start();
    await waitFor(()=>Boolean(runtime.getState().recentTrace?.some(entry=>entry.result==="deferred")),1200);
    const state=runtime.getState();
    equal(calls,1,"hourly quota prevents a second provider call");
    ok((state.recentTrace??[]).some(entry=>entry.result==="deferred"&&entry.intervalDecision==="hourly-limit"),"quota deferral appears in trace");
    ok(Boolean(state.nextWakeAt)&&new Date(state.nextWakeAt!).getTime()-Date.now()>3_500_000,"next wake is delayed until a quota slot opens");
  }finally{await runtime.stop();}
}

async function errorBackoffIncreasesTest(){
  let calls=0;
  const runtime=new MindRuntime({
    cognitiveStep:{run:async({characterId})=>{calls+=1;if(calls<=3)throw new Error("controlled failure");return makeThought(characterId,"recovered")}},
    schedule:{mode:"adaptive",defaultIntervalMs:100,minIntervalMs:50,maxIntervalMs:400,maxRequestsPerHour:20}
  });
  runtime.setActiveCharacter("character.backoff");
  try{
    await runtime.start();await waitFor(()=>runtime.getState().recentTrace?.filter(entry=>entry.result==="error").length===1);
    let errors=(runtime.getState().recentTrace??[]).filter(entry=>entry.result==="error");
    equal(errors[0]?.appliedIntervalMs,100,"first error uses the default backoff without immediate retry");
    equal(calls,1,"first failure does not trigger a same-turn retry");
    await waitFor(()=>runtime.getState().recentTrace?.filter(entry=>entry.result==="error").length===2);
    errors=(runtime.getState().recentTrace??[]).filter(entry=>entry.result==="error");
    equal(errors[1]?.appliedIntervalMs,200,"consecutive failure doubles the delay");
    await waitFor(()=>runtime.getState().recentTrace?.filter(entry=>entry.result==="error").length===3);
    errors=(runtime.getState().recentTrace??[]).filter(entry=>entry.result==="error");
    equal(errors[2]?.appliedIntervalMs,400,"error backoff is capped at the configured maximum");
  }finally{await runtime.stop();}
}

async function timeoutUsesBackoffTest(){
  let calls=0;
  const runtime=new MindRuntime({
    cognitiveStep:{run:()=>{calls+=1;return new Promise<ReturnType<typeof makeThought>>(()=>undefined)}},
    stepTimeoutMs:15,
    schedule:{mode:"adaptive",defaultIntervalMs:120,minIntervalMs:60,maxIntervalMs:400,maxRequestsPerHour:20}
  });
  runtime.setActiveCharacter("character.timeout");
  try{
    await runtime.start();
    await waitFor(()=>Boolean(runtime.getState().recentTrace?.some(entry=>entry.result==="error")),500);
    const entry=(runtime.getState().recentTrace??[]).slice(-1)[0];
    equal(entry?.errorCode,"STEP_TIMEOUT","finite step timeout is surfaced in trace");
    equal(entry?.appliedIntervalMs,120,"timeout schedules a bounded retry backoff");
    equal(calls,1,"timed out step is not immediately repeated");
  }finally{await runtime.stop();}
}

async function stopRejectsLateThoughtTest(){
  let release:((thought:ReturnType<typeof makeThought>)=>void)|undefined;
  let started=0;
  const runtime=new MindRuntime({
    cognitiveStep:{run:({characterId})=>{started+=1;return new Promise<ReturnType<typeof makeThought>>(resolve=>{release=resolve;void characterId;})}},
    schedule:{mode:"adaptive",defaultIntervalMs:500,minIntervalMs:200,maxIntervalMs:1000,maxRequestsPerHour:20}
  });
  runtime.setActiveCharacter("character.late");
  try{
    await runtime.start();await waitFor(()=>started===1);
    await runtime.stop();
    release?.(makeThought("character.late","late"));
    await new Promise(resolve=>setTimeout(resolve,15));
    equal(runtime.getState().lifecycleState,"off","stop leaves Life off");
    equal(runtime.getState().recentThoughts.length,0,"late result after OFF cannot be saved");
    equal(runtime.getState().nextWakeAt,null,"OFF has no pending wake timer");
  }finally{if(runtime.getState().lifecycleState!=="off")await runtime.stop();release?.(makeThought("character.late","late-finally"));}
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
  await adaptiveIntervalPolicyTest();
  await fixedIntervalIgnoresModelTest();
  await proactiveExpressionPolicyTest();
  await reactiveTurnBypassesProactiveAndRequestLimitsTest();
  await cancellationDuringExpressionPublicationTest();
  await wakeEventsCoalesceTest();
  await characterSwitchCancelsOldContextTest();
  await hourlyQuotaDefersBackgroundCallsTest();
  await errorBackoffIncreasesTest();
  await timeoutUsesBackoffTest();
  await stopRejectsLateThoughtTest();
  console.log("PASS Mind Runtime + LLM cognitive tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
