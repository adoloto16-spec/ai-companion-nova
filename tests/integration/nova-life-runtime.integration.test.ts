import assert from "node:assert/strict";
import {AgentKernel} from "../../core/src/agent-kernel";
import {DefaultAgentActionExecutor} from "../../core/src/agent-action-executor";
import {ConversationCandidateSource,DeterministicContextEngine} from "../../core/src/context-engine";
import {ConversationManager} from "../../core/src/conversation-manager";
import {NovaAutonomyCore} from "../../core/src/nova-autonomy-core";
import {NovaLifeRuntime} from "../../core/src/nova-life-runtime";
import type {AgentDecision,Conversation,ConversationStore,Event,EventBus,ContextBudget} from "../../contracts/src/index";
import type {AgentCognitiveDecisionProvider,AgentCognitiveContext,AgentDecisionResult} from "../../core/src/agent-cognitive-controller";

class MemoryConversationStore implements ConversationStore{
  private readonly conversations=new Map<string,Conversation>();
  private readonly active=new Map<string,string>();
  async list(characterId:string){return [...this.conversations.values()].filter(item=>item.characterId===characterId)}
  async get(_characterId:string,conversationId:string){return this.conversations.get(conversationId)}
  async save(conversation:Conversation){this.conversations.set(conversation.id,{...conversation,messages:conversation.messages.map(message=>({...message}))})}
  async delete(_characterId:string,conversationId:string){this.conversations.delete(conversationId)}
  async setActive(characterId:string,conversationId:string){this.active.set(characterId,conversationId)}
  async getActive(characterId:string){const id=this.active.get(characterId);return id?this.conversations.get(id):undefined}
  async clear(characterId:string,conversationId:string){const conversation=this.conversations.get(conversationId);if(conversation)this.conversations.set(conversationId,{...conversation,messages:[]})}
}

class MemoryAutonomyStore{
  private readonly values=new Map<string,unknown>();
  async load(characterId:string){return this.values.get("nova-autonomy:"+characterId) as any}
  async save(state:any){this.values.set("nova-autonomy:"+state.characterId,JSON.parse(JSON.stringify(state)))}
}

class TestEventBus implements EventBus{
  private readonly handlers=new Map<string,Set<(event:Event)=>void|Promise<void>>>();
  async publish(event:Event){await Promise.all([...this.handlers.get(event.type)??[]].map(handler=>handler(event)))}
  subscribe<T=unknown>(type:string,handler:(event:Event<T>)=>void|Promise<void>){
    let handlers=this.handlers.get(type);if(!handlers){handlers=new Set();this.handlers.set(type,handlers)}
    handlers.add(handler as (event:Event)=>void|Promise<void>);
    return ()=>handlers!.delete(handler as (event:Event)=>void|Promise<void>);
  }
}

class CaptureController implements AgentCognitiveDecisionProvider{
  calls=0;
  readonly contexts:AgentCognitiveContext[]=[];
  constructor(private readonly decideImpl:(context:AgentCognitiveContext,index:number)=>AgentDecision){}
  async decide(context:AgentCognitiveContext):Promise<AgentDecisionResult>{
    this.contexts.push(context);
    const decision=this.decideImpl(context,this.calls++);
    return {decision,outputMode:"tagged",modelCalls:1};
  }
}

function budget():ContextBudget{return{availableContextTokens:8000,reservedOutputTokens:1000,systemOverheadTokens:0,safetyMarginTokens:0}}

async function createTestRuntime(controller:CaptureController){
  const events=new TestEventBus();
  const conversations=new MemoryConversationStore();
  const conversationManager=new ConversationManager(conversations,{events,characterExists:async()=>true});
  const conversation=await conversationManager.getActiveConversation("character:test");
  const autonomy=new NovaAutonomyCore({store:new MemoryAutonomyStore()});
  const kernel=new AgentKernel({cognitive:controller,actionExecutor:new DefaultAgentActionExecutor({})});
  const contextEngine=new DeterministicContextEngine([new ConversationCandidateSource()]);
  const runtime=new NovaLifeRuntime({
    agentKernel:kernel,
    autonomy,
    contextEngine,
    conversationManager,
    events,
    contextBudget:budget,
    resolveProviderId:()=>undefined,
    resolveModel:async()=> "test-model",
    resolveAgentRunLimits:()=>({maxSteps:6,maxDurationMs:10000,maxModelCallsPerBurst:6,maxToolCallsPerBurst:4}),
    proactiveEnabled:()=>true,
    allowProactiveMessages:()=>true
  });
  return {runtime,events,conversationManager,conversation}
}

async function waitFor(predicate:()=>boolean,timeoutMs=1000,describe?:()=>string){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5))}
  throw new Error("Timed out waiting for integration condition."+(describe?": "+describe():""));
}

