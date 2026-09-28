import {IpcModelProfileStore,MODEL_PROFILE_COMMANDS} from "../../host/model-profiles/src";
import {defaultModelProfile} from "../../contracts/src";
import type {ModelProfile} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected)){
    throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));
  }
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const stored=new Map<string,ModelProfile>();
  const calls:string[]=[];
  const invoke=async(command:string,args?:Record<string,unknown>):Promise<unknown>=>{
    calls.push(command);
    switch(command){
      case MODEL_PROFILE_COMMANDS.get:{
        const characterId=String(args?.characterId??"");
        const profile=stored.get(characterId);
        return profile?JSON.parse(JSON.stringify(profile)):null;
      }
      case MODEL_PROFILE_COMMANDS.save:{
        const profile=args?.profile as ModelProfile|undefined;
        if(!profile)throw new Error("missing profile");
        stored.set(profile.characterId,JSON.parse(JSON.stringify(profile)));
        return null;
      }
      case MODEL_PROFILE_COMMANDS.delete:{
        const characterId=String(args?.characterId??"");
        stored.delete(characterId);
        return null;
      }
      default:throw new Error("unexpected command: "+command);
    }
  };

  const store=new IpcModelProfileStore(invoke);
  const profile:ModelProfile={
    ...defaultModelProfile("character.nova.default.v1","2026-09-28T10:00:00.000Z"),
    providerId:"fake.chat",
    model:"nova-ipc-model",
    generation:{
      temperature:0.65,
      topP:0.82,
      maxTokens:384,
      responseFormat:{type:"json",schema:{kind:"example"}}
    },
    updatedAt:"2026-09-28T10:02:00.000Z"
  };

  equal(await store.load(profile.characterId),undefined,"Ipc store starts without a saved profile");
  await store.save(profile);
  equal(calls[calls.length-1],MODEL_PROFILE_COMMANDS.save,"Ipc save uses save_model_profile");

  const loaded=await store.load(profile.characterId);
  ok(loaded,"Ipc load returns the saved profile");
  equal(loaded?.providerId,profile.providerId,"providerId survives IPC round-trip");
  equal(loaded?.model,profile.model,"model survives IPC round-trip");
  equal(loaded?.generation.temperature,0.65,"temperature survives IPC round-trip");
  equal(loaded?.generation.topP,0.82,"topP survives IPC round-trip");
  equal(loaded?.generation.maxTokens,384,"maxTokens survives IPC round-trip");
  equal(loaded?.generation.responseFormat,profile.generation.responseFormat,"responseFormat survives IPC round-trip");
  equal(loaded?.createdAt,profile.createdAt,"createdAt survives IPC round-trip");
  equal(loaded?.updatedAt,profile.updatedAt,"updatedAt survives IPC round-trip");

  await store.save({...profile,characterId:"character.gm.v1",id:"model-profile:gm:default.v1",model:"gm-ipc-model"});
  equal((await store.load(profile.characterId))?.model,"nova-ipc-model","Nova IPC profile remains isolated");
  equal((await store.load("character.gm.v1"))?.model,"gm-ipc-model","GM IPC profile remains isolated");

  await store.delete(profile.characterId);
  equal(calls[calls.length-1],MODEL_PROFILE_COMMANDS.delete,"Ipc delete uses delete_model_profile");
  equal(await store.load(profile.characterId),undefined,"deleted Nova IPC profile no longer loads");
  equal((await store.load("character.gm.v1"))?.model,"gm-ipc-model","deleting Nova does not delete GM");

  ok(calls.includes(MODEL_PROFILE_COMMANDS.get),"Ipc path uses get_model_profile");
  ok(calls.includes(MODEL_PROFILE_COMMANDS.save),"Ipc path uses save_model_profile");
  ok(calls.includes(MODEL_PROFILE_COMMANDS.delete),"Ipc path uses delete_model_profile");

  console.log("PASS model profile IPC integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
