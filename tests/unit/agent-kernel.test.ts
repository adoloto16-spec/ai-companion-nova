import assert from "node:assert/strict";
import {AgentKernel} from "../../core/src/agent-kernel";
import {AgentDecisionProtocolError} from "../../core/src/agent-protocol";
import {parseNonStructuredDecision,parseStructuredDecision,parseTaggedDecision} from "../../core/src/agent-protocol";
import {StandardContractValidator} from "../../contracts/src/index";
import {DefaultActionBroker} from "../../core/src/action-broker";
import {DefaultAgentActionExecutor} from "../../core/src/agent-action-executor";
import {InMemoryToolRegistry,objectSchema} from "../../core/src/tools";
import type {AgentDecision,ChatMessage} from "../../contracts/src/index";
import type {AgentCognitiveContext,AgentCognitiveDecisionProvider,AgentDecisionResult} from "../../core/src/agent-cognitive-controller";

function equal(actual:unknown,expected:unknown,message:string){assert.equal(actual,expected,message);}
function ok(value:unknown,message:string){assert.ok(value,message);}
async function rejects(fn:()=>unknown,message:string){
  let thrown=false;
  try{await fn();}catch{thrown=true;}
  assert.equal(thrown,true,message);
}

class SequenceController implements AgentCognitiveDecisionProvider{
  calls=0;
  readonly contexts:AgentCognitiveContext[]=[];
  constructor(private readonly decisions:readonly AgentDecision[]){}
  async decide(context:AgentCognitiveContext):Promise<AgentDecisionResult>{
    this.contexts.push({...context,recentConversationMessages:context.recentConversationMessages.map(message=>({...message}))});
    const decision=this.decisions[Math.min(this.calls++,this.decisions.length-1)]!;
    return {decision,outputMode:"structured",modelCalls:1};
  }
}

const validator=new StandardContractValidator();

async function protocolTests(){
  equal(parseStructuredDecision('{"action":"respond","content":"done"}',validator).action,"respond","respond parses");
  equal(parseStructuredDecision('{"action":"tool_call","toolName":"tool-a","arguments":{"value":1},"callId":"call-1"}',validator).action,"tool_call","generic tool_call parses");
  equal(parseStructuredDecision('{"action":"wait","waitMs":100}',validator).action,"wait","wait parses");
  equal(parseStructuredDecision('{"action":"ask_user","question":"Need data"}',validator).action,"ask_user","ask_user parses");
  equal(parseStructuredDecision('{"action":"create_intent","intent":{"type":"followup","description":"later","priority":70}}',validator).action,"create_intent","create_intent parses");
  equal(parseStructuredDecision('{"action":"complete_intent","intentId":"intent:1"}',validator).action,"complete_intent","complete_intent parses");
  equal(parseStructuredDecision('{"action":"idle"}',validator).action,"idle","idle parses");
  equal(parseTaggedDecision("<NOVA_ACTION>\ntype=respond\ncontent=done\n</NOVA_ACTION>",validator).action,"respond","tagged respond parses");
  const plainResponse=parseNonStructuredDecision("Привет, Андрей!",validator);
  equal(plainResponse.action,"respond","plain response becomes respond");
  if(plainResponse.action!=="respond")throw new Error("Expected plain response to normalize to respond.");
  equal(plainResponse.content,"Привет, Андрей!","plain response preserves full model text");
  equal(parseTaggedDecision("<NOVA_ACTION>\ntype=tool_call\ntoolName=tool-a\narguments={\"value\":1}\ncallId=call-1\n</NOVA_ACTION>",validator).action,"tool_call","tagged tool_call parses");
  await rejects(()=>parseStructuredDecision('{"action":"continue"}',validator),"continue is rejected");
  await rejects(()=>parseStructuredDecision('{"action":"finish","content":"done"}',validator),"finish is rejected");
  await rejects(()=>parseTaggedDecision("<NOVA_ACTION>\ntype=continue\n</NOVA_ACTION>",validator),"tagged continue is rejected");
  console.log("PASS Agent decision protocol tests");
}

