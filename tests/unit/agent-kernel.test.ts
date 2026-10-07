import assert from "node:assert/strict";
import {AgentKernel} from "../../core/src/agent-kernel";
import {parseStructuredDecision,parseTaggedDecision} from "../../core/src/agent-protocol";
import {StandardContractValidator} from "../../contracts/src/index";
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
    return {decision,outputMode:"structured"};
  }
}

const validator=new StandardContractValidator();

async function protocolTests(){
  equal(parseStructuredDecision('{"action":"respond","result":"done"}',validator).action,"respond","respond parses");
  equal(parseStructuredDecision('{"action":"tool_call","toolName":"tool-a","arguments":{"value":1},"callId":"call-1"}',validator).action,"tool_call","generic tool_call parses");
  equal(parseStructuredDecision('{"action":"wait","waitMs":100}',validator).action,"wait","wait parses");
  equal(parseStructuredDecision('{"action":"ask_user","question":"Need data"}',validator).action,"ask_user","ask_user parses");
  equal(parseTaggedDecision("<NOVA_ACTION>\ntype=respond\nresult=done\n</NOVA_ACTION>",validator).action,"respond","tagged respond parses");
  equal(parseTaggedDecision("<NOVA_ACTION>\ntype=tool_call\ntoolName=tool-a\narguments={\"value\":1}\ncallId=call-1\n</NOVA_ACTION>",validator).action,"tool_call","tagged tool_call parses");
  await rejects(()=>parseStructuredDecision('{"action":"continue"}',validator),"continue is rejected");
  await rejects(()=>parseStructuredDecision('{"action":"finish","result":"done"}',validator),"finish is rejected");
  await rejects(()=>parseTaggedDecision("<NOVA_ACTION>\ntype=continue\n</NOVA_ACTION>",validator),"tagged continue is rejected");
  console.log("PASS Agent decision protocol tests");
}

class StubActionExecutor{
  async execute(_run:unknown,decision:AgentDecision){
    if(decision.action==="tool_call"){
      const toolMessage:ChatMessage={role:"tool",content:"{\"status\":\"success\",\"output\":{\"value\":42}}",toolCallId:decision.callId,metadata:{contextSource:"agent_tool_result"}};
      return {outcome:"tool_called" as const,nextState:"thinking" as const,summary:"tool:success",contextMessages:[toolMessage]};
    }
    if(decision.action==="respond")return {outcome:"responded" as const,nextState:"completed" as const,summary:decision.result};
    if(decision.action==="wait")return {outcome:"waiting" as const,nextState:"waiting" as const,summary:"wait:"+decision.waitMs,waitMs:decision.waitMs};
    return {outcome:"waiting" as const,nextState:"waiting" as const,summary:decision.question};
  }
}

async function kernelTests(){
  const controller=new SequenceController([
    {action:"tool_call",toolName:"tool-a",arguments:{value:1},callId:"call-1"},
    {action:"respond",result:"Tool result processed."}
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

  console.log("PASS Agent Kernel tests");
}

void (async()=>{await protocolTests();await kernelTests();console.log("PASS Agent Kernel unit tests");})().catch(error=>{console.error(error);process.exitCode=1;});
