import {
  AiRuntime,
  AiRuntimeError,
  InMemoryDiagnosticsStore,
  ProviderRegistry
} from "../../../core/src";
import {
  CHAT_API_VERSION,
  CHAT_SCHEMA_VERSION,
  PROVIDER_CONFIGURATION_API_VERSION,
  PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  STANDARD_SCHEMAS,
  StandardContractValidator,
  type ChatRequest,
  type ChatProvider,
  type EmbeddingProvider,
  type CredentialStore,
  type ProviderConfiguration,
  type ProviderConnectionTestResult
} from "../../../contracts/src";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  OpenAICompatibleChatProvider,
  OpenAICompatibleProviderError,
  type HttpClient,
  validateOpenAICompatibleProviderConfig
} from "../../../providers/chat/openai-compatible/src";
import {ProviderCredentialRouter} from "../../../core/src/provider-router";

const validator=new StandardContractValidator();
import {
  OpenAICompatibleEmbeddingProvider,
  type EmbeddingHttpClient,
  validateOpenAICompatibleEmbeddingProviderConfig
} from "../../../providers/embeddings/openai-compatible/src";


export function validateProviderConfiguration(configuration:ProviderConfiguration):{valid:boolean;errors:readonly string[]}{
  const schemaResult=validator.validate(configuration,STANDARD_SCHEMAS["provider-configuration"]!);
  if(!schemaResult.valid)return {valid:false,errors:[...schemaResult.errors]};
  const errors:string[]=[];
  if(configuration.providerId!==OPENAI_COMPATIBLE_PROVIDER_ID)errors.push("Unsupported chat provider: "+configuration.providerId);
  if(configuration.baseUrl!==configuration.baseUrl.trim())errors.push("Provider base URL must not have surrounding whitespace.");
  if(configuration.model!==configuration.model.trim()||configuration.model.length===0)errors.push("Provider model must be a non-empty trimmed string.");
  const credentialReferences=[...(configuration.credentials??[]).map(item=>item.credentialReference),...(configuration.credentialReference?[configuration.credentialReference]:[])];
  for(const ref of credentialReferences){
    if(ref.kind!=="api-key")errors.push("Provider credential reference kind must be api-key.");
    if(ref.provider!==undefined&&ref.provider!==OPENAI_COMPATIBLE_PROVIDER_ID)errors.push("Provider credential reference provider does not match providerId.");
  }

  if(configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID){
    const providerErrors=validateOpenAICompatibleProviderConfig({
      baseUrl:configuration.baseUrl,
      model:configuration.model,
      credential:credentialReferences[0]??null,
      timeoutMs:configuration.timeoutMs
    });
    for(const error of providerErrors)if(!errors.includes(error))errors.push(error);
  }
  return {valid:errors.length===0,errors};
}

const result=(status:ProviderConnectionTestResult["status"],providerId:string,message:string):ProviderConnectionTestResult=>({
  apiVersion:PROVIDER_CONFIGURATION_API_VERSION,
  schemaVersion:PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  status,
  providerId,
  message
});

function classify(error:unknown,providerId:string):ProviderConnectionTestResult{
  const chatError=error instanceof OpenAICompatibleProviderError
    ? error.chatError
    : error instanceof AiRuntimeError
      ? error.chatError
      : undefined;
  if(chatError){
    const category=chatError.details?.category;
    if(category==="authentication")return result("authentication_failed",providerId,"Provider authentication was rejected.");
    if(category==="timeout")return result("timeout",providerId,"Provider connection timed out.");
    if(category==="network")return result("network_error",providerId,"Provider network request failed.");
    if(category==="configuration"||category==="credential")return result("configuration_error",providerId,"Provider configuration or credential is unavailable.");
    return result("provider_error",providerId,"Provider returned an error.");
  }
  return result("provider_error",providerId,"Provider connection test failed.");
}

export async function testProviderConfiguration(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient):Promise<ProviderConnectionTestResult>{
  const validation=validateProviderConfiguration(configuration);
  if(!validation.valid)return result("configuration_error",configuration.providerId,"Provider configuration is invalid.");
  if(!configuration.enabled)return result("configuration_error",configuration.providerId,"Real chat provider is disabled.");
  if(configuration.providerId!==OPENAI_COMPATIBLE_PROVIDER_ID)return result("configuration_error",configuration.providerId,"Configured provider is not supported.");
  const provider=new OpenAICompatibleChatProvider({
    baseUrl:configuration.baseUrl,model:configuration.model,credential:configuration.credentialReference,timeoutMs:configuration.timeoutMs,structuredOutput:configuration.structuredOutput
  },credentialStore,httpClient);
  const providers=new ProviderRegistry();
  providers.register(provider,["chat"]);
  const aiRuntime=new AiRuntime(providers,{validator,diagnostics:new InMemoryDiagnosticsStore()});
  const request:ChatRequest={
    apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:"provider-config-test",
    providerId:OPENAI_COMPATIBLE_PROVIDER_ID,model:configuration.model,
    context:{conversationId:"provider-config-test",messages:[{role:"user",content:"Connection test. Reply with OK."}]}
  };
  try{await aiRuntime.generate(request);return result("connected",configuration.providerId,"Provider connection succeeded.");}
  catch(error){return classify(error,configuration.providerId);}
}

