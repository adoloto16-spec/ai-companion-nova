import {ChatSessionController,ConversationSession} from "../../core/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryModelProfileStore} from "../../host/model-profiles/src";
import {defaultModelProfile,type ChatRequest, type ChatResponse, type ModelProfile} from "../../contracts/src";

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
  console.log("PASS model profile runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
