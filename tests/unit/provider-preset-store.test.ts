import {
  IpcProviderPresetStore,InMemoryProviderPresetStore,materializeProviderConfiguration,migrateProviderConfiguration,PROVIDER_PRESET_COMMANDS
} from "../../host/provider-presets/src";
import {IpcCredentialProfileStore,InMemoryCredentialProfileStore,CREDENTIAL_PROFILE_COMMANDS} from "../../host/credential-profiles/src";
import {InMemoryModelProfileStore} from "../../host/model-profiles/src";
import {defaultModelProfile} from "../../contracts/src";
import type {CredentialProfile,ProviderConfiguration,ProviderPreset,ProviderPresetSource,ProviderPresetStoreState,CredentialProfileStoreState} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

function source(id:string,providerId="openai-compatible",credentialId="credential-a"):ProviderPresetSource{
  return {
    id,
    name:"Main",
    providerId,
    baseUrl:providerId==="gemini"?"https://generativelanguage.googleapis.com/v1beta":"https://api.example/v1",
    model:"model-a",
    credentialReference:{id:credentialId,kind:"api-key",provider:providerId,version:"1"},
    enabled:true,
    health:"healthy",
    failureCount:0,
    cooldownUntil:null,
    timeoutMs:30000,
    createdAt:"2026-10-08T00:00:00Z",
    updatedAt:"2026-10-08T00:00:00Z"
  };
}
function preset(id:string):ProviderPreset{
  const main=source("source:"+id+":primary");
  const backup=source("source:"+id+":backup","openai-compatible","credential-b");
  return {id,name:id,sources:[main,backup],activeSourceId:main.id,createdAt:"2026-10-08T00:00:00Z",updatedAt:"2026-10-08T00:00:00Z"};
}
function credential(id:string,label:string,providerId="openai-compatible"):CredentialProfile{
  return {id,label,providerId,credentialReference:{id,kind:"api-key",provider:providerId,version:"1"},createdAt:"2026-10-08T00:00:00Z",updatedAt:"2026-10-08T00:00:00Z"};
}

const legacyConfiguration:ProviderConfiguration={
  apiVersion:"1",schemaVersion:"1",providerId:"openai-compatible",enabled:true,
  baseUrl:"https://legacy.example/v1",model:"legacy-model",
  credentialReference:{id:"legacy-credential",kind:"api-key",provider:"openai-compatible",version:"1"},timeoutMs:30000
};

async function main(){
  const inMemory=new InMemoryProviderPresetStore();
  const state:ProviderPresetStoreState={apiVersion:"1",schemaVersion:"2",presets:[preset("pool-main")],activePresetId:"pool-main"};
  await inMemory.save(state);
  equal(await inMemory.load(),state,"v2 provider pool survives in-memory persistence");

  const activeSource=state.presets[0]!.sources[0]!;
  const materialized=materializeProviderConfiguration(activeSource);
  equal(materialized.providerId,"openai-compatible","source providerId materializes");
  equal(materialized.baseUrl,activeSource.baseUrl,"source base URL materializes");
  equal(materialized.model,activeSource.model,"source model materializes");
  equal(materialized.credentialReference?.id,"credential-a","source credential reference materializes");

  const migrated=migrateProviderConfiguration(legacyConfiguration,"2026-10-08T00:00:00Z");
  equal(migrated.preset.sources.length,1,"legacy provider configuration becomes a one-source pool");
  equal(migrated.preset.sources[0]?.credentialReference?.id,"legacy-credential","legacy credential reference is preserved");
  equal(migrated.preset.sources[0]?.model,"legacy-model","legacy model is preserved");
  equal(migrated.preset.activeSourceId,migrated.preset.sources[0]?.id,"migrated source is active");

  const credentials:CredentialProfileStoreState={
    apiVersion:"1",schemaVersion:"1",
    profiles:[credential("credential-profile-a","Main"),credential("credential-profile-b","Backup")]
  };
  equal(credentials.profiles.length,2,"credential metadata supports two independent source accounts");

  const calls:string[]=[];
  let savedPresetState:ProviderPresetStoreState|undefined;
  let savedCredentialState:CredentialProfileStoreState|undefined;
  const invoke=async(command:string,args?:Record<string,unknown>):Promise<unknown>=>{
    calls.push(command);
    if(command===PROVIDER_PRESET_COMMANDS.get)return savedPresetState??null;
    if(command===PROVIDER_PRESET_COMMANDS.save){savedPresetState=args?.state as ProviderPresetStoreState;return null;}
    if(command===CREDENTIAL_PROFILE_COMMANDS.get)return savedCredentialState??null;
    if(command===CREDENTIAL_PROFILE_COMMANDS.save){savedCredentialState=args?.state as CredentialProfileStoreState;return null;}
    if(command===PROVIDER_PRESET_COMMANDS.remove||command===CREDENTIAL_PROFILE_COMMANDS.remove)return null;
    throw new Error("unexpected IPC command "+command);
  };
  const ipcPresets=new IpcProviderPresetStore(invoke);
  const ipcCredentials=new IpcCredentialProfileStore(invoke);
  await ipcPresets.save(state);
  equal((await ipcPresets.load())?.activePresetId,"pool-main","IPC preset store preserves active preset");
  await ipcCredentials.save(credentials);
  equal((await ipcCredentials.load())?.profiles.length,2,"IPC credential store preserves credential metadata");
  ok(calls.includes(PROVIDER_PRESET_COMMANDS.save),"IPC provider preset save is used");
  ok(calls.includes(CREDENTIAL_PROFILE_COMMANDS.save),"IPC credential profile save is used");

  const modelProfiles=new InMemoryModelProfileStore();
  const profile={...defaultModelProfile("character.pool"),providerPresetId:"pool-main",model:"source-model"};
  await modelProfiles.save(profile);
  equal((await modelProfiles.load("character.pool"))?.providerPresetId,"pool-main","ModelProfile keeps providerPresetId unchanged");
  equal((await modelProfiles.load("character.pool"))?.model,"source-model","ModelProfile keeps its model field");

  const reloadedCredentials=new InMemoryCredentialProfileStore();
  await reloadedCredentials.save(credentials);
  equal((await reloadedCredentials.load())?.profiles[1]?.credentialReference.id,"credential-b","credential metadata remains an opaque reference");

  const serialized=JSON.stringify(state);
  ok(!serialized.includes("secret"),"persisted v2 preset state contains no secret value");
  console.log("PASS provider preset v2 store and migration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
