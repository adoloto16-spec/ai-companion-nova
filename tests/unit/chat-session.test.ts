import {ChatSessionController,ConversationSession,InMemoryChatTraceStore} from "../../core/src";
import type {AssembledContext,ChatRequest,ChatResponse,ContextBuildRequest,MindReactiveTurn} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}
function responseFor(request:ChatRequest,content="assistant response"):ChatResponse{
  return {
    apiVersion:request.apiVersion,schemaVersion:request.schemaVersion,requestId:request.requestId,
    conversationId:request.context.conversationId,providerId:"fake.chat",model:request.model,
    message:{id:request.requestId+":assistant",role:"assistant",content},finishReason:"stop"
  };
}

async function main(){
  let preSubmitPersisted=false;
  let userSeenByRuntime="";
  const preSubmitController=new ChatSessionController(
    new ConversationSession("pre-submit-conversation","character.pre-submit"),
    {async chat(request:ChatRequest):Promise<ChatResponse>{
      ok(preSubmitPersisted,"pre-submit persistence finishes before Chat generation starts");
      userSeenByRuntime=request.context.messages.find(message=>message.role==="user")?.content??"";
      return responseFor(request,"pre-submit response");
    }},
    {beforeUserMessage:async snapshot=>{
      equal(snapshot.characterId,"character.pre-submit","pre-submit callback has current character");
      equal(snapshot.messages.map(message=>message.role+":"+message.content).join("|"),"user:latest message","pre-submit callback includes the just-added user message");
      preSubmitPersisted=true;
    }}
  );
  equal((await preSubmitController.submit("latest message","fake-chat")).status,"sent","pre-submit persistence does not block normal Chat");
  equal(userSeenByRuntime,"latest message","normal Chat receives the same latest user message after the hook");


  const session=new ConversationSession("unit-conversation","character.unit");
  equal(session.getMessages().length,0,"initial conversation empty");
  equal(session.characterId,"character.unit","conversation character scope");
  session.addMessage({role:"user",content:"one"});
  session.addMessage({role:"assistant",content:"two"});
  equal(session.getMessages().map(message=>message.content).join("|"),"one|two","conversation order");
  session.clear();
  equal(session.getMessages().length,0,"conversation clear");

  const requests:ChatRequest[]=[];
  const runtime={async chat(request:ChatRequest):Promise<ChatResponse>{requests.push(request);return responseFor(request,"fake unit response")}};
  const controller=new ChatSessionController(session,runtime,{requestIdFactory:()=> "req-1"});
  const empty=await controller.submit("   ","fake-chat");
  equal(empty.status,"rejected","empty submission rejected");
  equal(requests.length,0,"empty submission does not call runtime");

  const success=await controller.submit("hello","fake-chat");
  equal(success.status,"sent","successful chat flow");
  equal(session.getMessages().length,2,"assistant added after success");
  equal(session.getMessages()[0]?.role,"user","user message first");
  equal(session.getMessages()[1]?.role,"assistant","assistant message second");

  const historySession=new ConversationSession("history-conversation","character.history");
  const historyRequests:ChatRequest[]=[];
  const historyController=new ChatSessionController(historySession,{
    async chat(request:ChatRequest){historyRequests.push(request);return responseFor(request,"history response")}
  },{requestIdFactory:(()=>{let n=0;return ()=> "history-"+(++n)})()});
  await historyController.submit("first","fake-chat");
  await historyController.submit("second","fake-chat");
  equal(historyRequests[1]?.context.messages.length,3,"full history passed to runtime");
  equal(historyRequests[1]?.context.messages[2]?.content,"second","latest user message passed");

  const contextSession=new ConversationSession("context-conversation","character.context");
  const contextRequests:ContextBuildRequest[]=[];
  const contextChatRequests:ChatRequest[]=[];
  const contextController=new ChatSessionController(contextSession,{
    async chat(request:ChatRequest){
      contextChatRequests.push(request);
      return responseFor(request,"context-aware response");
    }
  },{
    requestIdFactory:()=> "context-1",
    contextBuilder:{
      async buildContext(request:ContextBuildRequest):Promise<AssembledContext>{
        contextRequests.push(request);
        return {
          apiVersion:"1",schemaVersion:"1",characterId:request.characterId,conversationId:request.conversationId,
          messages:[
            ...request.messages,
            {id:"memory-ctx",role:"user",content:"memory context",metadata:{contextSource:"memory",contextReferenceId:"memory-ctx"}}
          ],
          includedCandidates:[],
          omittedCandidates:[],
          budget:request.budget,
          estimatedTokens:3
        };
      }
    },
    contextBudget:{availableContextTokens:100,reservedOutputTokens:10,systemOverheadTokens:0,safetyMarginTokens:0}
  });
  await contextController.submit("hello","fake-chat");
  equal(contextRequests.length,1,"chat invokes the unified context engine boundary");
  equal(contextRequests[0]?.characterId,"character.context","context build is character scoped");
  equal(contextRequests[0]?.messages.at(-1)?.content,"hello","context query contains latest user message");
  equal(contextChatRequests[0]?.context.messages.at(-1)?.content,"memory context","assembled context reaches ChatRequest");
  equal(contextChatRequests[0]?.context.messages.at(-1)?.metadata?.contextSource,"memory","ChatRequest preserves memory provenance");

  const errorSession=new ConversationSession("error-conversation","character.error");
  const errorController=new ChatSessionController(errorSession,{
    async chat(_request:ChatRequest):Promise<ChatResponse>{throw {chatError:{code:"PROVIDER_ERROR",message:"internal detail"}}}
  },{requestIdFactory:()=> "error-1"});
  const failed=await errorController.submit("hello","fake-chat");
  equal(failed.status,"error","provider error result");
  equal(errorSession.getMessages().length,1,"no assistant message on error");
  equal(errorSession.getMessages()[0]?.role,"user","user message remains after error");
  equal(errorController.getSnapshot().error,"The chat provider could not complete the request.","safe user-facing error");
  ok(!String(errorController.getSnapshot().error).includes("internal detail"),"raw error is not exposed");

  const busySession=new ConversationSession("busy-conversation","character.busy");
  let release:(response:ChatResponse)=>void=()=>{};
  const pendingRuntime={
    chat(request:ChatRequest):Promise<ChatResponse>{
      return new Promise<ChatResponse>(resolve=>{release=()=>resolve(responseFor(request,"released response"))});
    }
  };
  const busyController=new ChatSessionController(busySession,pendingRuntime,{requestIdFactory:()=> "busy-1"});
  const firstPromise=busyController.submit("first","fake-chat");
  equal(busyController.getSnapshot().sending,true,"loading state starts");
  equal((await busyController.submit("second","fake-chat")).status,"rejected","duplicate submit rejected");
  release({
    apiVersion:"1",schemaVersion:"1",requestId:"busy-1",conversationId:"busy-conversation",providerId:"fake.chat",model:"fake-chat",
    message:{id:"busy-1:assistant",role:"assistant",content:"released response"},finishReason:"stop"
  });
  equal((await firstPromise).status,"sent","pending request resolves");
  equal(busyController.getSnapshot().sending,false,"loading state ends");

  let observed=0;
  const unsubscribe=busyController.subscribe(()=>{observed+=1});
  busyController.clear();
  unsubscribe();
  ok(observed>0,"controller notifies subscribers");
  equal(busyController.getSnapshot().messages.length,0,"controller clear");

  const legacySession=new ConversationSession("legacy-conversation","character.legacy");
  legacySession.addMessage({id:"legacy-user",role:"user",content:"legacy question"});
  legacySession.addMessage({id:"legacy-assistant",role:"assistant",content:"legacy answer"});
  let legacyRegenerated=false;
  const legacyRuntime={
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"legacy chat")},
    async stream(request:ChatRequest,handlers:import("../../contracts/src").ChatStreamHandlers):Promise<ChatResponse>{
      legacyRegenerated=true;
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"new legacy answer"});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"completed",finishReason:"stop"});
      return responseFor(request,"new legacy answer");
    }
  };
  const legacyController=new ChatSessionController(legacySession,legacyRuntime,{requestIdFactory:()=> "legacy-regenerate-1"});
  equal(legacyController.getSnapshot().status,"completed","legacy persisted assistant is treated as complete");
  const legacyRegeneratedResult=await legacyController.regenerate("fake-streaming-chat");
  equal(legacyRegeneratedResult.status,"sent","Regenerate remains available for legacy assistant messages");
  ok(legacyRegenerated,"legacy regenerate used streaming path");
  equal(legacySession.getMessages()[1]?.id,"legacy-assistant","legacy regenerate reuses assistant id");
  equal(legacySession.getMessages()[1]?.content,"new legacy answer","legacy regenerate replaces the old answer");

  const streamingSession=new ConversationSession("stream-conversation","character.stream");
  const streamingSnapshots:ReturnType<ChatSessionController["getSnapshot"]>[]=[];
  const streamingRuntime={
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"chat fallback")},
    async stream(request:ChatRequest,handlers:import("../../contracts/src").ChatStreamHandlers,options?:import("../../contracts/src").ChatStreamOptions):Promise<ChatResponse>{
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"Hel"});
      if(options?.signal?.aborted)throw abortError();
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"lo"});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"completed",finishReason:"stop"});
      return responseFor(request,"Hello");
    }
  };
  let extractionCalls=0;
  const extractionTurns:string[]=[];
  const streamingController=new ChatSessionController(streamingSession,streamingRuntime,{requestIdFactory:(()=>{let n=0;return ()=>"stream-"+(++n)})(),memoryExtractor:{extract:async request=>{extractionCalls++;extractionTurns.push(request.turnId);return [];}}});
  streamingController.subscribe(snapshot=>streamingSnapshots.push(snapshot));
  const streamed=await streamingController.submit("hello","fake-streaming-chat");
  equal(streamed.status,"sent","controller streaming success");
  equal(streamingSnapshots.some(snapshot=>snapshot.status==="streaming"&&snapshot.messages.at(-1)?.content==="Hel"),true,"partial assistant appears while streaming");
  equal(streamingSession.getMessages().length,2,"streaming keeps one assistant message");
  equal(streamingSession.getMessages()[1]?.content,"Hello","streaming assembles final assistant content");
  equal(streamingSession.getMessages()[1]?.metadata?.streamStatus,"complete","completed assistant state");
  await Promise.resolve();
  equal(extractionCalls,1,"completed stream triggers exactly one extraction");
  equal(extractionTurns[0],"stream-1","extraction uses stable turn identity");

  let contextBuilds=0;
  const contextRuntime={
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"fallback")},
    async stream(request:ChatRequest,handlers:import("../../contracts/src").ChatStreamHandlers):Promise<ChatResponse>{
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"ok"});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"completed",finishReason:"stop"});
      return responseFor(request,"ok");
    }
  };
  const contextStreamingController=new ChatSessionController(
    new ConversationSession("stream-context","character.context-stream"),
    contextRuntime,
    {requestIdFactory:()=> "context-stream-1",contextBuilder:{async buildContext(request){
      contextBuilds++;
      return {
        apiVersion:"1",schemaVersion:"1",characterId:request.characterId,conversationId:request.conversationId,messages:request.messages,
        includedCandidates:[],omittedCandidates:[],budget:request.budget,estimatedTokens:0
      };
    }}}
  );
  await contextStreamingController.submit("context once","fake-streaming-chat");
  equal(contextBuilds,1,"Context Engine builds once for one stream request");

  let stopResolver:(()=>void)|undefined;
  const stopRuntime={
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"unused")},
    async stream(request:ChatRequest,handlers:import("../../contracts/src").ChatStreamHandlers,options?:import("../../contracts/src").ChatStreamOptions):Promise<ChatResponse>{
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"partial "});
      await new Promise<void>((resolve,reject)=>{
        stopResolver=resolve;
        const signal=options?.signal;
        if(!signal)return;
        const onAbort=()=>{signal.removeEventListener("abort",onAbort);reject(abortError())};
        signal.addEventListener("abort",onAbort,{once:true});
      });
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"must not append"});
      throw abortError();
    }
  };
  let stoppedExtractionCalls=0;
  const stopController=new ChatSessionController(new ConversationSession("stop-conversation","character.stop"),stopRuntime,{requestIdFactory:()=> "stop-1",memoryExtractor:{extract:async()=>{stoppedExtractionCalls++;return [];}}});
  const stopPromise=stopController.submit("stop me","fake-streaming-chat");
  while(!stopController.getSnapshot().messages.some(message=>message.content==="partial ")){await Promise.resolve();}
  const stopped=await stopController.stop();
  stopResolver?.();
  equal(stopped.status,"interrupted","Stop transitions to interrupted");
  equal(stopController.getSnapshot().sending,false,"Stop clears loading");
  equal(stopController.getSnapshot().status,"interrupted","Stop status is interrupted");
  equal(stopController.getSnapshot().messages.at(-1)?.content,"partial ","Stop preserves partial assistant text");
  equal(stopController.getSnapshot().messages.at(-1)?.metadata?.streamStatus,"interrupted","Stop marks assistant interrupted");
  await stopPromise;
  await Promise.resolve();
  equal(stoppedExtractionCalls,0,"interrupted stream does not trigger extraction");

  let continueCalls=0;
  const continueRuntime={
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"unused")},
    async stream(request:ChatRequest,handlers:import("../../contracts/src").ChatStreamHandlers):Promise<ChatResponse>{
      continueCalls++;
      if(continueCalls===1){
        await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"Hel"});
        throw abortError();
      }
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"Hel"});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"lo!"});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"completed",finishReason:"stop"});
      return responseFor(request,"Hello!");
    }
  };
  const continueSession=new ConversationSession("continue-conversation","character.continue");
  const continueController=new ChatSessionController(continueSession,continueRuntime,{requestIdFactory:(()=>{let n=0;return ()=>"continue-"+(++n)})()});
  const firstContinue=continueController.submit("hello","fake-streaming-chat");
  await Promise.resolve();
  const firstResult=await firstContinue;
  equal(firstResult.status,"interrupted","aborted stream enters interrupted state");
  const firstAssistant=continueSession.getMessages().find(message=>message.role==="assistant");
  ok(Boolean(firstAssistant),"partial stream keeps assistant for continuation");
  equal(firstAssistant?.content,"Hel","partial text before Stop/abort");
  const beforeContinueId=continueSession.getMessages().find(message=>message.role==="assistant")?.id;
  const continued=await continueController.continue("fake-streaming-chat");
  equal(continued.status,"sent","Continue succeeds");
  const afterContinue=continueSession.getMessages().filter(message=>message.role==="assistant");
  equal(afterContinue.length,1,"Continue keeps one assistant message");
  equal(afterContinue[0]?.id,beforeContinueId,"Continue reuses assistant message id");
  equal(afterContinue[0]?.content,"Hello!","Continue appends without duplicating partial text");

  let regenerateCalls=0;
  const regenerateRuntime={
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"unused")},
    async stream(request:ChatRequest,handlers:import("../../contracts/src").ChatStreamHandlers):Promise<ChatResponse>{
      regenerateCalls++;
      const text=regenerateCalls===1?"Answer A":"Answer B";
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"completed",finishReason:"stop"});
      return responseFor(request,text);
    }
  };
  const regenerateSession=new ConversationSession("regenerate-conversation","character.regenerate");
  const regenerateController=new ChatSessionController(regenerateSession,regenerateRuntime,{requestIdFactory:(()=>{let n=0;return ()=>"regenerate-"+(++n)})()});
  await regenerateController.submit("question","fake-streaming-chat");
  const regenerateId=regenerateSession.getMessages()[1]?.id;
  const regenerated=await regenerateController.regenerate("fake-streaming-chat");
  equal(regenerated.status,"sent","Regenerate succeeds");
  equal(regenerateSession.getMessages().length,2,"Regenerate keeps one assistant message");
  equal(regenerateSession.getMessages()[1]?.id,regenerateId,"Regenerate preserves assistant identity");
  equal(regenerateSession.getMessages()[1]?.content,"Answer B","Regenerate replaces previous answer");

  let retryCalls=0;
  const retryRuntime={
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"unused")},
    async stream(request:ChatRequest,handlers:import("../../contracts/src").ChatStreamHandlers):Promise<ChatResponse>{
      retryCalls++;
      if(retryCalls===1)throw {chatError:{apiVersion:"1",schemaVersion:"1",code:"PROVIDER_ERROR",message:"provider failed",requestId:request.requestId,providerId:"fake.streaming",retryable:true}};
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"Recovered"});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"completed",finishReason:"stop"});
      return responseFor(request,"Recovered");
    }
  };
  const retrySession=new ConversationSession("retry-conversation","character.retry");
  const retryController=new ChatSessionController(retrySession,retryRuntime,{requestIdFactory:(()=>{let n=0;return ()=>"retry-"+(++n)})()});
  const failedRetry=await retryController.submit("please retry","fake-streaming-chat");
  equal(failedRetry.status,"error","provider failure enters error state");
  equal(retrySession.getMessages().filter(message=>message.role==="user").length,1,"failed request keeps one user message");
  equal(retrySession.getMessages().filter(message=>message.role==="assistant").length,0,"provider error without partial keeps no assistant history");
  const retriedChat=await retryController.retry("fake-streaming-chat");
  equal(retriedChat.status,"sent","Retry succeeds");
  equal(retrySession.getMessages().filter(message=>message.role==="user").length,1,"Retry does not duplicate user message");
  equal(retrySession.getMessages().filter(message=>message.role==="assistant").length,1,"Retry creates one assistant response");

  const cancelRaceEvents:import("../../contracts/src").ChatStreamEvent[]=[];
  let raceAbortResolver:(()=>void)|undefined;
  const raceRuntime={
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"unused")},
    async stream(request:ChatRequest,handlers:import("../../contracts/src").ChatStreamHandlers,options?:import("../../contracts/src").ChatStreamOptions):Promise<ChatResponse>{
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"before-stop"});
      await new Promise<void>(resolve=>{raceAbortResolver=resolve});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"delta",text:"after-stop"});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake.streaming",model:request.model,type:"completed",finishReason:"stop"});
      return responseFor(request,"before-stopafter-stop");
    }
  };
  const raceController=new ChatSessionController(new ConversationSession("race","character.race"),raceRuntime,{requestIdFactory:()=> "race-1"});
  const racePromise=raceController.submit("race","fake-streaming-chat");
  while(raceController.getSnapshot().messages.at(-1)?.content!=="before-stop"){await Promise.resolve();}
  const raceStop=raceController.stop();
  raceAbortResolver?.();
  equal((await raceStop).status,"interrupted","stop/chunk race is interrupted");
  await racePromise;
  equal(raceController.getSnapshot().messages.at(-1)?.content,"before-stop","late chunk after Stop is ignored");

  const editSession=new ConversationSession("edit-conversation","character.edit");
  editSession.addMessage({id:"user-1",role:"user",content:"original user"});
  editSession.addMessage({id:"assistant-1",role:"assistant",content:"original assistant",metadata:{streamStatus:"complete",finishReason:"stop"}});
  const editController=new ChatSessionController(editSession,{async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"unused")}});
  editController.editMessage("user-1","edited user");
  equal(editSession.getMessages()[0]?.content,"edited user","edit user message changes only selected message");
  equal(editSession.getMessages()[0]?.metadata,undefined,"user edit does not invent streaming metadata");
  editController.editMessage("assistant-1","edited assistant");
  equal(editSession.getMessages()[1]?.content,"edited assistant","edit assistant message preserves identity");
  equal(editSession.getMessages()[1]?.metadata?.streamStatus,"complete","assistant edit preserves streaming metadata");
  editController.deleteMessage("user-1");
  equal(editSession.getMessages().length,1,"delete removes exactly one message");
  equal(editSession.getMessages()[0]?.id,"assistant-1","delete preserves other messages");
  let editBusy=false;
  const editBusyController=new ChatSessionController(new ConversationSession("busy-edit","character.edit"),{async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"unused")}});
  const editRunPromise=editBusyController.submit("busy","fake");
  try{editBusyController.editMessage("busy-edit-missing","x")}catch{editBusy=true}
  equal(editBusy,true,"editing nonexistent message is rejected");
  await editRunPromise;

  const traceStore=new InMemoryChatTraceStore();
  const tracedController=new ChatSessionController(new ConversationSession("trace-conversation","character.trace"),{
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"trace response")}
  },{
    requestIdFactory:()=> "trace-1",
    traceStore
  });
  const traced=await tracedController.submit("trace request","fake");
  equal(traced.status,"sent","traced chat succeeds");
  const trace=traceStore.recent()[0];
  ok(Boolean(trace),"completed turn produces one trace");
  equal(trace?.turnId,"trace-1","trace uses stable request id");
  equal(trace?.finalRequest?.context.messages[0]?.content,"trace request","trace contains actual submitted user message");
  equal(trace?.providerResponse?.providerId,"fake.chat","trace contains provider response metadata");

  let capturedBudget:ContextBuildRequest["budget"]|undefined;
  const dynamicBudgetController=new ChatSessionController(new ConversationSession("budget-conversation","character.budget"),{
    async chat(request:ChatRequest):Promise<ChatResponse>{return responseFor(request,"budget response")}
  },{
    contextBudgetProvider:()=>({availableContextTokens:777,reservedOutputTokens:111,systemOverheadTokens:0,safetyMarginTokens:22}),
    contextBuilder:{async buildContext(request:ContextBuildRequest):Promise<AssembledContext>{
      capturedBudget=request.budget;
      return {apiVersion:"1",schemaVersion:"1",characterId:request.characterId,conversationId:request.conversationId,messages:request.messages,includedCandidates:[],omittedCandidates:[],budget:request.budget,estimatedTokens:0};
    }}
  });
  equal((await dynamicBudgetController.submit("budget","fake")).status,"sent","dynamic budget chat succeeds");
  equal(capturedBudget?.availableContextTokens,777,"controller uses configurable context size");
  equal(capturedBudget?.reservedOutputTokens,111,"controller uses configurable reserved output");
  equal(capturedBudget?.safetyMarginTokens,22,"controller uses configurable safety margin");

  console.log("PASS Chat session streaming actions: stream/stop/continue/regenerate/retry/race");

  let ordinaryLifeRequests=0,userPersistedBeforeWake=false,wokenLifeTurn:MindReactiveTurn|undefined,memoryExtractions=0;
  const memoryRequests:import("../../contracts/src").MemoryExtractionRequest[]=[];
  const lifeSession=new ConversationSession("life-conversation","character.life");
  const {serializeNovaTurn,parseNovaTurn}=await import("../../contracts/src/nova-turn");
  const previousTurn={
    version:1 as const,situation:"Earlier context",thoughts:"private internal detail must not reach memory",
    emotion:"calm",tools:[],toolResults:[],speech:"Earlier public statement",nextWakeMs:30000
  };
  lifeSession.addMessage({id:"nova-turn:background-turn",role:"assistant",content:serializeNovaTurn(previousTurn),metadata:{source:"nova-life",novaTurnVersion:1,novaTurnId:"background-turn"}});
  const lifeController=new ChatSessionController(lifeSession,{
    async chat(request:ChatRequest){ordinaryLifeRequests++;return responseFor(request,"ordinary Chat must not run");}
  },{
    requestIdFactory:()=>"life-request-1",
    memoryExtractor:{extract:async request=>{memoryExtractions++;memoryRequests.push(request);return [];}},
    memoryExtractionEnabled:()=>true,recentConversationMessagesProvider:()=>8
  });
  const lifeSubmit=await lifeController.submitToLife("Answer this from Nova Life",async snapshot=>{
    equal(snapshot.messages.at(-1)?.role+":"+snapshot.messages.at(-1)?.content,"user:Answer this from Nova Life","persist receives the saved reactive user message");
    userPersistedBeforeWake=true;
  },turn=>{
    ok(userPersistedBeforeWake,"Life wake happens only after persistence completes");wokenLifeTurn=turn;return true;
  });
  equal(lifeSubmit.status,"awaiting-life","Life submission records an explicit awaiting state");
  equal(ordinaryLifeRequests,0,"Life submission never invokes ordinary Chat generation");
  equal(lifeController.getSnapshot().sending,false,"pending Life does not masquerade as an ordinary stream");
  equal(lifeController.getSnapshot().lifeTurn?.status,"awaiting","controller exposes the pending reactive turn");
  equal(wokenLifeTurn?.userMessageId,"life-request-1:user","wake carries the exact user message id");
  equal(wokenLifeTurn?.conversationId,"life-conversation","wake carries the exact Conversation id");

  const context:import("../../contracts/src").MindTurnExecutionContext={
    characterId:"character.life",conversationId:"life-conversation",turnId:"life-request-1",userMessageId:"life-request-1:user",
    requestId:"cognitive-request",providerId:"fake.cognitive",model:"cognitive-model",providerPresetId:"preset.cognitive",
    signal:new AbortController().signal
  };
  const emptyTurn={version:1 as const,situation:"answering",thoughts:"private",emotion:"steady",tools:[],toolResults:[],speech:"   ",nextWakeMs:30000};
  let persistenceWrites=0;
  let emptySpeechRejected=false;
  try{await lifeController.commitNovaTurn(emptyTurn,context,async()=>{persistenceWrites++;});}
  catch{emptySpeechRejected=true;}
  equal(emptySpeechRejected,true,"reactive turn with empty speech is rejected before message commit");
  equal(lifeController.getSnapshot().messages.at(-1)?.role,"user","invalid speech leaves the user message retryable");
  lifeController.failLifeTurn(context.userMessageId!,"REACTIVE_SPEECH_REQUIRED");
  equal(lifeController.getSnapshot().lifeTurn?.status,"failed","empty speech is surfaced as a failed Life turn");
  const retried=lifeController.retryLife(()=>true);
  equal(retried.status,"awaiting-life","failed reactive turn can be retried using its persisted user message");

  const transientStream={characterId:"character.life",conversationId:"life-conversation",turnId:"life-request-1",userMessageId:"life-request-1:user"};
  lifeController.updateNovaTurnStream({type:"start",...transientStream});
  lifeController.updateNovaTurnStream({type:"delta",...transientStream,text:"Live public speech"});
  equal(lifeController.getSnapshot().lifeStreamingSpeech?.text,"Live public speech","Nova Life exposes provisional speech before a final turn exists");
  equal(lifeController.getSnapshot().messages.filter(message=>message.role==="assistant").length,1,"provisional text is not committed as a second assistant message");
  lifeController.updateNovaTurnStream({type:"delta",...transientStream,characterId:"character.other",text:"must not cross characters"});
  equal(lifeController.getSnapshot().lifeStreamingSpeech?.text,"Live public speech","stream events from another character are ignored");
  lifeController.updateNovaTurnStream({type:"delta",...transientStream,conversationId:"conversation.other",text:"must not cross conversations"});
  equal(lifeController.getSnapshot().lifeStreamingSpeech?.text,"Live public speech","stream events from another conversation are ignored");
  lifeController.failLifeTurn(transientStream.userMessageId,"life-off");
  lifeController.updateNovaTurnStream({type:"clear",...transientStream});
  equal(lifeController.getSnapshot().lifeStreamingSpeech,undefined,"cancelled Life turns clear provisional speech even after status changes");
  equal(lifeController.retryLife(()=>true).status,"awaiting-life","cancelled streamed turn remains retryable");
  lifeController.updateNovaTurnStream({type:"start",...transientStream});
  lifeController.updateNovaTurnStream({type:"delta",...transientStream,text:"Live public speech"});

  const turn={
    version:1 as const,situation:"Comparing the request with prior context",thoughts:"private thoughts live only in the tagged record",
    emotion:"focused",tools:[{name:"read_memory",arguments:{query:"saved preferences"}}],
    toolResults:[{callId:"life-request-1:tool:0:read_memory",name:"read_memory",status:"success" as const,output:[{content:"Prefers trains"}]}],
    speech:"A separate public reply",longMemory:"The user prefers train travel.",nextWakeMs:45000
  };
  let persistedMessages:readonly import("../../contracts/src").ChatMessage[]=[];
  await lifeController.commitNovaTurn(turn,context,async snapshot=>{
    persistenceWrites++;persistedMessages=snapshot.messages.map(message=>({...message,...(message.metadata?{metadata:{...message.metadata}}:{})}));
    equal(lifeSession.getMessages().length,snapshot.messages.length-1,"the assistant record is not visible before persistence succeeds");
    equal(snapshot.messages.at(-1)?.content?.includes("private thoughts live only"),true,"canonical persistence receives the full tagged NovaTurn");
  });
  const record=lifeController.getSnapshot().messages.at(-1)!;
  equal(record.role,"assistant","NovaTurn is saved as one assistant Conversation message");
  equal(record.metadata?.novaTurnVersion,1,"stored turn has an explicit protocol version marker");
  equal(record.metadata?.novaTurnId,"life-request-1","stored record has a stable idempotency key");
  equal(parseNovaTurn(record.content).turn?.speech,"A separate public reply","speech is parsed from the full persisted record");
  equal(parseNovaTurn(record.content).turn?.thoughts,"private thoughts live only in the tagged record","private technical fields remain persisted");
  equal(persistedMessages.length,lifeController.getSnapshot().messages.length,"canonical persistence and live UI share one Conversation record");
  equal(lifeController.getSnapshot().messages.filter(message=>message.metadata?.novaTurnId==="life-request-1").length,1,"reactive NovaTurn is shown exactly once");
  equal(lifeController.getSnapshot().lifeStreamingSpeech,undefined,"final persistence removes the provisional speech buffer instead of duplicating it");
  equal(lifeController.getSnapshot().lifeTurn?.status,"completed","reactive turn completes only after persistence");
  equal(ordinaryLifeRequests,0,"Nova Life response does not dispatch a second ordinary LLM request");
  await new Promise(resolve=>setTimeout(resolve,0));
  equal(memoryExtractions,1,"non-empty LONGMEMORY invokes the existing persistence boundary exactly once");
  equal(memoryRequests[0]?.turnId,"life-request-1","LONGMEMORY uses the original turn id");
  equal(memoryRequests[0]?.userMessage.id,"life-request-1:user","LONGMEMORY preserves the exact user message scope");
  equal(memoryRequests[0]?.assistantMessage.content,"The user prefers train travel.","only the LONGMEMORY candidate is sent to memory persistence");
  equal(memoryRequests[0]?.assistantMessage.metadata?.novaTurnLongMemoryCandidate,true,"candidate uses the direct LONGMEMORY path rather than another LLM extraction");
  equal(memoryRequests[0]?.assistantMessage.metadata?.source,"nova-life-longmemory-candidate","candidate source is explicitly marked");
  equal(memoryRequests[0]?.assistantMessage.metadata?.longMemoryAbortSignal,context.signal,"memory path receives cancellation state");
  equal(memoryRequests[0]?.model,"cognitive-model","LONGMEMORY retains cognitive model provenance");
  ok(!JSON.stringify(memoryRequests[0]?.assistantMessage).includes("A separate public reply"),"public speech is never sent as a memory candidate");
  ok(!JSON.stringify(memoryRequests[0]).includes("private thoughts live only"),"LONGMEMORY never receives private NovaTurn thoughts");
  ok(Boolean(memoryRequests[0]),"LONGMEMORY candidate was passed to memory persistence");
  const priorProjected=memoryRequests[0]?.contextMessages.find(message=>message.id==="nova-turn:background-turn");
  equal(priorProjected?.content,"Earlier public statement","prior NovaTurn context is projected to speech before candidate persistence");
  ok(!JSON.stringify(priorProjected).includes("private internal detail"),"prior private thoughts are filtered from Automatic Memory");
  await lifeController.commitNovaTurn(turn,context,async()=>{persistenceWrites++;});
  equal(persistenceWrites,1,"repeated turn commit is idempotent and does not persist twice");
  equal(lifeController.getSnapshot().messages.length,persistedMessages.length,"repeated commit does not duplicate the assistant record");

  const noCandidateSession=new ConversationSession("life-no-candidate","character.life-no-candidate");
  let emptyCandidateWrites=0;
  const noCandidateController=new ChatSessionController(noCandidateSession,{async chat(request){return responseFor(request)}},{
    requestIdFactory:()=>"life-no-candidate-turn",
    memoryExtractor:{extract:async()=>{emptyCandidateWrites++;return [];}}
  });
  await noCandidateController.submitToLife("Answer without a durable fact",async()=>{},()=>true);
  const noCandidateContext:import("../../contracts/src").MindTurnExecutionContext={
    characterId:"character.life-no-candidate",conversationId:"life-no-candidate",turnId:"life-no-candidate-turn",userMessageId:"life-no-candidate-turn:user",signal:new AbortController().signal
  };
  await noCandidateController.commitNovaTurn({...turn,longMemory:""},noCandidateContext,async()=>{});
  await new Promise(resolve=>setTimeout(resolve,0));
  equal(emptyCandidateWrites,0,"empty LONGMEMORY does not invoke any memory persistence path");

  const cancelledCommitSession=new ConversationSession("life-cancelled-commit","character.life-cancelled-commit");
  let cancelledCandidateWrites=0;
  const cancelledCommitController=new ChatSessionController(cancelledCommitSession,{async chat(request){return responseFor(request)}},{
    requestIdFactory:()=>"life-cancelled-turn",
    memoryExtractor:{extract:async()=>{cancelledCandidateWrites++;return [];}}
  });
  await cancelledCommitController.submitToLife("This reply is cancelled during persistence",async()=>{},()=>true);
  const commitAbort=new AbortController();
  const cancelledCommitContext:import("../../contracts/src").MindTurnExecutionContext={
    characterId:"character.life-cancelled-commit",conversationId:"life-cancelled-commit",turnId:"life-cancelled-turn",userMessageId:"life-cancelled-turn:user",signal:commitAbort.signal
  };
  let cancelledCommitRejected=false;
  try{
    await cancelledCommitController.commitNovaTurn({...turn,longMemory:"Must never be stored."},cancelledCommitContext,async(_snapshot,rollback)=>{if(!rollback)commitAbort.abort();});
  }catch{cancelledCommitRejected=true;}
  equal(cancelledCommitRejected,true,"a turn cancelled during persistence is rejected");
  await new Promise(resolve=>setTimeout(resolve,0));
  equal(cancelledCandidateWrites,0,"cancelled NovaTurn never dispatches LONGMEMORY to persistence");
  equal(cancelledCommitController.getSnapshot().messages.some(message=>message.role==="assistant"),false,"cancelled NovaTurn is not exposed as a committed assistant message");

  const failedSession=new ConversationSession("life-failed-conversation","character.life-failed");
  const failedController=new ChatSessionController(failedSession,{async chat(request){return responseFor(request);}}, {requestIdFactory:()=>"failed-life-1"});
  const failedSubmit=await failedController.submitToLife("Persist before reply",async()=>{},()=>true);
  ok(failedSubmit.status==="awaiting-life","persistence-failure fixture has a pending turn");
  const failedTurnContext:import("../../contracts/src").MindTurnExecutionContext={
    characterId:"character.life-failed",conversationId:"life-failed-conversation",turnId:"failed-life-1",userMessageId:"failed-life-1:user",signal:new AbortController().signal
  };
  let persistenceFailure=false;
  try{await failedController.commitNovaTurn({...turn,speech:"This must not be delivered"},failedTurnContext,async()=>{throw new Error("controlled persistence failure");});}
  catch{persistenceFailure=true;}
  equal(persistenceFailure,true,"storage failure rejects NovaTurn commit explicitly");
  equal(failedController.getSnapshot().messages.map(message=>message.role).join("|"),"user","unpersisted assistant is absent from Chat");
  equal(failedController.isBusy(),false,"failed persistence releases Chat busy state");
  failedController.failLifeTurn(failedTurnContext.userMessageId!,"PERSIST_FAILED");
  equal(failedController.getSnapshot().lifeTurn?.status,"failed","failed persistence leaves the turn retryable rather than complete");
  const retryAfterFailure=failedController.retryLife(()=>true);
  equal(retryAfterFailure.status,"awaiting-life","storage failure can be retried against the retained user message");

  console.log("PASS Chat session/controller unit tests");
}
function abortError():Error{const error=new Error("The operation was aborted.");error.name="AbortError";return error;}
void main().catch(error=>{console.error(error);process.exitCode=1});