function validateProviderPresetConfiguration(configuration:ProviderConfiguration):{valid:boolean;errors:readonly string[]}{
  const errors:string[]=[];
  const schemaResult=validator.validate(configuration,STANDARD_SCHEMAS["provider-configuration"]!);
  if(!schemaResult.valid)errors.push(...schemaResult.errors);
  if(configuration.providerId!==OPENAI_COMPATIBLE_PROVIDER_ID)errors.push("Unsupported chat provider: "+configuration.providerId);
  if(configuration.baseUrl!==configuration.baseUrl.trim())errors.push("Provider base URL must not have surrounding whitespace.");
  if(configuration.model!==configuration.model.trim()||configuration.model.length===0)errors.push("Provider model must be a non-empty trimmed string.");
  const providerErrors=validateOpenAICompatibleProviderConfig({
    baseUrl:configuration.baseUrl,model:configuration.model,credential:(configuration.credentials?.[0]?.credentialReference??configuration.credentialReference),timeoutMs:configuration.timeoutMs
  });
  for(const error of providerErrors)if(!errors.includes(error)&&!error.includes("credential"))errors.push(error);
  return {valid:errors.length===0,errors};
}

export function buildEmbeddingProviderForPreset(
  configuration:ProviderConfiguration,
  model:string,
  credentialStore:CredentialStore,
  httpClient?:EmbeddingHttpClient
):EmbeddingProvider|undefined{
  if(configuration.providerId!==OPENAI_COMPATIBLE_PROVIDER_ID)return undefined;
  const effective={baseUrl:configuration.baseUrl,model:model.trim(),credential:configuration.credentialReference,timeoutMs:configuration.timeoutMs};
  if(validateOpenAICompatibleEmbeddingProviderConfig(effective).length>0)return undefined;
  return new OpenAICompatibleEmbeddingProvider(effective,credentialStore,httpClient);
}

export function buildProviderForPreset(
  configuration:ProviderConfiguration,
  credentialStore:CredentialStore,
  httpClient?:HttpClient,
  diagnostics?:InMemoryDiagnosticsStore,
  providerPresetId?:string
):ChatProvider|undefined{
  const validation=validateProviderPresetConfiguration(configuration);
  if(!validation.valid)return undefined;
  const credentials=[...(configuration.credentials??[]),...(configuration.credentials?.length?[]:(configuration.credentialReference?[{id:"legacy",label:"Legacy credential",credentialReference:configuration.credentialReference,health:"healthy" as const,failureCount:0}]:[]))];
  if(credentials.length>0){
    return new ProviderCredentialRouter({
      presetId:providerPresetId??"provider-preset",
      credentials,
      diagnostics,
      createProvider:credential=>new OpenAICompatibleChatProvider({
        baseUrl:configuration.baseUrl,model:configuration.model,credential:credential.credentialReference,timeoutMs:configuration.timeoutMs,
        ...(diagnostics?{diagnostics}:{}),
        ...(providerPresetId?{providerPresetId}:{})
      },credentialStore,httpClient)
    });
  }
  return new OpenAICompatibleChatProvider({
    baseUrl:configuration.baseUrl,model:configuration.model,credential:null,timeoutMs:configuration.timeoutMs,
    ...(diagnostics?{diagnostics}:{}),
    ...(providerPresetId?{providerPresetId}:{})
  },credentialStore,httpClient);
}

