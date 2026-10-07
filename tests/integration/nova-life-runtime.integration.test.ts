import assert from "node:assert/strict";
import {createFoundationRuntime} from "../../runtime/bootstrap/src/index";
import type {AgentDecision,ChatMessage} from "../../contracts/src/index";
import type {AgentCognitiveContext,AgentCognitiveDecisionProvider,AgentDecisionResult} from "../../core/src/agent-cognitive-controller";

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitFor(predicate:()=>boolean,timeoutMs=1000):Promise<void>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(predicate())return;
    await sleep(5);
  }
  throw new Error("Timed out waiting for condition.");
}

class SequenceController implements AgentCognitiveDecisionProvider{
  calls=0;
  readonly contexts:AgentCognitiveContext[]=[];
  constructor(private readonly decisions:readonly AgentDecision[]){}
  async decide(context:AgentCognitiveContext):Promise<AgentDecisionResult>{
    this.contexts.push({...context,recentConversationMessages:context.recentConversationMessages.map(message=>({...message,...(message.metadata?{metadata:{...message.metadata}}:{})}))});
    const decision=this.decisions[Math.min(this.calls++,this.decisions.length-1)]!;
    return {decision,outputMode:"tagged"};
  }
}

class FailingOnceController extends SequenceController{
  constructor(private readonly firstError:Error,decisions:readonly AgentDecision[]){super(decisions);}
  override async decide(context:AgentCognitiveContext):Promise<AgentDecisionResult>{
    if(this.calls===0){
      this.contexts.push({...context,recentConversationMessages:[...context.recentConversationMessages]});
      this.calls++;
      throw this.firstError;
    }
    return super.decide(context);
  }
}

