import {startFoundationRuntime} from "../../runtime/bootstrap/src";
import {ChatSessionController,ConversationSession} from "../../core/src";
import type {ChatRequest} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
async function main(){
  const runtime=await startFoundationRuntime();
  try{
    equal(runtime.getActiveChatModel(),"fake-chat","fake provider selects fake model");
    const session=new ConversationSession("integration-chat","character.integration");
    const requests:ChatRequest[]=[];
    const controller=new ChatSessionController(session,{
      chat(request:ChatRequest){requests.push(request);return runtime.chat(request)}
    },{requestIdFactory:(()=>{let n=0;return ()=> "integration-chat-"+(++n)})()});

    const first=await controller.submit("hello Nova","fake-chat");
    equal(first.status,"sent","real runtime chat succeeds with fake provider");
    equal(session.getMessages().length,2,"integration assistant response added");
    equal(session.characterId,"character.integration","integration conversation scope");
    equal(session.getMessages()[1]?.content,"fake response","integration assistant content");
    equal(requests.length,1,"request passed through runtime boundary");

    const second=await controller.submit("continue","fake-chat");
    equal(second.status,"sent","second runtime chat succeeds");
    equal(requests[1]?.context.messages.length,3,"conversation history reaches AiRuntime");
    equal(requests[1]?.context.messages[0]?.content,"hello Nova","history keeps first user message");
    equal(requests[1]?.context.messages[2]?.content,"continue","history includes latest user message");
    equal(controller.getSnapshot().sending,false,"integration loading state cleared");
  }finally{
    await runtime.stop();
  }
  console.log("PASS Chat session/runtime integration test");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
