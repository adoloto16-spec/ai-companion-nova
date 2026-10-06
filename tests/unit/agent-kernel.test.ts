import {
  AiRuntime,AgentCognitiveController,AgentKernel,AgentKernelError,DefaultAgentActionExecutor,
  InMemoryDiagnosticsStore,ProviderRegistry,parseTaggedDecision,parseStructuredDecision
} from "../../core/src";
import {StandardContractValidator} from "../../contracts/src";
import type {AgentDecision,ChatError,ChatProvider,ChatRequest,ChatResponse,HealthStatus,ModelInfo,ProviderCapabilities,ChatRequestOptions} from "../../contracts/src";
import type {AgentCognitiveContext} from "../../core/src/agent-cognitive-controller";
import {CHAT_API_VERSION,CHAT_SCHEMA_VERSION} from "../../contracts/src";

function ok(value:unknown,label:string){if(!value)throw new Error(label);}
function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
async function rejects(fn:()=>unknown,label:string){let failed=false;try{await fn();}catch{failed=true;}ok(failed,label);}

function makeError(code:ChatError["code"],category:string,httpStatus?:number):ChatError{
  return {apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,code,message:code,retryable:false,details:{category,...(httpStatus?{httpStatus}: {})}};
}

class SequenceProvider implements ChatProvider{
  readonly id="test.agent";
  readonly calls:string[]=[];
  readonly requestPayloads:string[]=[];
  private cursor=0;
  constructor(private readonly structured:boolean,private readonly outputs:readonly string[],private readonly structuredError?:ChatError){}
  metadata(){return {id:this.id,kind:"chat" as const,displayName:"Agent Test Provider",version:"1"};}
  capabilities():ProviderCapabilities{return {streaming:false,structuredOutput:this.structured};}
  async listModels():Promise<ModelInfo[]>{return [{id:"test-model",capabilities:this.capabilities()}];}
  async chat(request:ChatRequest,_options?:ChatRequestOptions):Promise<ChatResponse>{
    const mode=request.generation?.responseFormat?.type==="json"?"structured":"text";this.calls.push(mode);
    const payload=request.context.messages.at(-1)?.content;
    if(payload)this.requestPayloads.push(payload);
    if(mode==="structured"&&this.structuredError){const error=new Error(this.structuredError.message);Object.assign(error,{chatError:this.structuredError});throw error;}
    const output=this.outputs[Math.min(this.cursor++,this.outputs.length-1)]??"<NOVA_ACTION>\ntype=finish\nresult=done\n</NOVA_ACTION>";
    return {apiVersion:request.apiVersion,schemaVersion:request.schemaVersion,requestId:request.requestId,conversationId:request.context.conversationId,providerId:this.id,model:request.model,message:{id:request.requestId,role:"assistant",content:output},finishReason:"stop"};
  }
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["chat"]};}
}

class SequenceController{
  calls=0;
  readonly contexts:AgentCognitiveContext[]=[];
  constructor(private readonly decisions:readonly AgentDecision[],private readonly outputMode:"structured"|"tagged"="tagged"){}
  async decide(context:AgentCognitiveContext){this.contexts.push({...context});const i=Math.min(this.calls++,this.decisions.length-1);return {decision:this.decisions[i]!,outputMode:this.outputMode};}
}

