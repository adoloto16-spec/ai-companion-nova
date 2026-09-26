import {ChatSessionController,ConversationSession} from "../../core/src";
import type {ChatRequest,ChatResponse} from "../../contracts/src";

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

  console.log("PASS Chat session/controller unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
