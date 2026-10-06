import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {AgentChatController} from "../../apps/desktop-ui/src/agent-chat";
import {ConversationSession,ChatSessionController} from "../../core/src/chat-session";
import type {AgentChatActionResult} from "../../apps/desktop-ui/src/agent-chat";
import type {AgentRun,ChatMessage,Conversation} from "../../contracts/src/index";

function equal(actual:unknown,expected:unknown,label:string){assert.equal(actual,expected,label)}
function ok(value:unknown,label:string){assert.ok(value,label)}
function wait(ms:number){return new Promise(resolve=>setTimeout(resolve,ms))}

function runOf(result:AgentChatActionResult):AgentRun{
  if(result.status==="rejected")throw new Error("Expected an executed Agent Run result.");
  return result.run;
}

function conversation(messages:readonly ChatMessage[]=[]):Conversation{
  const now=new Date().toISOString();
  return {apiVersion:"1",schemaVersion:"2",id:"conversation:test",characterId:"character:test",title:"Test",messages,createdAt:now,updatedAt:now};
}
function run(overrides:Partial<AgentRun>):AgentRun{
  const now=new Date().toISOString();
  return {
    id:"agent-ui:test",characterId:"character:test",goal:"goal",task:"task",state:"thinking",status:"running",stepCount:1,startedAt:now,updatedAt:now,
    limits:{maxSteps:20,maxDurationMs:60000,maxConsecutiveFailures:3},...overrides
  };
}

class FakeAgentRuntime{
  runs=new Map<string,AgentRun>();
  starts:AgentRun["id"][]=[];
  inputs:unknown[]=[];
  pending=new Map<string,(run:AgentRun)=>void>();
  async startAgentRun(input:import("../../contracts/src/index").AgentRunInput):Promise<AgentRun>{
    this.starts.push(input.id!);this.inputs.push(input);
    const first=run({id:input.id!,characterId:input.characterId,task:input.task,state:"thinking",status:"running",stepCount:1,lastAction:"continue",lastOutcome:"continued"});
    this.runs.set(input.id!,first);
    for(let step=2;step<=3;step++){
      await wait(15);
      this.runs.set(input.id!,run({id:input.id!,characterId:input.characterId,task:input.task,state:step===3?"completed":"thinking",status:step===3?"completed":"running",stepCount:step,lastAction:step===3?"finish":"continue",lastOutcome:step===3?"completed:done":"continued",workingSummary:step===3?"Agent result":"working"}));
    }
    return this.runs.get(input.id!)!;
  }
  getAgentRun(runId:string):AgentRun|undefined{return this.runs.get(runId)}
  async interruptAgentRun(runId:string,reason?:string):Promise<AgentRun>{
    const current=this.runs.get(runId)??run({id:runId});
    const interrupted=run({...current,state:"interrupted",status:"interrupted",cancelReason:reason??"Interrupted by user."});
    this.runs.set(runId,interrupted);
    return interrupted;
  }
  async resumeAgentRun(runId:string):Promise<AgentRun>{
    const current=this.runs.get(runId)!;
    const resumed=run({...current,state:"completed",status:"completed",stepCount:current.stepCount+1,lastAction:"finish",workingSummary:"Resumed answer",lastOutcome:"completed"});
    this.runs.set(runId,resumed);
    return resumed;
  }
}