export async function testProviderPresetConfiguration(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient):Promise<ProviderConnectionTestResult>{
  const validation=validateProviderPresetConfiguration(configuration);
  if(!validation.valid)return result("configuration_error",configuration.providerId,validation.errors.join(" "));
  if(!configuration.enabled)return result("configuration_error",configuration.providerId,"Provider preset is not active.");
  const provider=buildProviderForPreset(configuration,credentialStore,httpClient);
  if(!provider)return result("configuration_error",configuration.providerId,"Provider preset configuration is invalid.");
  const providers=new ProviderRegistry();
  providers.register(provider,["chat"]);
  const aiRuntime=new AiRuntime(providers,{validator,diagnostics:new InMemoryDiagnosticsStore()});
  const request:ChatRequest={apiVersion:"1",schemaVersion:"1",requestId:"provider-preset-test",providerId:OPENAI_COMPATIBLE_PROVIDER_ID,model:configuration.model,context:{conversationId:"provider-preset-test",messages:[{role:"user",content:"Connection test. Reply with OK."}]}};
  try{await aiRuntime.generate(request);return result("connected",configuration.providerId,"Provider connection succeeded.");}
  catch(error){return classify(error,configuration.providerId);}
}

export function buildProviderForDiscovery(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient):ChatProvider|undefined{
  if(configuration.providerId!==OPENAI_COMPATIBLE_PROVIDER_ID)return undefined;
  const credentials=[...(configuration.credentials??[]),...(configuration.credentials?.length?[]:(configuration.credentialReference?[{id:"legacy",label:"Legacy credential",credentialReference:configuration.credentialReference,health:"healthy" as const,failureCount:0}]:[]))];
  if(validateOpenAICompatibleProviderConfig({
    baseUrl:configuration.baseUrl,
    model:configuration.model,
    credential:credentials[0]?.credentialReference??null,
    timeoutMs:configuration.timeoutMs,
    structuredOutput:configuration.structuredOutput
  },{allowEmptyModel:true}).length>0)return undefined;
  if(credentials.length>0){
    return new ProviderCredentialRouter({
      presetId:"provider-discovery",
      credentials,
      createProvider:credential=>new OpenAICompatibleChatProvider({
        baseUrl:configuration.baseUrl,
        model:configuration.model,
        credential:credential.credentialReference,
        timeoutMs:configuration.timeoutMs
      },credentialStore,httpClient)
    });
  }
  return new OpenAICompatibleChatProvider({
    baseUrl:configuration.baseUrl,
    model:configuration.model,
    credential:null,
    timeoutMs:configuration.timeoutMs
  },credentialStore,httpClient);
}

export async function testProviderConfigurationForPreset(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient):Promise<ProviderConnectionTestResult>{
  const validation=validateProviderConfiguration(configuration);
  if(!validation.valid)return result("configuration_error",configuration.providerId,"Provider preset configuration is invalid.");
  if(!configuration.enabled)return result("configuration_error",configuration.providerId,"Provider preset is not active.");
  return testProviderConfiguration(configuration,credentialStore,httpClient);
}

export async function listProviderModels(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient){
  const provider=buildProviderForDiscovery(configuration,credentialStore,httpClient);
  return provider?provider.listModels():[];
}

export function buildConfiguredProvider(
  configuration:ProviderConfiguration|undefined,
  credentialStore:CredentialStore,
  httpClient?:HttpClient,
  diagnostics?:InMemoryDiagnosticsStore,
  providerPresetId?:string
):ChatProvider|undefined{
  if(!configuration||!configuration.enabled)return undefined;
  const validation=validateProviderConfiguration(configuration);
  if(!validation.valid)return undefined;
  if(configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID){
    const credentials=[...(configuration.credentials??[]),...(configuration.credentials?.length?[]:(configuration.credentialReference?[{id:"legacy",label:"Legacy credential",credentialReference:configuration.credentialReference,health:"healthy" as const,failureCount:0}]:[]))];
    if(credentials.length>0){
      return new ProviderCredentialRouter({
        presetId:providerPresetId??"active-provider",
        credentials,
        diagnostics,
        createProvider:credential=>new OpenAICompatibleChatProvider({
          baseUrl:configuration.baseUrl,model:configuration.model,credential:credential.credentialReference,timeoutMs:configuration.timeoutMs,
          ...(diagnostics?{diagnostics}:{}),
          ...(providerPresetId?{providerPresetId}:{})
        },credentialStore,httpClient)
      });
    }
    return new OpenAICompatibleChatProvider({
      baseUrl:configuration.baseUrl,model:configuration.model,credential:null,timeoutMs:configuration.timeoutMs,
      ...(diagnostics?{diagnostics}:{}),
      ...(providerPresetId?{providerPresetId}:{})
    },credentialStore,httpClient);
  }
  return undefined;
}

export function activeProviderId(configuration:ProviderConfiguration|undefined):string{
  if(configuration?.enabled&&validateProviderConfiguration(configuration).valid&&configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID)return OPENAI_COMPATIBLE_PROVIDER_ID;
  return "fake.chat";
}
