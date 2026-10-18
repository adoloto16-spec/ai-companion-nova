import {ChatSessionController,ConversationSession} from "../../core/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryModelProfileStore} from "../../host/model-profiles/src";
import {defaultModelProfile,type ChatMessage,type ChatRequest,type ChatResponse,type ModelProfile,type ProviderConfiguration} from "../../contracts/src";
import type {HttpClient,HttpClientRequest,HttpClientResponse,HttpClientStreamResponse} from "../../providers/chat/openai-compatible/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

function responseFor(request:ChatRequest):ChatResponse{
  return {
    apiVersion:"1",schemaVersion:"1",requestId:request.requestId,
    conversationId:request.context.conversationId,providerId:request.providerId??"fake.chat",model:request.model,
    message:{id:request.requestId+":assistant",role:"assistant",content:"profile response"},
    finishReason:"stop"
  };
}

class LifeProfileHttpClient implements HttpClient{
  readonly requests:HttpClientRequest[]=[];
  async request(request:HttpClientRequest):Promise<HttpClientResponse>{
    this.requests.push(request);
    if(request.method==="GET")return {status:200,body:JSON.stringify({data:[{id:"discovered-model"}]})};
    return {status:500,body:JSON.stringify({error:"Unexpected non-stream request in the Nova Life regression test."})};
  }
  async stream(request:HttpClientRequest):Promise<HttpClientStreamResponse>{
    this.requests.push(request);
    const content="Reactive reply from the pinned Model Profile.";
    const event={
      id:"life-profile-response",
      model:"life-profile-model",
      choices:[{index:0,delta:{role:"assistant",content},finish_reason:null}]
    };
    const body:AsyncIterable<string>={
      async *[Symbol.asyncIterator](){
        yield "data: "+JSON.stringify(event)+"\n\n";
        yield "data: [DONE]\n\n";
      }
    };
    return {status:200,body,headers:{"content-type":"text/event-stream"}};
  }
}

