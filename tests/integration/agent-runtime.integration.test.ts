import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import type {AgentDecision,AgentRunInput} from "../../contracts/src";
import type {AgentCognitiveContext,AgentCognitiveDecisionProvider,AgentDecisionResult} from "../../core/src/agent-cognitive-controller";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}

class FakeController implements AgentCognitiveDecisionProvider{
  private index=0;
  constructor(private readonly decisions:readonly AgentDecision[]){}
  async decide(_context:AgentCognitiveContext):Promise<AgentDecisionResult>{
    const decision=this.decisions[Math.min(this.index++,this.decisions.length-1)]!;
    return {decision,outputMode:"tagged"};
  }
}

class AskUserController implements AgentCognitiveDecisionProvider{
  calls=0;
  readonly contexts:AgentCognitiveContext[]=[];
  async decide(context:AgentCognitiveContext):Promise<AgentDecisionResult>{
    this.contexts.push({...context});
    const decision=this.calls++===0
      ?{action:"ask_user",question:"Which aspect should Nova explain?"} as const
      :{action:"finish",result:"Nova supports analysis data."} as const;
    return {decision,outputMode:"tagged"};
  }
}

async function main(){
  const runtime=await createFoundationRuntime({agentCognitiveController:new FakeController([{action:"continue"},{action:"finish",result:"done"}])});
  await runtime.start();
  try{
    const input:AgentRunInput={characterId:"character.nova.default.v1",goal:"multi-step runtime test",task:"advance"};
    const run=await runtime.startAgentRun(input);
    equal(run.state,"completed","runtime startAgentRun completes");
    equal(run.stepCount,2,"runtime cognitive loop executes two steps");
    ok(runtime.getAgentRun(run.id),"runtime getAgentRun works");
    const chat=await runtime.chat({apiVersion:"1",schemaVersion:"1",requestId:"ordinary-chat-after-agent",model:"fake-chat",context:{conversationId:"chat-regression",messages:[{role:"user",content:"hello"}]}});
    equal(chat.message.content,"fake response","ordinary Chat remains healthy after agent run");
  }finally{await runtime.stop();}

  const askController=new AskUserController();
  const askRuntime=await createFoundationRuntime({agentCognitiveController:askController});
  await askRuntime.start();
  try{
    const waiting=await askRuntime.startAgentRun({id:"agent-runtime:ask-user",characterId:"character.nova.default.v1",goal:"answer a focused question",task:"tell me about your capabilities"});
    equal(waiting.state,"waiting","ask_user returns a waiting Agent Run");
    const resumed=await askRuntime.resumeAgentRun(waiting.id,"анализ данных");
    equal(resumed.state,"completed","resume with user response completes the existing Agent Run");
    equal(resumed.id,waiting.id,"resume keeps the same run id");
    equal(askController.calls,2,"resume performs one next cognitive step");
    equal(askController.contexts[1]?.userResponse,"анализ данных","runtime resume forwards the user response into cognition");
    equal(askController.contexts[1]?.lastOutcome,"waiting:Which aspect should Nova explain?","cognitive context keeps lastOutcome as the prior action outcome");
  }finally{await askRuntime.stop();}

  const failedRuntime=await createFoundationRuntime({agentCognitiveController:{async decide(){throw new Error("cognitive failed");}}});
  await failedRuntime.start();
  try{
    const run=await failedRuntime.startAgentRun({characterId:"c",goal:"agent fails",task:"t"});
    equal(run.state,"failed","agent cognition failure is isolated");
    const chat=await failedRuntime.chat({apiVersion:"1",schemaVersion:"1",requestId:"ordinary-chat-isolated",model:"fake-chat",context:{conversationId:"isolated",messages:[{role:"user",content:"still works"}]}});
    equal(chat.message.content,"fake response","ordinary Chat survives agent failure");
  }finally{await failedRuntime.stop();}

  console.log("PASS Agent runtime integration test");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
