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
  return {
    ...preset,
    sources:preset.sources.map(cloneSource),
    ...(preset.credentialReference!==undefined?{credentialReference:preset.credentialReference?{...preset.credentialReference}:null}:{})
  };
}

export function cloneProviderPresetForSaveAsNew(preset:ProviderPreset,id:string,now=new Date().toISOString()):ProviderPreset{
  const cloned=clonePreset(preset);
  return {...cloned,id,createdAt:now,updatedAt:now};
}

export function validateProviderPresetCredentialReferences(
  preset:ProviderPreset,
  profiles:readonly CredentialProfile[]
):void{
  if(preset.type==="single"&&preset.providerId!=="ollama"&&!preset.credentialReference)throw new Error("Single provider preset requires a saved credential reference.");
  const configurations=preset.type==="single"
    ?[{name:preset.name,providerId:preset.providerId??"",credentialReference:preset.credentialReference??null}]
    :preset.sources.map(source=>({name:source.name,providerId:source.providerId,credentialReference:source.credentialReference}));
  for(const source of configurations){
    const reference=source.credentialReference;
    if(!reference)continue;
    const profile=profiles.find(candidate=>candidate.credentialReference.id===reference.id);
    if(!profile){
      throw new Error(`Credential reference "${reference.id}" for "${source.name}" is unavailable. Re-select or recreate the credential before saving.`);
    }
    if(profile.providerId!==source.providerId||profile.credentialReference.provider!==reference.provider){
      throw new Error(`Credential reference "${reference.id}" does not belong to provider "${source.providerId}". Re-select the credential before saving.`);
    }
  }
}

function cloneState(state:ProviderPresetStoreState):ProviderPresetStoreState{
  return {...state,presets:state.presets.map(clonePreset)};
}

export function migrateProviderPresetStoreState(state:ProviderPresetStoreState):ProviderPresetStoreState{
  if(state.apiVersion!=="1")throw new Error("Unsupported provider preset API version.");
  if(state.schemaVersion==="3"){
    for(const preset of state.presets){
      if(preset.type!=="pool"&&preset.type!=="single")throw new Error("Provider preset type is required and must be pool or single.");
    }
    return cloneState(state);
  }
  if(state.schemaVersion!=="2")throw new Error("Unsupported provider preset storage version.");
  return {
    ...state,
    schemaVersion:"3",
    presets:state.presets.map(preset=>{
      const storedType=(preset as ProviderPreset & {type?:string}).type;
      if(storedType!==undefined&&storedType!=="pool"&&storedType!=="single"){
        throw new Error("Unsupported provider preset type in legacy storage.");
      }
      return clonePreset({...preset,type:storedType??"pool"});
    })
  };
}

export function emptyProviderPresetState():ProviderPresetStoreState{
  return {apiVersion:"1",schemaVersion:"3",presets:[],activePresetId:null};
}

export function credentialReferenceForProfile(profile:CredentialProfile|undefined):CredentialReference|null{
  return profile?{...profile.credentialReference}:null;
}

export function materializeSingleProviderConfiguration(preset:ProviderPreset):ProviderConfiguration|undefined{
  if(preset.type!=="single"||!preset.providerId||!preset.baseUrl||preset.enabled===undefined||preset.enabled===null)return undefined;
  if(preset.providerId!=="ollama"&&!preset.credentialReference)return undefined;
  if(preset.providerId==="ollama"&&preset.credentialReference)return undefined;
  return {
    apiVersion:"1",
    schemaVersion:"1",
    providerId:preset.providerId,
    enabled:preset.enabled,
    baseUrl:preset.baseUrl,
    model:preset.model??"",
    credentialReference:preset.credentialReference?{...preset.credentialReference}:null,
    ...(preset.timeoutMs==null?{}:{timeoutMs:preset.timeoutMs}),
    ...(preset.temperature==null?{}:{temperature:preset.temperature}),
    ...(preset.topP==null?{}:{topP:preset.topP}),
    ...(preset.numCtx==null?{}:{numCtx:preset.numCtx}),
    ...(preset.numPredict==null?{}:{numPredict:preset.numPredict}),
    ...(preset.keepAlive==null?{}:{keepAlive:preset.keepAlive})
  };
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
    ...(source.timeoutMs===undefined?{}:{timeoutMs:source.timeoutMs}),
    ...(source.temperature===undefined?{}:{temperature:source.temperature}),
    ...(source.topP===undefined?{}:{topP:source.topP}),
    ...(source.numCtx===undefined?{}:{numCtx:source.numCtx}),
    ...(source.numPredict===undefined?{}:{numPredict:source.numPredict}),
    ...(source.keepAlive===undefined?{}:{keepAlive:source.keepAlive})
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
    ...(configuration.temperature===undefined?{}:{temperature:configuration.temperature}),
    ...(configuration.topP===undefined?{}:{topP:configuration.topP}),
    ...(configuration.numCtx===undefined?{}:{numCtx:configuration.numCtx}),
    ...(configuration.numPredict===undefined?{}:{numPredict:configuration.numPredict}),
    ...(configuration.keepAlive===undefined?{}:{keepAlive:configuration.keepAlive}),
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
      type:"pool",
      sources:[source],
      activeSourceId:source.id,
      createdAt:now,
      updatedAt:now
    }
  };
}

export class InMemoryProviderPresetStore implements ProviderPresetStore{
  private state:ProviderPresetStoreState|undefined;
  async load(){return this.state?migrateProviderPresetStoreState(cloneState(this.state)):undefined;}
  async save(state:ProviderPresetStoreState){this.state=migrateProviderPresetStoreState(cloneState(state));}
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
    return value===null||value===undefined?undefined:migrateProviderPresetStoreState(value as ProviderPresetStoreState);
  }
  async save(state:ProviderPresetStoreState){await this.invoke(PROVIDER_PRESET_COMMANDS.save,{state:migrateProviderPresetStoreState(cloneState(state))});}
  async delete(id:string){await this.invoke(PROVIDER_PRESET_COMMANDS.remove,{id});}
}