async function main(){
  const proactive=new SequenceController([{action:"respond",result:"Привет! Я проснулась."}]);
  const runtime=await createFoundationRuntime({agentCognitiveController:proactive});
  await runtime.start();
  try{
    const character=await runtime.getActiveCharacter();
    const conversation=await runtime.getActiveConversation(character.id);
    await runtime.startNovaLife(character.id,conversation.id);
    const life=runtime.getNovaLifeState();
    assert.equal(life.status,"waiting","respond completes the burst but keeps Nova alive");
    assert.equal(life.wakeCount,1,"turning Nova on creates the first wake");
    assert.equal(proactive.calls,1,"first wake creates one bounded cognitive burst");
    const updated=await runtime.getConversation(character.id,conversation.id);
    assert.equal(updated?.messages.at(-1)?.content,"Привет! Я проснулась.","proactive result is a normal assistant message");
    assert.equal(updated?.messages.at(-1)?.metadata?.novaLife,true,"proactive message is marked as Nova Life metadata");
  }finally{await runtime.stop();}

  const waitingController=new SequenceController([
    {action:"wait",waitMs:1},
    {action:"respond",result:"Я снова проснулась."}
  ]);
  const waitingRuntime=await createFoundationRuntime({agentCognitiveController:waitingController});
  await waitingRuntime.start();
  try{
    const character=await waitingRuntime.getActiveCharacter();
    const conversation=await waitingRuntime.getActiveConversation(character.id);
    await waitingRuntime.startNovaLife(character.id,conversation.id);
    await waitFor(()=>waitingController.calls>=2);
    const state=waitingRuntime.getNovaLifeState();
    assert.equal(state.wakeCount,2,"wait schedules a second life wake");
    assert.equal(state.status,"waiting","second burst can finish without stopping Nova");
    assert.equal((await waitingRuntime.getConversation(character.id,conversation.id))?.messages.at(-1)?.content,"Я снова проснулась.","scheduled wake produces a normal message");
  }finally{await waitingRuntime.stop();}

  const userController=new SequenceController([
    {action:"wait",waitMs:300000},
    {action:"respond",result:"Получила твоё сообщение через Life Runtime."}
  ]);
  const userRuntime=await createFoundationRuntime({agentCognitiveController:userController});
  await userRuntime.start();
  try{
    const character=await userRuntime.getActiveCharacter();
    const conversation=await userRuntime.getActiveConversation(character.id);
    await userRuntime.startNovaLife(character.id,conversation.id);
    assert.equal(userController.calls,1,"Life is waiting after the initial burst");
    await userRuntime.appendConversationUserMessage(character.id,conversation.id,"Расскажи, как ты живёшь.");
    await waitFor(()=>userController.calls>=2);
    const latest=await userRuntime.getConversation(character.id,conversation.id);
    assert.equal(latest?.messages.at(-2)?.content,"Расскажи, как ты живёшь.","user message is persisted through ordinary Conversation");
    assert.equal(latest?.messages.at(-1)?.content,"Получила твоё сообщение через Life Runtime.","UserMessageReceived wakes Life without a second UI Agent path");
    assert.equal(userController.contexts[1]?.recentConversationMessages.some(message=>message.role==="user"&&message.content==="Расскажи, как ты живёшь."),true,"new cognition receives the fresh user message");
    assert.equal(userRuntime.getNovaLifeState().wakeCount,2,"user message creates a new bounded wake");
  }finally{await userRuntime.stop();}

  const toolController=new SequenceController([
    {action:"tool_call",toolName:"browser.navigate",arguments:{url:"https://wikipedia.org"},callId:"browser-call-1"},
    {action:"respond",result:"Инструмент выполнен, результат получен."}
  ]);
  const toolRuntime=await createFoundationRuntime({agentCognitiveController:toolController});
  await toolRuntime.start();
  try{
    const character=await toolRuntime.getActiveCharacter();
    const conversation=await toolRuntime.getActiveConversation(character.id);
    await toolRuntime.appendConversationUserMessage(character.id,conversation.id,"Проверь доступность Wikipedia и ответь.");
    await toolRuntime.startNovaLife(character.id,conversation.id);
    await waitFor(()=>toolController.calls>=2);
    const secondContext=toolController.contexts[1]?.recentConversationMessages??[];
    assert.equal(secondContext.some(message=>message.role==="tool"&&message.toolCallId==="browser-call-1"),true,"next cognition receives ActionBroker tool result");
    assert.equal(toolController.contexts[1]?.wakeReason,"startup","startup wake reason remains explicit");
    assert.equal((await toolRuntime.getConversation(character.id,conversation.id))?.messages.at(-1)?.content,"Инструмент выполнен, результат получен.","respond decision is persisted as normal assistant message");
    assert.equal(toolRuntime.getNovaLifeState().status,"waiting","Life remains on after tool-driven response");
  }finally{await toolRuntime.stop();}

  const askController=new SequenceController([
    {action:"ask_user",question:"Какая информация нужна?"},
    {action:"respond",result:"Теперь могу продолжить."}
  ]);
  const askRuntime=await createFoundationRuntime({agentCognitiveController:askController});
  await askRuntime.start();
  try{
    const character=await askRuntime.getActiveCharacter();
    const conversation=await askRuntime.getActiveConversation(character.id);
    await askRuntime.startNovaLife(character.id,conversation.id);
    const asked=await askRuntime.getConversation(character.id,conversation.id);
    assert.equal(asked?.messages.at(-1)?.role,"assistant","ask_user becomes ordinary assistant message");
    assert.equal(asked?.messages.at(-1)?.content,"Какая информация нужна?","question is persisted in Conversation");
    const firstRunId=askController.contexts[0]?.runId;
    await askRuntime.appendConversationUserMessage(character.id,conversation.id,"Нужна информация о возможностях Nova.");
    await waitFor(()=>askController.calls>=2);
    assert.equal(askController.contexts[1]?.runId===firstRunId,false,"reply starts a new bounded AgentRun within the same Life");
    assert.equal((await askRuntime.getConversation(character.id,conversation.id))?.messages.at(-1)?.content,"Теперь могу продолжить.","same Life persists the next assistant response");
    assert.equal(askRuntime.getNovaLifeState().status,"waiting","Life remains on after the answer");
  }finally{await askRuntime.stop();}

  const contextController=new SequenceController([{action:"respond",result:"Контекст собран."}]);
  const contextRuntime=await createFoundationRuntime({agentCognitiveController:contextController});
  await contextRuntime.start();
  try{
    const character=await contextRuntime.getActiveCharacter();
    const conversation=await contextRuntime.getActiveConversation(character.id);
    await contextRuntime.createCoreBookEntry(character.id,{
      title:"Nova Identity",
      content:"Nova is a persistent companion, not an Agent Mode.",
      tags:["identity"],
      activation:{kind:"always"},
      retentionPriority:100,
      placementWeight:100,
      mutationPolicy:"locked",
      enabled:true,
      source:"user"
    });
    await contextRuntime.createMemory(character.id,{
      type:"fact",
      content:"Nova lives in a persistent life runtime.",
      tags:["life"],
      importance:100,
      confidence:100,
      source:"user"
    });
    await contextRuntime.appendConversationUserMessage(character.id,conversation.id,"Nova lives in a persistent life runtime.");
    await contextRuntime.startNovaLife(character.id,conversation.id);
    const context=contextController.contexts[0]?.recentConversationMessages??[];
    assert.equal(context.some(message=>message.content.includes("\"novaLife\"")),true,"cognition receives current Life state");
    assert.equal(context.some(message=>message.content.includes("wakeReason")&&message.content.includes("startup")),true,"cognition receives wake reason");
    assert.equal(context.some(message=>message.content.includes("Nova is a persistent companion")),true,"Context Engine contributes Core Book");
    assert.equal(context.some(message=>message.content.includes("Nova lives in a persistent life runtime")),true,"Context Engine contributes Conversation and Memory");
  }finally{await contextRuntime.stop();}

  const offController=new SequenceController([
    {action:"wait",waitMs:20},
    {action:"respond",result:"This must not run after OFF."}
  ]);
  const offRuntime=await createFoundationRuntime({agentCognitiveController:offController});
  await offRuntime.start();
  try{
    const character=await offRuntime.getActiveCharacter();
    const conversation=await offRuntime.getActiveConversation(character.id);
    await offRuntime.startNovaLife(character.id,conversation.id);
    assert.equal(offController.calls,1,"initial wait creates one cognition burst");
    await offRuntime.stopNovaLife();
    assert.equal(offRuntime.getNovaLifeState().status,"off","OFF returns Life to off");
    await sleep(40);
    assert.equal(offController.calls,1,"OFF cancels future scheduled wake cycles");
    assert.equal((await offRuntime.getConversation(character.id,conversation.id))?.messages.length,0, "no proactive assistant result appears after OFF");
  }finally{await offRuntime.stop();}

  const failing=new FailingOnceController(new Error("provider unavailable"),[{action:"respond",result:"Recovered after provider failure."}]);
  const failingRuntime=await createFoundationRuntime({
    agentCognitiveController:failing,
    novaLifeRuntime:{retryWakeMs:1}
  });
  await failingRuntime.start();
  try{
    const character=await failingRuntime.getActiveCharacter();
    const conversation=await failingRuntime.getActiveConversation(character.id);
    await failingRuntime.startNovaLife(character.id,conversation.id);
    await waitFor(()=>failing.calls>=2);
    assert.equal(failingRuntime.getNovaLifeState().status,"waiting","provider failure is isolated and Life retries in a controlled wake");
    assert.equal((await failingRuntime.getConversation(character.id,conversation.id))?.messages.at(-1)?.content,"Recovered after provider failure.","controlled retry can recover without restarting Nova");
  }finally{await failingRuntime.stop();}

  const chatRuntime=await createFoundationRuntime();
  await chatRuntime.start();
  try{
    const chat=await chatRuntime.chat({
      apiVersion:"1",
      schemaVersion:"1",
      requestId:"ordinary-chat-off",
      model:"fake-chat",
      context:{conversationId:"chat-off",messages:[{id:"user-1",role:"user",content:"hello"}]}
    });
    assert.equal(chat.message.content,"fake response","ordinary Chat remains unchanged while Life is OFF");
    assert.equal(chatRuntime.getNovaLifeState().status,"off","Life defaults to OFF");
  }finally{await chatRuntime.stop();}

  console.log("Nova Life Runtime integration: ok");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
