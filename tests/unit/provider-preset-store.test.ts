import {
  IpcProviderPresetStore,InMemoryProviderPresetStore,materializeProviderConfiguration,migrateProviderConfiguration,PROVIDER_PRESET_COMMANDS
} from "../../host/provider-presets/src";
import {IpcCredentialProfileStore,InMemoryCredentialProfileStore,CREDENTIAL_PROFILE_COMMANDS} from "../../host/credential-profiles/src";
import type {CredentialProfile,ProviderConfiguration,ProviderPresetStoreState,CredentialProfileStoreState} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

function credential(id:string,label:string):CredentialProfile{
  return {id,label,providerId:"openai-compatible",credentialReference:{id,kind:"api-key",provider:"openai-compatible",version:"1"},createdAt:"2026-09-28T00:00:00Z",updatedAt:"2026-09-28T00:00:00Z"};
}
const baseConfig:ProviderConfiguration={
  apiVersion:"1",schemaVersion:"1",providerId:"openai-compatible",enabled:true,
  baseUrl:"https://api.example/v1",model:"model-a",
  credentialReference:{id:"cred-a",kind:"api-key",provider:"openai-compatible",version:"1"},timeoutMs:30000
};

async function main(){
  const inMemory=new InMemoryProviderPresetStore();
  const state:ProviderPresetStoreState={apiVersion:"1",schemaVersion:"1",presets:[{
    id:"preset-mistral",name:"Mistral",providerId:"openai-compatible",baseUrl:"https://api.mistral.ai/v1",credentialProfileId:"cred-profile-a",model:"mistral-small",timeoutMs:30000,createdAt:"2026-09-28T00:00:00Z",updatedAt:"2026-09-28T00:00:00Z"
  },{
    id:"preset-groq",name:"Groq",providerId:"openai-compatible",baseUrl:"https://api.groq.com/openai/v1",credentialProfileId:"cred-profile-b",model:"llama",timeoutMs:30000,createdAt:"2026-09-28T00:00:00Z",updatedAt:"2026-09-28T00:00:00Z"
  }],activePresetId:"preset-mistral"};
  await inMemory.save(state);
  const roundTrip=await inMemory.load();
  equal(roundTrip,state,"multiple presets survive in-memory persistence");

  const migrated=migrateProviderConfiguration(baseConfig,"2026-09-28T00:00:00Z");
  equal(migrated.preset.providerId,"openai-compatible","legacy config provider id preserved");
  equal(migrated.preset.baseUrl,baseConfig.baseUrl,"legacy base URL preserved");
  equal(migrated.preset.model,baseConfig.model,"legacy model preserved");
  equal(migrated.credentialProfile?.credentialReference.id,"cred-a","legacy credential reference reused");

  const credentials:CredentialProfileStoreState={apiVersion:"1",schemaVersion:"1",profiles:[credential("cred-profile-a","Mistral Main"),credential("cred-profile-b","Groq Main")]};
  equal(materializeProviderConfiguration(state.presets[0]!,credentials.profiles[0]!).credentialReference?.id,"cred-profile-a","preset materialization keeps credential reference boundary");
  equal(materializeProviderConfiguration(state.presets[0]!,credentials.profiles[0]!).model,"mistral-small","preset materialization keeps model");

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
  equal((await ipcPresets.load())?.activePresetId,"preset-mistral","IPC preset store preserves active preset");
  await ipcCredentials.save(credentials);
  equal((await ipcCredentials.load())?.profiles.length,2,"IPC credential store preserves two credential metadata profiles");
  ok(calls.includes(PROVIDER_PRESET_COMMANDS.save),"IPC save provider preset command used");
  ok(calls.includes(CREDENTIAL_PROFILE_COMMANDS.save),"IPC save credential profile command used");

  const reloaded=new InMemoryCredentialProfileStore();
  await reloaded.save(credentials);
  equal((await reloaded.load())?.profiles[0]?.credentialReference.id,"cred-profile-a","credential metadata keeps only opaque reference");

  console.log("PASS provider preset and credential profile store tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