async function lifeHonorsPinnedModelProfile():Promise<void>{
  const http=new LifeProfileHttpClient();
  const providerConfig=(baseUrl:string,model:string):ProviderConfiguration=>({
    apiVersion:"1",schemaVersion:"1",providerId:"openai-compatible",enabled:true,
    baseUrl,model,credentialReference:null,timeoutMs:1_000
  });
  const runtime=await createFoundationRuntime({
    characterStore:new InMemoryCharacterStore(),
    httpClient:http,
    activeProviderPresetId:"preset-life-global",
    providerPresetConfigurations:[
      {presetId:"preset-life-global",configuration:providerConfig("https://global-life.example/v1","global-model")},
      {presetId:"preset-life-profile",configuration:providerConfig("https://profile-life.example/v1","preset-default-model")}
    ]
  });
  const runtimeSettings=runtime.getSettings();
  await runtime.updateSettings({
    ...runtimeSettings,
    cognitiveSchedule:{...runtimeSettings.cognitiveSchedule,minIntervalMs:1_000}
  });
  await runtime.start();
  try{
    const character=await runtime.getActiveCharacter();
    const conversation=await runtime.getActiveConversation(character.id);
    const userMessage:ChatMessage={id:"life-profile-user-message",role:"user",content:"Answer through the model configured for Nova Life."};
    await runtime.updateConversation(character.id,conversation.id,{messages:[...conversation.messages,userMessage]});
    runtime.setActiveModelProfile({
      ...defaultModelProfile(character.id),
      providerPresetId:"preset-life-profile",
      model:"life-profile-model",
      generation:{maxTokens:123}
    });
    const committed:Array<{speech:string;providerPresetId?:string;model?:string}>=[];
    runtime.setNovaTurnSink({
      async commit(turn,context){
        committed.push({speech:turn.speech,providerPresetId:context.providerPresetId,model:context.model});
      },
      async streamSpeech(){}
    });
    const lifeStarted=runtime.startLife();
    const accepted=runtime.wakeMindForUserMessage({
      characterId:character.id,conversationId:conversation.id,
      userMessageId:userMessage.id!,turnId:"life-profile-reactive-turn"
    });
    equal(accepted,true,"Life accepts the exact persisted reactive user turn");
    await lifeStarted;
    for(let attempt=0;attempt<1_000&&committed.length===0;attempt++)
      await new Promise(resolve=>setTimeout(resolve,5));
    if(committed.length!==1){
      const state=runtime.getMindState();
      const requests=http.requests.map(item=>({
        url:item.url,method:item.method,
        ...(item.body?{model:(JSON.parse(item.body) as Record<string,unknown>).model}: {})
      }));
      throw new Error("Nova Life produced no committed reply; state="+JSON.stringify(state)+" requests="+JSON.stringify(requests));
    }
    equal(committed.length,1,"reactive turn commits exactly one reply through Nova Life");
    equal(committed[0]?.speech,"Reactive reply from the pinned Model Profile.","actual provider stream becomes the committed public reply");
    equal(committed[0]?.providerPresetId,"preset-life-profile","Life uses the profile's pinned provider preset rather than the global preset");
    equal(committed[0]?.model,"life-profile-model","turn context records the profile's explicit model");

    const request=http.requests.find(item=>item.url==="https://profile-life.example/v1/chat/completions");
    ok(request?.body,"Nova Life sends a request to the actual selected profile endpoint");
    const body=JSON.parse(request!.body!) as Record<string,unknown>;
    equal(body.model,"life-profile-model","the actual provider request uses the pinned Model Profile model");
    equal(body.max_tokens,123,"Model Profile generation limit reaches the actual Nova Life provider request");
    equal(http.requests.some(item=>item.url==="https://global-life.example/v1/chat/completions"),false,"the incorrect global preset is not used for the reactive turn");
  }finally{
    await runtime.stopLife();
    runtime.setNovaTurnSink(undefined);
    await runtime.stop();
  }
}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const profileStore=new InMemoryModelProfileStore();
  const runtime=await createFoundationRuntime({characterStore});
  await runtime.start();
  try{
    const nova=await runtime.getActiveCharacter();
    const gm=await runtime.createCharacter({name:"GM"});

    const fresh=await profileStore.load(nova.id)??defaultModelProfile(nova.id,"2026-09-28T11:00:00.000Z");
    equal(fresh.characterId,nova.id,"fresh profile is character scoped");
    equal(fresh.providerId,undefined,"fresh profile uses default provider resolution");
    equal(fresh.model,undefined,"fresh profile uses runtime model resolution");
    equal(fresh.generation,{},"fresh profile has empty canonical generation");

    const novaProfile:ModelProfile={
      ...fresh,
      providerId:"fake.chat",
      model:"nova-profile-model",
      generation:{temperature:0.4,topP:0.8,maxTokens:222},
      updatedAt:"2026-09-28T11:05:00.000Z"
    };
    await profileStore.save(novaProfile);

    const requests:ChatRequest[]=[];
    const boundary={
      chat:async(request:ChatRequest)=>{requests.push(request);return responseFor(request)},
      getChatModel:async(providerId?:string)=>{
        equal(providerId,"fake.chat","provider model resolution receives profile provider");
        return "fake-chat";
      }
    };
    const novaSession=new ConversationSession("conversation:"+nova.id+":default.v1",nova.id);
    const novaController=new ChatSessionController(novaSession,boundary);
    novaController.setModelProfile(await profileStore.load(nova.id));
    equal((await novaController.submit("hello","runtime-default-model")).status,"sent","profile chat succeeds");
    equal(requests[0]?.providerId,"fake.chat","profile providerId reaches ChatRequest");
    equal(requests[0]?.model,"nova-profile-model","profile model overrides runtime model");
    equal(requests[0]?.generation?.temperature,0.4,"temperature reaches canonical generation");
    equal(requests[0]?.generation?.topP,0.8,"topP reaches canonical generation");
    equal(requests[0]?.generation?.maxTokens,222,"maxTokens reaches canonical generation");

    const defaultProfile=defaultModelProfile(gm.id,"2026-09-28T11:00:00.000Z");
    const pinnedRequests:ChatRequest[]=[];
    const pinnedController=new ChatSessionController(
      new ConversationSession("conversation:"+nova.id+":pinned",nova.id),
      {
        chat:async(request:ChatRequest,providerPresetId?:string)=>{
          equal(providerPresetId,"preset-groq","pinned Model Profile uses its provider preset");
          pinnedRequests.push(request);
          return responseFor(request);
        },
        getChatModelForPreset:async(providerPresetId)=>{
          equal(providerPresetId,"preset-groq","preset model resolution receives pinned preset");
          return "groq-discovered-model";
        }
      }
    );
    pinnedController.setModelProfile({...defaultModelProfile(nova.id),providerPresetId:"preset-groq"});
    equal((await pinnedController.submit("pinned","ignored")).status,"sent","pinned provider preset chat succeeds");
    equal(pinnedRequests[0]?.model,"groq-discovered-model","pinned preset supplies discovered model");

    const activeRequests:ChatRequest[]=[];
    const activeController=new ChatSessionController(
      new ConversationSession("conversation:"+nova.id+":active",nova.id),
      {
        chat:async(request:ChatRequest,providerPresetId?:string)=>{
          equal(providerPresetId,"preset-mistral","unPinned profile follows active provider preset");
          activeRequests.push(request);
          return responseFor(request);
        },
        getActiveProviderPresetId:()=> "preset-mistral",
        getChatModelForPreset:async()=> "mistral-discovered-model"
      }
    );
    activeController.setModelProfile(defaultModelProfile(nova.id));
    equal((await activeController.submit("active","ignored")).status,"sent","active provider preset chat succeeds");
    equal(activeRequests[0]?.model,"mistral-discovered-model","active preset supplies discovered model");

    const gmRequests:ChatRequest[]=[];
    const gmController=new ChatSessionController(
      new ConversationSession("conversation:"+gm.id+":default.v1",gm.id),
      {
        chat:async(request:ChatRequest)=>{gmRequests.push(request);return responseFor(request)},
        getChatModel:async()=> "gm-runtime-model"
      }
    );
    gmController.setModelProfile(defaultProfile);
    equal((await gmController.submit("gm","ignored-model")).status,"sent","default provider profile chat succeeds");
    equal(gmRequests[0]?.providerId,undefined,"missing providerId keeps existing provider resolution");
    equal(gmRequests[0]?.model,"ignored-model","missing model keeps existing supplied runtime model");
    equal(gmRequests[0]?.generation,undefined,"empty generation is not injected");

    const unavailable=new ChatSessionController(
      new ConversationSession("conversation:unavailable",nova.id),
      runtime
    );
    unavailable.setModelProfile({...defaultModelProfile(nova.id),providerId:"missing.provider"});
    const unavailableResult=await unavailable.submit("hello","fake-chat");
    equal(unavailableResult.status,"error","unavailable profile provider uses canonical chat error behavior");

    const restartedRuntime=await createFoundationRuntime({characterStore});
    await restartedRuntime.start();
    try{
      const restored=await profileStore.load(nova.id);
      equal(restored?.model,"nova-profile-model","profile persists across runtime restart boundary");
      equal(restored?.characterId,nova.id,"restored profile remains Nova scoped");
      equal((await profileStore.load(gm.id))?.model,undefined,"GM still has independent default profile");
    }finally{await restartedRuntime.stop()}

    await runtime.deleteCharacter(gm.id);
    await profileStore.delete(gm.id);
    equal(await profileStore.load(gm.id),undefined,"deleted Character profile no longer applies");
    ok(await profileStore.load(nova.id),"Nova profile remains after GM deletion");
  }finally{await runtime.stop()}
  await lifeHonorsPinnedModelProfile();
  console.log("PASS model profile runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
