import type {ProviderConfiguration} from "../../../contracts/src/index";

export type ProviderConfigurationInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;

export const PROVIDER_CONFIGURATION_COMMANDS={get:"get_provider_configuration",save:"save_provider_configuration",remove:"delete_provider_configuration"} as const;

export interface ProviderConfigurationStore{
  load():Promise<ProviderConfiguration|undefined>;
  save(configuration:ProviderConfiguration):Promise<void>;
  clear():Promise<void>;
}

export interface ProviderConfigurationLoadResult{
  configuration?:ProviderConfiguration;
  error?:string;
}

export async function loadProviderConfigurationSafely(store:ProviderConfigurationStore):Promise<ProviderConfigurationLoadResult>{
  try{
    return {configuration:await store.load()};
  }catch(error){
    return {error:error instanceof Error?error.message:String(error)};
  }
}

export function sanitizeProviderConfiguration(configuration:ProviderConfiguration):ProviderConfiguration{
  return {
    apiVersion:configuration.apiVersion,
    schemaVersion:configuration.schemaVersion,
    providerId:configuration.providerId,
    enabled:configuration.enabled,
    baseUrl:configuration.baseUrl,
    model:configuration.model,
    credentialReference:configuration.credentialReference?{
      id:configuration.credentialReference.id,
      kind:configuration.credentialReference.kind,
      ...(configuration.credentialReference.provider?{provider:configuration.credentialReference.provider}:{}),
      ...(configuration.credentialReference.version?{version:configuration.credentialReference.version}: {})
    }:null,
    ...(configuration.timeoutMs===undefined?{}:{timeoutMs:configuration.timeoutMs})
  };
}

export function serializeProviderConfiguration(configuration:ProviderConfiguration):string{
  return JSON.stringify(sanitizeProviderConfiguration(configuration),null,2);
}

export class InMemoryProviderConfigurationStore implements ProviderConfigurationStore{
  private configuration:ProviderConfiguration|undefined;
  async load(){return this.configuration?sanitizeProviderConfiguration(this.configuration):undefined;}
  async save(configuration:ProviderConfiguration){this.configuration=sanitizeProviderConfiguration(configuration);}
  async clear(){this.configuration=undefined;}
}

export class IpcProviderConfigurationStore implements ProviderConfigurationStore{
  constructor(private readonly invoke:ProviderConfigurationInvoke){}
  async load(){
    const value=await this.invoke(PROVIDER_CONFIGURATION_COMMANDS.get);
    return value===null||value===undefined?undefined:value as ProviderConfiguration;
  }
  async save(configuration:ProviderConfiguration){
    await this.invoke(PROVIDER_CONFIGURATION_COMMANDS.save,{configuration:sanitizeProviderConfiguration(configuration)});
  }
  async clear(){await this.invoke(PROVIDER_CONFIGURATION_COMMANDS.remove);}
}