async function persistentIntentDueTest(){
  const controller=new CaptureController((context,index)=>{
    if(index===0)return{action:"create_intent",intent:{type:"finish_test_activity",description:"Finish the test activity",priority:90,dueAt:"2020-01-01T00:00:00.000Z"}};
    const autonomyContext=JSON.parse(context.recentConversationMessages.find(message=>message.metadata?.contextSource==="nova_life")?.content??"{}") as any;
    if(context.wakeReason==="intent_due"&&autonomyContext.novaLife.activeIntentions?.[0])return{action:"complete_intent",intentId:autonomyContext.novaLife.activeIntentions[0].id};
    return{action:"idle"};
  });
  const {runtime,events,conversationManager,conversation}=await createTestRuntime(controller);
  try{
    await runtime.start("character:test",conversation.id);
    await waitFor(
      ()=>runtime.getState().status==="idle"&&runtime.getState().activeIntentions?.length===0&&controller.contexts.some(context=>context.wakeReason==="intent_due"),
      1000,
      ()=>JSON.stringify({calls:controller.calls,wakeReasons:controller.contexts.map(context=>context.wakeReason),state:runtime.getState()})
    );
    const state=runtime.getState();
    assert.equal(state.status,"idle");
    assert.equal(state.activeIntentions?.length,0,"due intent was completed");
    assert.equal(controller.contexts.some(context=>context.wakeReason==="intent_due"),true,"deadline created an IntentDue cognition trigger");
    const callsAfterCompletion=controller.calls;
    await events.publish({id:"unrelated",type:"AppChanged",timestamp:new Date().toISOString(),source:"test",schemaVersion:"1",payload:{applicationId:"unrelated"}});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(controller.calls,callsAfterCompletion,"unrelated event does not create cognition");
    assert.equal(runtime.isOn(),true,"Life remains alive after cognition completes");
  }finally{await runtime.stop()}
}

async function resumeIntentAfterUserMessageTest(){
  const controller=new CaptureController((context,index)=>{
    if(index===0)return{action:"create_intent",intent:{type:"conversation_followup",description:"Continue unfinished project discussion",priority:70,dueAt:null}};
    if(context.wakeReason==="startup")return{action:"respond",content:"I will keep this thread open."};
    if(context.wakeReason==="user_message"){
      const system=JSON.parse(context.recentConversationMessages.find(message=>message.metadata?.contextSource==="nova_life")?.content??"{}") as any;
      assert.equal(system.novaLife.activeIntentions.length,1,"user-triggered cognition receives the persistent intent");
      assert.equal(system.novaLife.activeIntentions[0].type,"conversation_followup");
      return{action:"complete_intent",intentId:system.novaLife.activeIntentions[0].id};
    }
    return{action:"idle"};
  });
  const {runtime,conversationManager,events,conversation}=await createTestRuntime(controller);
  try{
    await runtime.start("character:test",conversation.id);
    await waitFor(()=>controller.calls>=2);
    const before=controller.calls;
    await conversationManager.updateConversation("character:test",conversation.id,{messages:[...conversation.messages,{id:"user:1",role:"user",content:"Новый результат по проекту"}]});

    await waitFor(()=>controller.calls>before&&runtime.getState().status==="idle");
    assert.equal(runtime.getState().activeIntentions?.length,0,"unfinished intent was completed after user-triggered cognition");
  }finally{await runtime.stop()}
}

async function noPollingModelCallTest(){
  const controller=new CaptureController(()=>({action:"idle"}));
  const {runtime,conversation}=await createTestRuntime(controller);
  try{
    await runtime.start("character:test",conversation.id);
    const callsAfterStartup=controller.calls;
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(controller.calls,callsAfterStartup,"no events and no due intentions means no model call");
  }finally{await runtime.stop()}
}

async function autonomyStorePersistenceTest(){
  const store=new MemoryAutonomyStore();
  const clock={now:()=> "2026-10-07T20:00:00.000Z"};
  const first=new NovaAutonomyCore({store,clock});
  await first.initialize("character:test");
  await first.applyDecision({action:"create_intent",intent:{type:"followup",description:"Persist me",priority:50,dueAt:null}});
  const second=new NovaAutonomyCore({store:store as any,clock});
  await second.initialize("character:test");
  assert.equal(second.getState().activeIntentions.length,1,"autonomy state survives a runtime reinitialization");
}

void (async()=>{await persistentIntentDueTest();await resumeIntentAfterUserMessageTest();await noPollingModelCallTest();await autonomyStorePersistenceTest();console.log("PASS Nova Life autonomy integration tests")})().catch(error=>{console.error(error);process.exitCode=1});