async function controllerTests(){
  const validator=new StandardContractValidator();

  const structuredProvider=new SequenceProvider(true,['{"action":"continue","workingSummary":"continue"}']);
  const structuredRegistry=new ProviderRegistry();structuredRegistry.register(structuredProvider,["chat"]);
  const controller=new AgentCognitiveController(new AiRuntime(structuredRegistry),{validator});
  const decision=await controller.decide({runId:"r",characterId:"c",goal:"g",task:"t",state:"thinking",stepIndex:1,model:"test-model",recentConversationMessages:[]});
  equal(decision.decision.action,"continue","structured JSON parsed");
  equal(decision.outputMode,"structured","structured mode preferred");
  equal(structuredProvider.calls[0],"structured","structured request used");

  const responseProvider=new SequenceProvider(true,['{"action":"finish","result":"done"}']);
  const responseRegistry=new ProviderRegistry();responseRegistry.register(responseProvider,["chat"]);
  const responseController=new AgentCognitiveController(new AiRuntime(responseRegistry),{validator});
  await responseController.decide({runId:"r-response",characterId:"c",goal:"g",task:"t",state:"thinking",stepIndex:2,model:"test-model",userResponse:"анализ данных",recentConversationMessages:[]});
  const responsePayload=JSON.parse(responseProvider.requestPayloads[0]!) as {userResponse?:string};
  equal(responsePayload.userResponse,"анализ данных","cognitive payload includes userResponse");

  const malformed=new SequenceProvider(true,["not json","<NOVA_ACTION>\ntype=finish\nresult=done\n</NOVA_ACTION>"]);
  const malformedRegistry=new ProviderRegistry();malformedRegistry.register(malformed,["chat"]);
  const diagnostics=new InMemoryDiagnosticsStore();
  const malformedController=new AgentCognitiveController(new AiRuntime(malformedRegistry),{validator,diagnostics});
  const fallback=await malformedController.decide({runId:"r2",characterId:"c",goal:"g",task:"t",state:"thinking",stepIndex:1,model:"test-model",recentConversationMessages:[]});
  equal(fallback.decision.action,"finish","malformed structured output falls back");
  equal(malformed.calls.join(","),"structured,text","one tagged fallback attempt");
  equal(diagnostics.recentErrors()[0]?.code,"AGENT_STRUCTURED_OUTPUT_FALLBACK","fallback diagnostic emitted");

  const unsupported=new SequenceProvider(true,["<NOVA_ACTION>\ntype=finish\nresult=done\n</NOVA_ACTION>"],makeError("UNSUPPORTED","capability"));
  const unsupportedRegistry=new ProviderRegistry();unsupportedRegistry.register(unsupported,["chat"]);
  const unsupportedController=new AgentCognitiveController(new AiRuntime(unsupportedRegistry),{validator});
  const unsupportedDecision=await unsupportedController.decide({runId:"r3",characterId:"c",goal:"g",task:"t",state:"thinking",stepIndex:1,model:"test-model",recentConversationMessages:[]});
  equal(unsupportedDecision.outputMode,"tagged","capability unsupported falls back");

  const badRequest=new SequenceProvider(true,["<NOVA_ACTION>\ntype=finish\nresult=done\n</NOVA_ACTION>"],{...makeError("PROVIDER_ERROR","capability",400),details:{category:"capability",structuredOutputUnsupported:true,httpStatus:400}});
  const badRequestRegistry=new ProviderRegistry();badRequestRegistry.register(badRequest,["chat"]);
  const badRequestController=new AgentCognitiveController(new AiRuntime(badRequestRegistry),{validator});
  const badRequestDecision=await badRequestController.decide({runId:"r4",characterId:"c",goal:"g",task:"t",state:"thinking",stepIndex:1,model:"test-model",recentConversationMessages:[]});
  equal(badRequestDecision.outputMode,"tagged","structured 400 unsupported falls back");

  const auth=new SequenceProvider(true,["<NOVA_ACTION>\ntype=finish\nresult=done\n</NOVA_ACTION>"],makeError("PROVIDER_ERROR","authentication",401));
  const authRegistry=new ProviderRegistry();authRegistry.register(auth,["chat"]);
  const authController=new AgentCognitiveController(new AiRuntime(authRegistry),{validator});
  await rejects(()=>authController.decide({runId:"r5",characterId:"c",goal:"g",task:"t",state:"thinking",stepIndex:1,model:"test-model",recentConversationMessages:[]}),"authentication failure is surfaced");
  equal(auth.calls.join(","),"structured","authentication failure does not fallback");

  const timeout=new SequenceProvider(true,["<NOVA_ACTION>\ntype=finish\nresult=done\n</NOVA_ACTION>"],makeError("PROVIDER_ERROR","timeout"));
  const timeoutRegistry=new ProviderRegistry();timeoutRegistry.register(timeout,["chat"]);
  const timeoutController=new AgentCognitiveController(new AiRuntime(timeoutRegistry),{validator});
  await rejects(()=>timeoutController.decide({runId:"r6",characterId:"c",goal:"g",task:"t",state:"thinking",stepIndex:1,model:"test-model",recentConversationMessages:[]}),"timeout is surfaced");
  equal(timeout.calls.join(","),"structured","timeout does not fallback");

  const plain=new SequenceProvider(false,["<NOVA_ACTION>\ntype=finish\nresult=done\n</NOVA_ACTION>"]);
  const plainRegistry=new ProviderRegistry();plainRegistry.register(plain,["chat"]);
  const plainController=new AgentCognitiveController(new AiRuntime(plainRegistry),{validator});
  const plainDecision=await plainController.decide({runId:"r7",characterId:"c",goal:"g",task:"t",state:"thinking",stepIndex:1,model:"test-model",recentConversationMessages:[]});
  equal(plainDecision.decision.action,"finish","plain tagged mode parses");
  equal(plain.calls.join(","),"text","unsupported structured capability skips structured request");

  for(const raw of [
    "hello",
    "<OTHER_ACTION>\ntype=finish\n</OTHER_ACTION>",
    "<NOVA_ACTION>\ntype=destroy_system\n</NOVA_ACTION>",
    "<NOVA_ACTION>\ntype=wait\nwait_ms=abc\n</NOVA_ACTION>",
    "<NOVA_ACTION>\ntype=finish\nresult=done\n</NOVA_ACTION>\n<NOVA_ACTION>\ntype=finish\nresult=again\n</NOVA_ACTION>",
    "<NOVA_ACTION>\ntype=finish\nevil_command=run\n</NOVA_ACTION>"
  ])await rejects(()=>parseTaggedDecision(raw,validator),"invalid tagged output rejected");
  equal(parseTaggedDecision("<NOVA_ACTION>\ntype=wait\nwait_ms=100\n</NOVA_ACTION>",validator).action,"wait","tagged wait normalized");
  equal(parseTaggedDecision("<NOVA_ACTION>\ntype=ask_user\nquestion=Что именно нужно сделать?\n</NOVA_ACTION>",validator).action,"ask_user","tagged ask_user normalized");
  equal(parseTaggedDecision("<NOVA_ACTION>\ntype=finish\nresult=Готово.\n</NOVA_ACTION>",validator).action,"finish","tagged finish normalized");
  equal(parseTaggedDecision("<NOVA_ACTION>\ntype=continue\nsummary=Нужно продолжить.\n</NOVA_ACTION>",validator).action,"continue","tagged continue normalized");
  await rejects(()=>parseStructuredDecision('{"action":"finish","evil":true}',validator),"structured unknown fields rejected");
  equal(parseStructuredDecision('{"action":"finish","result":"done"}',validator).action,"finish","structured finish normalized");

  console.log("PASS Agent cognitive controller tests");
}

