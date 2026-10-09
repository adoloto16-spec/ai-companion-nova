import {ChatSessionController,ConversationSession,InMemoryChatTraceStore} from "../../core/src";
import type {AssembledContext,ChatRequest,ChatResponse,ContextBuildRequest} from "../../contracts/src";

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
  const retried=await retryController.retry("fake-streaming-chat");
  equal(retried.status,"sent","Retry succeeds");
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
  console.log("PASS Chat session/controller unit tests");
}
function abortError():Error{const error=new Error("The operation was aborted.");error.name="AbortError";return error;}
void main().catch(error=>{console.error(error);process.exitCode=1});
