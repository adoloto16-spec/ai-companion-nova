import {ChatSessionController,ConversationSession} from "../../core/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryConversationStore} from "../../host/conversations/src";
import type {ChatRequest,ChatResponse,Conversation} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

function sessionFor(conversation:Conversation):ConversationSession{
  const session=new ConversationSession(conversation.id,conversation.characterId);
  for(const message of conversation.messages)session.addMessage(message);
  return session;
}
function responseFor(request:ChatRequest,content:string):ChatResponse{
  return {
    apiVersion:request.apiVersion,schemaVersion:request.schemaVersion,requestId:request.requestId,
    conversationId:request.context.conversationId,providerId:"fake.chat",model:request.model,
    message:{id:request.requestId+":assistant",role:"assistant",content},finishReason:"stop"
  };
}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const conversationStore=new InMemoryConversationStore();
  const runtime=await createFoundationRuntime({characterStore,conversationStore});
  await runtime.start();

  const nova=await runtime.getActiveCharacter();
  const main=await runtime.getActiveConversation(nova.id);
  equal(main.id,"conversation:"+nova.id+":default.v2","fresh Character receives deterministic default conversation");
  equal(main.title,"Main","default title");

  const aviation=await runtime.createConversation(nova.id,{title:"Aviation"});
  const story=await runtime.createConversation(nova.id,{title:"Story"});
  equal((await runtime.listConversations(nova.id)).length,3,"one Character can own many conversations");
  equal((await runtime.getActiveConversation(nova.id)).id,story.id,"new conversation becomes active");

  await runtime.setActiveConversation(nova.id,main.id);
  equal((await runtime.getActiveConversation(nova.id)).id,main.id,"active conversation is switchable");

  const mainSession=sessionFor(await runtime.getActiveConversation(nova.id));
  const controller=new ChatSessionController(mainSession,{
    chat:request=>runtime.chat(request),
    stream:(request,handlers,options)=>runtime.stream(request,handlers,options)
  },{requestIdFactory:()=> "nova-main-1"});
  const result=await controller.submit("Hello Nova main","fake-chat");
  equal(result.status,"sent","chat in conversation A succeeds");
  await runtime.updateConversation(nova.id,main.id,{messages:controller.getSnapshot().messages});

  await runtime.setActiveConversation(nova.id,aviation.id);
  const aviationBefore=await runtime.getActiveConversation(nova.id);
  equal(aviationBefore.messages.length,0,"conversation B starts empty");
  const aviationSession=sessionFor(aviationBefore);
  const aviationController=new ChatSessionController(aviationSession,{
    chat:request=>runtime.chat(request),
    stream:(request,handlers,options)=>runtime.stream(request,handlers,options)
  },{requestIdFactory:()=> "nova-aviation-1"});
  const aviationResult=await aviationController.submit("Aviation question","fake-chat");
  equal(aviationResult.status,"sent","chat in conversation B succeeds");
  await runtime.updateConversation(nova.id,aviation.id,{messages:aviationController.getSnapshot().messages});

  equal((await runtime.getConversation(nova.id,main.id))?.messages[0]?.content,"Hello Nova main","A messages stay in A");
  equal((await runtime.getConversation(nova.id,aviation.id))?.messages[0]?.content,"Aviation question","B messages stay in B");
  equal((await runtime.getConversation(nova.id,story.id))?.messages.length,0,"C remains untouched");

  const gm=await runtime.createCharacter({name:"GM"});
  const gmMain=await runtime.getActiveConversation(gm.id);
  ok(gmMain.id!==main.id,"GM default conversation has a distinct id");
  let foreignGetRejected=false;
  try{await runtime.getConversation(gm.id,main.id)}catch(error){foreignGetRejected=String(error).includes("not found")||String(error).includes("scope mismatch");}
  ok(foreignGetRejected,"cross-character conversation access is rejected");

  await runtime.setActiveCharacter(nova.id);
  equal((await runtime.getActiveConversation(nova.id)).id,aviation.id,"Nova active conversation survives Character switch");
  await runtime.setActiveCharacter(gm.id);
  equal((await runtime.getActiveConversation(gm.id)).id,gmMain.id,"GM active conversation remains character-scoped");
  await runtime.setActiveCharacter(nova.id);
  equal((await runtime.getActiveConversation(nova.id)).id,aviation.id,"switching back restores Nova active conversation");

  await runtime.updateConversation(nova.id,story.id,{title:"Story renamed"});
  equal((await runtime.getConversation(nova.id,story.id))?.title,"Story renamed","conversation rename persists");

  const deleted=await runtime.deleteConversation(nova.id,story.id);
  equal(deleted.id,aviation.id,"deleting active/last selected conversation returns another active conversation");
  equal((await runtime.listConversations(nova.id)).some(item=>item.id===story.id),false,"deleted conversation is gone");

  const afterStoryDelete=await runtime.listConversations(nova.id);
  for(const item of afterStoryDelete.filter(item=>item.id!==aviation.id))await runtime.deleteConversation(nova.id,item.id);
  await runtime.setActiveConversation(nova.id,aviation.id);
  const finalDefaultAfterDelete=await runtime.deleteConversation(nova.id,aviation.id);
  const finalDefault=finalDefaultAfterDelete;
  ok(finalDefault,"Character always retains an active conversation");
  equal(finalDefault.id,"conversation:"+nova.id+":default.v2","last deletion restores deterministic default");

  await runtime.stop();

  const restarted=await createFoundationRuntime({characterStore,conversationStore});
  await restarted.start();
  try{
    equal((await restarted.listConversations(nova.id)).length,1,"restart retains the resulting Nova conversation set");
    equal((await restarted.getActiveConversation(nova.id)).id,finalDefault.id,"active conversation survives runtime restart");
    equal((await restarted.getConversation(nova.id,finalDefault.id))?.messages.length,0,"default conversation is empty after replacement");
    const gmAfterRestart=await restarted.getActiveConversation(gm.id);
    equal(gmAfterRestart.id,gmMain.id,"GM active conversation also survives restart");
  }finally{await restarted.stop()}

  // Controller/session isolation: distinct ConversationSession ids prevent late events from being attached to the wrong conversation.
  const a:Conversation={...main,id:"conversation:isolation:a",characterId:nova.id,title:"A",messages:[],updatedAt:"2026-09-30T00:00:00.000Z"};
  const b:Conversation={...main,id:"conversation:isolation:b",characterId:nova.id,title:"B",messages:[],updatedAt:"2026-09-30T00:00:01.000Z"};
  let sentConversationId="";
  const isolatedRuntime={
    chat:async(request:ChatRequest)=>responseFor(request,"unused"),
    stream:async(request:ChatRequest,handlers:import("../../contracts/src").ChatStreamHandlers)=>{
      sentConversationId=request.context.conversationId;
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake",model:request.model,type:"delta",text:"only A"});
      await handlers.onEvent({apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"fake",model:request.model,type:"completed",finishReason:"stop"});
      return responseFor(request,"only A");
    }
  };
  const controllerA=new ChatSessionController(sessionFor(a),isolatedRuntime,{requestIdFactory:()=> "isolation-a"});
  const controllerB=new ChatSessionController(sessionFor(b),isolatedRuntime,{requestIdFactory:()=> "isolation-b"});
  equal((await controllerA.submit("message A","fake")).status,"sent","controller A sends to A");
  equal(sentConversationId,a.id,"request uses conversation A id");
  equal(controllerA.getSnapshot().messages.at(-1)?.content,"only A","A receives only A response");
  equal(controllerB.getSnapshot().messages.length,0,"B remains untouched");

  console.log("PASS Conversation Management v2 integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