class StubActionExecutor{
  async execute(_run:unknown,decision:AgentDecision){
    if(decision.action==="tool_call"){
      const toolMessage:ChatMessage={role:"tool",content:"{\"status\":\"success\",\"output\":{\"value\":42}}",toolCallId:decision.callId,metadata:{contextSource:"agent_tool_result"}};
      return {outcome:"tool_called" as const,nextState:"thinking" as const,summary:"tool:success",contextMessages:[toolMessage]};
    }
    if(decision.action==="respond")return {outcome:"responded" as const,nextState:"completed" as const,summary:decision.content};
    if(decision.action==="wait")return {outcome:"waiting" as const,nextState:"waiting" as const,summary:"wait:"+decision.waitMs,waitMs:decision.waitMs};
    if(decision.action==="idle")return {outcome:"waiting" as const,nextState:"waiting" as const,summary:"idle"};
    if(decision.action==="create_intent"||decision.action==="update_intent"||decision.action==="complete_intent")return {outcome:"intent_updated" as const,nextState:"thinking" as const,summary:decision.action};
    return {outcome:"waiting" as const,nextState:"waiting" as const,summary:decision.question};
  }
}

async function kernelTests(){
  const controller=new SequenceController([
    {action:"tool_call",toolName:"tool-a",arguments:{value:1},callId:"call-1"},
    {action:"respond",content:"Tool result processed."}
  ]);
  const kernel=new AgentKernel({cognitive:controller,actionExecutor:new StubActionExecutor()});
  const run=await kernel.createRun({characterId:"nova",goal:"test",task:"use tool"});
  const completed=await kernel.run(run.id,{
    contextProvider:(_run,_step,previousRuntimeMessages)=>Promise.resolve(previousRuntimeMessages)
  });
  equal(completed.state,"completed","tool call automatically continues to next step");
  equal(completed.stepCount,2,"tool call does not consume a user-facing completion");
  equal(controller.calls,2,"second cognition occurs automatically");
  equal(controller.contexts[1]?.recentConversationMessages.some(message=>message.role==="tool"&&message.toolCallId==="call-1"),true,"tool result reaches next cognition context");

  const waitController=new SequenceController([{action:"wait",waitMs:10}]);
  const waitKernel=new AgentKernel({cognitive:waitController,actionExecutor:new StubActionExecutor()});
  const waitRun=await waitKernel.createRun({characterId:"nova",goal:"wait",task:"sleep"});
  const waiting=await waitKernel.run(waitRun.id);
  equal(waiting.state,"waiting","wait ends the cognition burst");

  const askController=new SequenceController([{action:"ask_user",question:"Need data"}]);
  const askKernel=new AgentKernel({cognitive:askController,actionExecutor:new StubActionExecutor()});
  const askRun=await askKernel.createRun({characterId:"nova",goal:"ask",task:"need input"});
  const asked=await askKernel.run(askRun.id);
  equal(asked.state,"waiting","ask_user ends the cognition burst");

  let decisionCallbackCalls=0;
  const intentController=new SequenceController([
    {action:"create_intent",intent:{type:"test",description:"keep working",priority:50,dueAt:null}},
    {action:"idle"}
  ]);
  const intentKernel=new AgentKernel({cognitive:intentController,actionExecutor:new StubActionExecutor()});
  const intentRun=await intentKernel.createRun({characterId:"nova",goal:"intent",task:"create intent"});
  const intentCompleted=await intentKernel.run(intentRun.id,{onDecision:async()=>{decisionCallbackCalls++}});
  equal(decisionCallbackCalls,2,"bounded kernel exposes every accepted decision to autonomy");
  equal(intentCompleted.lastDecision?.action,"idle","bounded run preserves final autonomy decision");
  const limitedController=new SequenceController([{action:"respond",content:"limited"}]);
  const limitedKernel=new AgentKernel({
    cognitive:limitedController,
    actionExecutor:new StubActionExecutor(),
    limits:{maxModelCallsPerBurst:1}
  });
  const limitedRun=await limitedKernel.createRun({characterId:"nova",goal:"bounded",task:"bounded"});
  const limitedCompleted=await limitedKernel.run(limitedRun.id);
  equal(limitedCompleted.modelCallCount,1,"AgentRun counts model calls per burst");
  equal(limitedCompleted.limits.maxModelCallsPerBurst,1,"AgentRun enforces configured model-call budget");

  const protocolController:AgentCognitiveDecisionProvider={
    async decide():Promise<AgentDecisionResult>{throw new AgentDecisionProtocolError("malformed");}
  };
  const protocolKernel=new AgentKernel({cognitive:protocolController,actionExecutor:new StubActionExecutor()});
  const protocolRun=await protocolKernel.createRun({characterId:"nova",goal:"protocol",task:"invalid"});
  const failed=await protocolKernel.run(protocolRun.id);
  equal(failed.state,"failed","invalid model protocol fails the bounded run");
  equal(failed.lastErrorCategory,"protocol_model_output","parser failures are categorized as protocol errors");
  equal(failed.lastAction,undefined,"protocol failure does not manufacture a respond decision");
  equal(failed.stepCount,0,"protocol failure does not count as a completed cognition step");
  equal(failed.attemptedStepCount,1,"protocol failure records one attempted cognition step");

  const registry=new InMemoryToolRegistry();
  let driverCalls=0;
  registry.register({
    id:"fake-tool",version:"1",schemaVersion:"1",name:"nova.fake.echo",description:"Fake integration test tool",
    risk:"low",requiredCapabilities:[],resourceType:"resource",action:"fake.echo",targetResolverId:"fake-test",confirmation:"never",
    parameters:objectSchema({value:{type:"string"}},["value"])
  },{
    id:"fake-driver",
    async execute(request){driverCalls++;return {echo:request.arguments.value};}
  });
  const broker=new DefaultActionBroker({
    toolRegistry:registry,
    permissions:{async check(){return {allowed:true,reason:"test permission"};}},
    foreground:{async verify(){return {allowed:true,reason:"test foreground"};}},
    riskPolicy:{canonicalRisk(){return "low";},requiresConfirmation(){return false;}},
    confirmation:{async confirm(){return true;}},
    audit:{async record(){}},
    schemaValidator:validator,
    targetResolvers:new Map([["fake-test",{id:"fake-test",async resolve(){return {kind:"resource",resource:"fake-test"};}}]]),
    actorResolver:{async resolve(){return {actorId:"test",actorType:"system",trusted:true,capabilities:[]};}}
  });
  const realExecutor=new DefaultAgentActionExecutor({toolRegistry:registry,actionBroker:broker,credential:{token:"test"}});
  const fakeToolController=new SequenceController([
    {action:"tool_call",toolName:"nova.fake.echo",arguments:{value:"hello"},callId:"fake-call-1"},
    {action:"respond",content:"fake tool result consumed"}
  ]);
  const fakeToolKernel=new AgentKernel({cognitive:fakeToolController,actionExecutor:realExecutor});
  const fakeRun=await fakeToolKernel.createRun({characterId:"nova",goal:"fake tool",task:"invoke fake tool"});
  const fakeCompleted=await fakeToolKernel.run(fakeRun.id,{contextProvider:(_run,_step,previous)=>Promise.resolve(previous)});
  equal(fakeCompleted.state,"completed","real tool broker path completes bounded cognition");
  equal(driverCalls,1,"fake tool driver executes exactly once");
  equal(fakeToolController.contexts[1]?.recentConversationMessages.some(message=>message.role==="tool"&&message.toolCallId==="fake-call-1"),true,"real ActionBroker result reaches next cognition step");

  console.log("PASS Agent Kernel tests");
}

void (async()=>{await protocolTests();await kernelTests();console.log("PASS Agent Kernel unit tests");})().catch(error=>{console.error(error);process.exitCode=1;});
