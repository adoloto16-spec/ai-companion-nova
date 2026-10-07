import type {ProviderConfiguration,ProviderPreset,ProviderPresetStore,ProviderPresetStoreState,CredentialProfile,CredentialReference} from "../../../contracts/src/index";

export type ProviderPresetInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;
export const PROVIDER_PRESET_COMMANDS={get:"get_provider_presets",save:"save_provider_presets",remove:"delete_provider_preset"} as const;

function normalizeCredential(credential:ProviderPreset["credentials"] extends readonly (infer C)[]?C:never){
  return {
    ...credential,
    health:credential.health??"healthy",
    failureCount:credential.failureCount??0,
    cooldownUntil:credential.cooldownUntil??null,
    lastSuccessAt:credential.lastSuccessAt??null,
    lastFailureAt:credential.lastFailureAt??null,
    temporarilyDisabledUntil:credential.temporarilyDisabledUntil??null
  };
}
function clonePreset(preset:ProviderPreset):ProviderPreset{return {...preset,...(preset.credentials?{credentials:preset.credentials.map(credential=>normalizeCredential(credential))}: {})};}
function cloneState(state:ProviderPresetStoreState):ProviderPresetStoreState{return {...state,presets:state.presets.map(clonePreset)};}

export function emptyProviderPresetState():ProviderPresetStoreState{
  return {apiVersion:"1",schemaVersion:"1",presets:[],activePresetId:null};
}
export function credentialReferenceForProfile(profile:CredentialProfile|undefined):CredentialReference|null{
  return profile?{...profile.credentialReference}:null;
}
export function materializeProviderConfiguration(
  preset:ProviderPreset,
  credentialProfile:CredentialProfile|undefined
):ProviderConfiguration{
  const model=preset.model?.trim()??"";
  const credentialReference=credentialReferenceForProfile(credentialProfile);
  return {
    apiVersion:"1",
    schemaVersion:"1",
    providerId:preset.providerId,
    enabled:Boolean(model),
    baseUrl:preset.baseUrl,
    model,
    credentialReference,
    ...(preset.credentials?.length?{credentials:preset.credentials.map(credential=>normalizeCredential(credential))}:{}),
    ...(preset.timeoutMs===undefined?{}:{timeoutMs:preset.timeoutMs})
  };
}
export function migrateProviderConfiguration(
  configuration:ProviderConfiguration,
  now=new Date().toISOString(),
  existingCredentialProfileId?:string
):{preset:ProviderPreset;credentialProfile:CredentialProfile|undefined}{
  const reference=configuration.credentialReference??undefined;
  const credentialProfile=reference&&!configuration.credentials?.length?{
    id:"credential-profile:migrated:"+reference.id,
    label:"Migrated "+reference.id,
    providerId:configuration.providerId,
    credentialReference:{...reference},
    createdAt:now,
    updatedAt:now
  }:undefined;
  return {
    credentialProfile,
    preset:{
      id:"provider-preset:migrated-v1",
      name:"Migrated Provider",
      providerId:configuration.providerId,
      baseUrl:configuration.baseUrl,
      ...(credentialProfile?{credentialProfileId:existingCredentialProfileId??credentialProfile.id}:{}),
      ...(configuration.model?{model:configuration.model}:{}),
      ...(configuration.credentials?.length?{credentials:configuration.credentials.map(credential=>normalizeCredential(credential))}:{}),
      ...(configuration.timeoutMs===undefined?{}:{timeoutMs:configuration.timeoutMs}),
      createdAt:now,
      updatedAt:now
    }
  };
}
export class InMemoryProviderPresetStore implements ProviderPresetStore{
  private state:ProviderPresetStoreState|undefined;
  async load(){return this.state?cloneState(this.state):undefined;}
  async save(state:ProviderPresetStoreState){this.state=cloneState(state);}
  async delete(id:string){
    if(!this.state)return;
    const activePresetId=this.state.activePresetId===id?null:this.state.activePresetId;
    this.state={...this.state,activePresetId,presets:this.state.presets.filter(preset=>preset.id!==id)};
  }
}
export class IpcProviderPresetStore implements ProviderPresetStore{
  constructor(private readonly invoke:ProviderPresetInvoke){}
  async load(){
    const value=await this.invoke(PROVIDER_PRESET_COMMANDS.get);
    return value===null||value===undefined?undefined:value as ProviderPresetStoreState;
  }
  async save(state:ProviderPresetStoreState){await this.invoke(PROVIDER_PRESET_COMMANDS.save,{state:cloneState(state)});}
  async delete(id:string){await this.invoke(PROVIDER_PRESET_COMMANDS.remove,{id});}
}
