import type {ProviderConfiguration,ProviderPreset,ProviderPresetSource,ProviderPresetStore,ProviderPresetStoreState,CredentialProfile,CredentialReference} from "../../../contracts/src/index";

export type ProviderPresetInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;
export const PROVIDER_PRESET_COMMANDS={get:"get_provider_presets",save:"save_provider_presets",remove:"delete_provider_preset"} as const;

function cloneSource(source:ProviderPresetSource):ProviderPresetSource{
  return {
    ...source,
    credentialReference:source.credentialReference?{...source.credentialReference}:null
  };
}
function clonePreset(preset:ProviderPreset):ProviderPreset{
  return {...preset,sources:preset.sources.map(cloneSource)};
}
function cloneState(state:ProviderPresetStoreState):ProviderPresetStoreState{
  return {...state,presets:state.presets.map(clonePreset)};
}

export function emptyProviderPresetState():ProviderPresetStoreState{
  return {apiVersion:"1",schemaVersion:"2",presets:[],activePresetId:null};
}

export function credentialReferenceForProfile(profile:CredentialProfile|undefined):CredentialReference|null{
  return profile?{...profile.credentialReference}:null;
}

export function materializeProviderConfiguration(source:ProviderPresetSource):ProviderConfiguration{
  return {
    apiVersion:"1",
    schemaVersion:"1",
    providerId:source.providerId,
    enabled:source.enabled&&source.model.trim().length>0,
    baseUrl:source.baseUrl,
    model:source.model,
    credentialReference:source.credentialReference?{...source.credentialReference}:null,
    ...(source.timeoutMs===undefined?{}:{timeoutMs:source.timeoutMs})
  };
}

export function providerPresetSourceId(presetId:string):string{
  return "source:"+presetId+":primary";
}

export function sourceFromProviderConfiguration(
  presetId:string,
  presetName:string,
  configuration:ProviderConfiguration,
  now=new Date().toISOString()
):ProviderPresetSource{
  return {
    id:providerPresetSourceId(presetId),
    name:presetName.trim()||"Primary",
    providerId:configuration.providerId,
    baseUrl:configuration.baseUrl,
    model:configuration.model,
    credentialReference:configuration.credentialReference?{...configuration.credentialReference}:null,
    enabled:true,
    health:"healthy",
    failureCount:0,
    cooldownUntil:null,
    ...(configuration.timeoutMs===undefined?{}:{timeoutMs:configuration.timeoutMs}),
    createdAt:now,
    updatedAt:now
  };
}

export function migrateProviderConfiguration(
  configuration:ProviderConfiguration,
  now=new Date().toISOString(),
  existingCredentialProfileId?:string
):{preset:ProviderPreset;credentialProfile:CredentialProfile|undefined}{
  const reference=configuration.credentialReference??undefined;
  const credentialProfile=reference?{
    id:"credential-profile:migrated:"+reference.id,
    label:"Migrated "+reference.id,
    providerId:configuration.providerId,
    credentialReference:{...reference},
    createdAt:now,
    updatedAt:now
  }:undefined;
  const presetId="provider-preset:migrated-v2";
  const source=sourceFromProviderConfiguration(presetId,"Migrated Provider",configuration,now);
  return {
    credentialProfile,
    preset:{
      id:presetId,
      name:"Migrated Provider",
      sources:[source],
      activeSourceId:source.id,
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