async function kernelTests(){
  const controller=new SequenceController([{action:"continue",workingSummary:"next"},{action:"continue"},{action:"finish",result:"done"}],"structured");
  const kernel=new AgentKernel({cognitive:controller,actionExecutor:new DefaultAgentActionExecutor()});
  const run=await kernel.createRun({characterId:"c",goal:"multi-step",task:"advance"});
  const startedAt=Date.now(),completed=await kernel.run(run.id);
  equal(completed.state,"completed","cognitive loop completes");
  equal(completed.stepCount,3,"three decisions produced three steps");
  equal(controller.calls,3,"three decisions requested");
  ok(Date.now()-startedAt<1000,"continue path has no periodic artificial sleep");

  const askController=new SequenceController([{action:"ask_user",question:"Need clarification?"},{action:"continue"},{action:"finish",result:"done"}]);
  const askKernel=new AgentKernel({cognitive:askController,actionExecutor:new DefaultAgentActionExecutor()});
  const askRun=await askKernel.createRun({characterId:"c",goal:"ask",task:"t"});
  const waiting=await askKernel.run(askRun.id);
  equal(waiting.state,"waiting","ask_user waits");
  equal(askController.calls,1,"no next decision after ask_user");
  equal(askController.contexts[0]?.userResponse,undefined,"initial ask_user step has no user response");
  await askKernel.resume(askRun.id,"анализ данных");
  const resumed=await askKernel.run(askRun.id);
  equal(resumed.state,"completed","explicit resume continues waiting run");
  equal(resumed.id,askRun.id,"resume keeps the same Agent Run");
  equal(askController.contexts[1]?.userResponse,"анализ данных","resume response reaches next cognitive step");
  equal(askController.contexts[1]?.lastOutcome,"waiting:Need clarification?","lastOutcome remains the previous action outcome");
  equal(askController.contexts[2]?.userResponse,undefined,"user response is consumed after one cognitive step");

  const invalidKernel=new AgentKernel({cognitive:{async decide(){return {decision:{action:"destroy_system"} as never,outputMode:"tagged" as const};}},actionExecutor:new DefaultAgentActionExecutor()});
  const invalid=await invalidKernel.createRun({characterId:"c",goal:"invalid",task:"t"});
  equal((await invalidKernel.run(invalid.id)).state,"failed","kernel rejects invalid decision");

  const limitsDiagnostics=new InMemoryDiagnosticsStore();
  const limitedKernel=new AgentKernel({cognitive:new SequenceController([{action:"continue"}]),actionExecutor:new DefaultAgentActionExecutor(),limits:{maxSteps:2},diagnostics:limitsDiagnostics});
  const limited=await limitedKernel.createRun({characterId:"c",goal:"limit",task:"t"});
  const limitedResult=await limitedKernel.run(limited.id);
  equal(limitedResult.state,"failed","maxSteps stops infinite continue loop");
  equal(limitedResult.stepCount,2,"maxSteps is enforced");
  equal(limitsDiagnostics.recentErrors()[0]?.code,"AGENT_STEP_LIMIT_REACHED","step limit diagnostic");

  let executorCalls=0;
  const failingKernel=new AgentKernel({
    cognitive:new SequenceController([{action:"continue"},{action:"continue"},{action:"continue"}]),
    actionExecutor:{async execute(){executorCalls++;throw new Error("action failed");}},
    limits:{maxConsecutiveFailures:3}
  });
  const failureRun=await failingKernel.createRun({characterId:"c",goal:"fail",task:"t"});
  const failureResult=await failingKernel.run(failureRun.id);
  equal(failureResult.state,"failed","failure limit stops repeated action errors");
  equal(executorCalls,3,"failure count is bounded");

  let startedResolve:(value:unknown)=>void=()=>{};
  const cognitionStarted=new Promise(resolve=>{startedResolve=resolve;});
  let aborted=false;
  const blocking={async decide(_ctx:unknown,options:ChatRequestOptions={}){
    startedResolve(true);
    return await new Promise<never>((_,reject)=>{
      options.signal?.addEventListener("abort",()=>{aborted=true;const error=new Error("aborted");error.name="AbortError";reject(error);},{once:true});
    });
  }};
  const interruptKernel=new AgentKernel({cognitive:blocking as never,actionExecutor:new DefaultAgentActionExecutor()});
  const interruptRun=await interruptKernel.createRun({characterId:"c",goal:"interrupt",task:"t"});
  const runPromise=interruptKernel.run(interruptRun.id);
  await cognitionStarted;
  const interrupted=await interruptKernel.interrupt(interruptRun.id,"user cancel");
  equal(interrupted.state,"interrupted","interrupt sets interrupted state");
  equal((await runPromise).state,"interrupted","interrupted run does not auto continue");
  ok(aborted,"interrupt aborts cognitive request");

  const durationDiagnostics=new InMemoryDiagnosticsStore();
  const durationKernel=new AgentKernel({
    cognitive:{async decide(_ctx:unknown,options:ChatRequestOptions={}){
      return await new Promise<never>((_,reject)=>{
        const timer=setTimeout(()=>{const error=new Error("late");error.name="AbortError";reject(error);},100);
        options.signal?.addEventListener("abort",()=>{clearTimeout(timer);const error=new Error("duration");error.name="AbortError";reject(error);},{once:true});
      });
    }},
    actionExecutor:new DefaultAgentActionExecutor(),
    limits:{maxDurationMs:20},
    diagnostics:durationDiagnostics
  });
  const durationRun=await durationKernel.createRun({characterId:"c",goal:"duration",task:"t"});
  const durationResult=await durationKernel.run(durationRun.id);
  equal(durationResult.state,"failed","maxDuration aborts long cognition");
  equal(durationDiagnostics.recentErrors()[0]?.code,"AGENT_DURATION_LIMIT_REACHED","duration diagnostic");

  let missing=false;try{await kernel.step("missing");}catch(error){missing=error instanceof AgentKernelError&&error.code==="AGENT_RUN_NOT_FOUND";}
  ok(missing,"missing run rejected");

  console.log("PASS Agent Kernel tests");
}

void (async()=>{await controllerTests();await kernelTests();console.log("PASS Agent Kernel unit tests");})().catch(error=>{console.error(error);process.exitCode=1;});
