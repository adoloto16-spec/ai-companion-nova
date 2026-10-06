import {startFoundationRuntime} from "../../runtime/bootstrap/src";
import {ChatSessionController,ConversationSession} from "../../core/src";
import {InMemoryModelProfileStore} from "../../host/model-profiles/src";
import type {ChatRequest,ModelProfile} from "../../contracts/src";
import type {HttpClient,HttpClientRequest,HttpClientStreamResponse} from "../../providers/chat/openai-compatible/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual))}

async function pinnedProviderPresetSurvivesActiveJudgePresetTest(){
  class PresetHttpClient implements HttpClient{
    streamRequests:HttpClientRequest[]=[];
    async request(_request:HttpClientRequest):Promise<{status:number;body:string}>{
      return {status:404,body:""};
    }
    async stream(request:HttpClientRequest):Promise<HttpClientStreamResponse>{
      this.streamRequests.push(request);
      return {
        status:200,
        headers:{"content-type":"text/event-stream"},
        body:{
          async *[Symbol.asyncIterator](){
            yield "data: "+JSON.stringify({id:"main-response",model:"ministral-3b-2512",choices:[{delta:{content:"main provider response"},finish_reason:"stop"}]})+"\n\n";
            yield "data: [DONE]\n\n";
          }
        }
      };
    }
  }

  const httpClient=new PresetHttpClient();
  const mainPreset={
    apiVersion:"1",schemaVersion:"1",providerId:"openai-compatible",enabled:true,
    baseUrl:"https://main.invalid/v1",model:"ministral-3b-2512",credentialReference:null
  } as const;
  const judgePreset={
    apiVersion:"1",schemaVersion:"1",providerId:"openai-compatible",enabled:true,
    baseUrl:"https://judge.invalid/v1",model:"codestral-latest",credentialReference:null,
    timeoutMs:60000
  } as const;
  const runtime=await startFoundationRuntime({
    httpClient,
    providerPresetConfigurations:[
      {presetId:"provider-preset:main:1",configuration:mainPreset},
      {presetId:"provider-preset:mistraljudge:1791200846735",configuration:judgePreset}
    ],
    activeProviderPresetId:"provider-preset:mistraljudge:1791200846735"
  });
  const modelProfileStore=new InMemoryModelProfileStore();
  const profile:ModelProfile={
    apiVersion:"1",schemaVersion:"2",
    id:"model-profile:character.nova.default.v1",
    characterId:"character.nova.default.v1",
    providerPresetId:"provider-preset:main:1",
    model:"ministral-3b-2512",
    generation:{},
    createdAt:"2026-10-06T00:00:00.000Z",
    updatedAt:"2026-10-06T00:00:00.000Z"
  };
  await modelProfileStore.save(profile);
  const reloaded=await modelProfileStore.load(profile.characterId);
  if(!reloaded)throw new Error("pinned model profile was not reloaded");

  try{
    const session=new ConversationSession("chat-provider-selection-regression","character.nova.default.v1");
    const controller=new ChatSessionController(session,{
      chat:(request,preset)=>runtime.chat(request,preset),
      stream:(request,handlers,options,preset)=>runtime.stream(request,handlers,options,preset),
      getChatModelForPreset:providerPresetId=>runtime.getChatModelForPreset(providerPresetId),
      getActiveProviderPresetId:()=>runtime.getActiveProviderPresetId(),
      getChatProviderDiagnostics:providerPresetId=>({
        providerPresetId,
        providerId:"openai-compatible",
        baseUrlHost:providerPresetId==="provider-preset:main:1"?"main.invalid":"judge.invalid",
        timeoutMs:providerPresetId==="provider-preset:main:1"?undefined:60000
      })
    });
    controller.setModelProfile(reloaded);
    const result=await controller.submit("я живу в берлине","ministral-3b-2512");
    equal(result.status,"sent","pinned main provider remains usable while Judge preset is active");
    equal(httpClient.streamRequests.length,1,"one main Chat stream request is sent");
    equal(httpClient.streamRequests[0]?.url,"https://main.invalid/v1/chat/completions","Chat uses pinned main provider preset, not active Judge preset");
  }finally{
    await runtime.stop();
  }
}

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
  await pinnedProviderPresetSurvivesActiveJudgePresetTest();
  console.log("PASS Chat session/runtime integration test");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