async function main(){
  const runtime=new FakeAgentRuntime();
  const persisted:Conversation[]=[conversation()];
  const persist=async(_characterId:string,_conversationId:string,messages:readonly ChatMessage[])=>{
    const updated={...persisted[0]!,messages:[...messages],updatedAt:new Date().toISOString()};
    persisted[0]=updated;
    return updated;
  };
  const seen:string[]=[];
  const controller=new AgentChatController(runtime,"character:test",persisted[0]!,persist);
  controller.subscribe(snapshot=>seen.push(snapshot.status));
  const completed=await controller.submit("multi-step task","provider.test","model.test");
  equal(completed.status,"completed","agent submit completes");
  equal(runtime.starts.length,1,"startAgentRun called exactly once");
  equal((runtime.inputs[0] as {providerId?:string}).providerId,"provider.test","provider-neutral provider id is passed through");
  equal((runtime.inputs[0] as {model?:string}).model,"model.test","model is passed through");
  equal(runOf(completed).stepCount,3,"multi-step run reaches the final step");
  equal(persisted[0]!.messages.filter(message=>message.role==="user").length,1,"agent user message is persisted");
  equal(persisted[0]!.messages.filter(message=>message.role==="assistant").length,1,"completed result becomes assistant message");
  equal(persisted[0]!.messages.at(-1)?.content,"Agent result","final AgentRun result is saved as normal assistant content");
  const postAgentSession=new ConversationSession(persisted[0]!.id,persisted[0]!.characterId);
  for(const message of persisted[0]!.messages)postAgentSession.addMessage(message);
  const postAgentChat=new ChatSessionController(postAgentSession,{
    async chat(request:any){return {apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"provider.test",model:"model.test",message:{id:request.requestId,role:"assistant",content:"ordinary chat after agent success"},finishReason:"stop"};}
  });
  equal((await postAgentChat.submit("normal chat after successful agent","model.test")).status,"sent","ordinary Chat remains usable after a completed Agent Run");
  equal(postAgentSession.getMessages().at(-1)?.content,"ordinary chat after agent success","ordinary Chat still appends its assistant reply");
  ok(seen.includes("thinking"),"UI bridge observes thinking state");
  ok(seen.includes("completed"),"UI bridge observes completion state");

  const waitingRuntime=new FakeAgentRuntime();
  waitingRuntime.startAgentRun=async(input)=>{
    waitingRuntime.starts.push(input.id!);
    waitingRuntime.inputs.push(input);
    const waiting=run({id:input.id!,characterId:input.characterId,task:input.task,state:"waiting",status:"waiting",stepCount:1,lastAction:"ask_user",lastOutcome:"waiting:What should I use?"});
    waitingRuntime.runs.set(input.id!,waiting);
    return waiting;
  };
  waitingRuntime.resumeAgentRun=async(runId)=>{
    const current=waitingRuntime.runs.get(runId)!;
    const resumed=run({...current,state:"completed",status:"completed",stepCount:2,lastAction:"finish",lastOutcome:"completed",workingSummary:"Resumed answer"});
    waitingRuntime.runs.set(runId,resumed);
    return resumed;
  };
  const waitingPersisted:Conversation[]=[conversation()];
  const waitingPersist=async(_characterId:string,_conversationId:string,messages:readonly ChatMessage[])=>{
    const updated={...waitingPersisted[0]!,messages:[...messages],updatedAt:new Date().toISOString()};
    waitingPersisted[0]=updated;
    return updated;
  };
  const waitingController=new AgentChatController(waitingRuntime,"character:test",waitingPersisted[0]!,waitingPersist);
  const waiting=await waitingController.submit("Need a choice");
  equal(waiting.status,"waiting","ask_user leaves the Agent Run waiting");
  equal(waitingController.getSnapshot().question,"What should I use?","agent question is visible to UI");
  const resumed=await waitingController.resume("Use option B");
  equal(resumed.status,"completed","resumeAgentRun continues the waiting run");
  equal(waitingRuntime.starts.length,1,"resume does not create a second Agent Run");
  equal(waitingRuntime.runs.get(runOf(waiting).id)?.state,"completed","existing Agent Run is resumed");
  equal(waitingPersisted[0]!.messages.at(-2)?.content,"Use option B","user answer is persisted in Conversation");
  equal(waitingPersisted[0]!.messages.at(-1)?.content,"Resumed answer","resumed result is appended as assistant message");

  const interruptRuntime=new FakeAgentRuntime();
  interruptRuntime.startAgentRun=async(input)=>{
    const thinking=run({id:input.id!,characterId:input.characterId,task:input.task,state:"thinking",status:"running",stepCount:1,lastAction:"continue",lastOutcome:"continued"});
    interruptRuntime.runs.set(input.id!,thinking);
    return await new Promise<AgentRun>(resolve=>{
      interruptRuntime.pending.set(input.id!,resolve);
    });
  };
  interruptRuntime.interruptAgentRun=async(runId,reason)=>{
    const current=interruptRuntime.runs.get(runId)!;
    const interrupted=run({...current,state:"interrupted",status:"interrupted",cancelReason:reason??"Interrupted by user."});
    interruptRuntime.runs.set(runId,interrupted);
    interruptRuntime.pending.get(runId)?.(interrupted);
    interruptRuntime.pending.delete(runId);
    return interrupted;
  };
  const interruptPersisted:Conversation[]=[conversation()];
  const interruptController=new AgentChatController(interruptRuntime,"character:test",interruptPersisted[0]!,async(_c,_i,messages)=>{
    const updated={...interruptPersisted[0]!,messages:[...messages],updatedAt:new Date().toISOString()};
    interruptPersisted[0]=updated;return updated;
  });
  const interruptPromise=interruptController.submit("stop me");
  await wait(40);
  const interrupted=await interruptController.interrupt();
  equal(interrupted.status,"interrupted","interruptAgentRun stops the active Agent Run");
  equal(interruptController.getSnapshot().status,"interrupted","UI bridge exposes interrupted state");
  equal(interruptRuntime.pending.size,0,"interrupted Agent Run completion is released");

  const failureRuntime=new FakeAgentRuntime();
  failureRuntime.startAgentRun=async(input)=>{
    const failed=run({id:input.id!,characterId:input.characterId,task:input.task,state:"failed",status:"failed",stepCount:1,lastOutcome:"provider failure"});
    failureRuntime.runs.set(input.id!,failed);return failed;
  };
  const failurePersisted:Conversation[]=[conversation()];
  const failureController=new AgentChatController(failureRuntime,"character:test",failurePersisted[0]!,async(_c,_i,messages)=>{
    const updated={...failurePersisted[0]!,messages:[...messages],updatedAt:new Date().toISOString()};
    failurePersisted[0]=updated;return updated;
  });
  const failed=await failureController.submit("fail safely");
  equal(failed.status,"failed","agent failure is surfaced");
  equal(failurePersisted[0]!.messages.filter(message=>message.role==="assistant").length,0,"failure does not add an assistant result");

  const followUpSession=new ConversationSession(failurePersisted[0]!.id,failurePersisted[0]!.characterId);
  for(const message of failurePersisted[0]!.messages)followUpSession.addMessage(message);
  const ordinaryController=new ChatSessionController(followUpSession,{
    async chat(request:any){return {apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,providerId:"provider.test",model:"model.test",message:{id:request.requestId,role:"assistant",content:"ordinary chat ok"},finishReason:"stop"};}
  });
  const ordinary=await ordinaryController.submit("normal chat after agent","model.test");
  equal(ordinary.status,"sent","ordinary Chat remains usable after Agent Run");
  equal(followUpSession.getMessages().at(-1)?.content,"ordinary chat ok","ordinary Chat still persists a normal assistant reply");

  const source=fs.readFileSync(path.resolve(process.cwd(),"apps/desktop-ui/src/main.tsx"),"utf8");
  assert.match(source,/Chat mode/);
  assert.match(source,/>Chat<\/button>/);
  assert.match(source,/>Agent<\/button>/);
  assert.match(source,/new AgentChatController/);
  assert.match(source,/agentController\.submit/);
  assert.match(source,/agentController\.resume/);
  assert.match(source,/agentController\.interrupt/);
  assert.match(source,/onPersistAgentConversation/);
  assert.match(source,/runtime\.getActiveChatModel\(\)/);
  console.log("agent-chat-ui integration: ok");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
