import assert from "node:assert/strict";
import {
  AgentCognitiveController,
  AiRuntime,
  ProviderRegistry,
} from "../../core/src/index";
import {AgentChatController} from "../../apps/desktop-ui/src/agent-chat";
import {createFoundationRuntime} from "../../runtime/bootstrap/src/index";
import type {
  ChatMessage,
  ChatProvider,
  ChatProviderMetadata,
  ChatRequest,
  ChatResponse,
  HealthStatus,
  ModelInfo,
  ProviderCapabilities,
  Conversation,
} from "../../contracts/src/index";

function equal(actual:unknown,expected:unknown,label:string){assert.equal(actual,expected,label)}
function ok(value:unknown,label:string){assert.ok(value,label)}

class ScriptedAgentProvider implements ChatProvider{
  readonly id="test-agent-provider";
  calls:ChatRequest[]=[];
  contexts:readonly ChatMessage[][]=[];

  metadata():ChatProviderMetadata{
    return {id:this.id,kind:"chat",displayName:"Test Agent Provider",version:"1"};
  }
  capabilities():ProviderCapabilities{
    return {streaming:false,structuredOutput:true};
  }
  async listModels():Promise<ModelInfo[]>{return [{id:"test-model",capabilities:this.capabilities()}]}
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:["structuredOutput"]}}
  async chat(request:ChatRequest):Promise<ChatResponse>{
    this.calls.push(request);
    const visible=request.context.messages.slice(1,-1);
    this.contexts=[...this.contexts,visible];
    const payload=JSON.parse(request.context.messages.at(-1)?.content??"{}") as {task?:string};
    const hasAnswer=visible.some(message=>message.role==="user"&&message.content.toLowerCase().includes("анализ данных"));
    const decision=payload.task==="расскажи о своих возможностях"
      ?{action:"finish",result:"Nova can explain concepts, work through multi-step tasks, and use conversation context."}
      :!hasAnswer
        ?{action:"ask_user",question:"Какой анализ данных нужен?"}
        :{action:"finish",result:"Продолжу с анализом данных и завершу задачу."};
    return {
      apiVersion:"1",schemaVersion:"1",requestId:request.requestId,conversationId:request.context.conversationId,
      providerId:this.id,model:"test-model",
      message:{id:request.requestId+":assistant",role:"assistant",content:JSON.stringify(decision)},
      finishReason:"stop"
    };
  }
}

function persistence(runtime:Awaited<ReturnType<typeof createFoundationRuntime>>){
  return async(characterId:string,conversationId:string,messages:readonly ChatMessage[]):Promise<Conversation>=>{
    return runtime.updateConversation(characterId,conversationId,{messages});
  };
}

async function main(){
  const provider=new ScriptedAgentProvider();
  const providers=new ProviderRegistry();
  providers.register(provider,["chat"]);
  const cognitiveRuntime=new AiRuntime(providers);
  const cognitiveController=new AgentCognitiveController(cognitiveRuntime);

  const runtime=await createFoundationRuntime({agentCognitiveController:cognitiveController});
  await runtime.start();
  try{
    const character=await runtime.getActiveCharacter();
    const conversation=await runtime.getActiveConversation(character.id);
    const persist=persistence(runtime);

    const directController=new AgentChatController(runtime,character.id,conversation,persist);
    const direct=await directController.submit("расскажи о своих возможностях",provider.id,"test-model");
    equal(direct.status,"completed","simple informational request finishes directly");
    equal(directController.getSnapshot().result?.includes("Nova can explain"),true,"finish result is the user-facing response");
    equal(provider.calls.length,1,"simple request requires one cognitive step");
    equal(provider.calls[0]?.context.conversationId,conversation.id,"controller uses the real Conversation id");
    equal(provider.contexts[0]?.some(message=>message.role==="user"&&message.content==="расскажи о своих возможностях"),true,"cognitive controller sees the current user message");

    const askConversation=await runtime.createConversation(character.id,{title:"Agent ask/resume"});
    const askController=new AgentChatController(runtime,character.id,askConversation,persist);
    const waiting=await askController.submit("Нужен анализ, но параметр не задан.",provider.id,"test-model");
    equal(waiting.status,"waiting","missing required information enters waiting");
    const runId=waiting.status==="rejected"?"":waiting.run.id;
    const askState=askController.getSnapshot();
    equal(askState.runId,runId,"waiting snapshot keeps the run id");
    equal(askState.messages.at(-1)?.role,"assistant","ask_user question is persisted as a normal assistant message");
    equal(askState.messages.at(-1)?.content,"Какой анализ данных нужен?","ask_user question is stored in Conversation");

    const resumed=await askController.resume("анализ данных");
    equal(resumed.status,"completed","same AgentRun completes after the user answer");
    equal(resumed.status==="completed"?resumed.run.id:"",runId,"resume keeps the same AgentRun id");
    equal(provider.calls.length,3,"one direct finish plus two ask/resume cognitive steps are executed");
    const latestConversation=await runtime.getConversation(character.id,askConversation.id);
    ok(latestConversation,"Conversation remains addressable after resume");
    const contents=latestConversation!.messages.map(message=>message.role+":"+message.content);
    equal(contents.at(-3),"assistant:Какой анализ данных нужен?","question remains in Conversation history");
    equal(contents.at(-2),"user:анализ данных","user answer is persisted before resume");
    equal(contents.at(-1),"assistant:Продолжу с анализом данных и завершу задачу.","finish result is persisted as the final assistant message");
    equal(provider.contexts[2]?.some(message=>message.role==="user"&&message.content==="анализ данных"),true,"resumed cognitive step sees the NEW user answer");
    equal(provider.calls[1]?.context.conversationId,askConversation.id,"first ask step uses the Conversation id");
    equal(provider.calls[2]?.context.conversationId,askConversation.id,"resumed step uses the Conversation id");
  }finally{
    await runtime.stop();
  }
  console.log("PASS Agent Conversation context integration test");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
