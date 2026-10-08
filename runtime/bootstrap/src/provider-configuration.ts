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
  type DiagnosticsStore,
  type EmbeddingProvider,
  type CredentialStore,
  type ProviderConfiguration,
  type ProviderConnectionTestResult,
  type ProviderPresetSource
} from "../../../contracts/src";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  OpenAICompatibleChatProvider,
  OpenAICompatibleProviderError,
  type HttpClient,
  validateOpenAICompatibleProviderConfig
} from "../../../providers/chat/openai-compatible/src";
import {
  GEMINI_PROVIDER_ID,
  GeminiChatProvider,
  GeminiProviderError,
  validateGeminiProviderConfig
} from "../../../providers/chat/gemini/src";
import {
  OpenAICompatibleEmbeddingProvider,
  type EmbeddingHttpClient,
  validateOpenAICompatibleEmbeddingProviderConfig
} from "../../../providers/embeddings/openai-compatible/src";

const validator=new StandardContractValidator();

function isSupportedChatProvider(providerId:string):boolean{
  return providerId===OPENAI_COMPATIBLE_PROVIDER_ID||providerId===GEMINI_PROVIDER_ID;
}

function providerCredentialError(configuration:ProviderConfiguration):string|undefined{
  const reference=configuration.credentialReference;
  if(reference===null)return undefined;
  if(reference.kind!=="api-key")return "Provider credential reference kind must be api-key.";
  if(reference.provider!==undefined&&reference.provider!==configuration.providerId){
    return "Provider credential reference provider does not match providerId.";
  }
  return undefined;
}

export function validateProviderConfiguration(configuration:ProviderConfiguration):{valid:boolean;errors:readonly string[]}{
  const schemaResult=validator.validate(configuration,STANDARD_SCHEMAS["provider-configuration"]!);
  if(!schemaResult.valid)return {valid:false,errors:[...schemaResult.errors]};
  const errors:string[]=[];
  if(!isSupportedChatProvider(configuration.providerId))errors.push("Unsupported chat provider: "+configuration.providerId);
  if(configuration.baseUrl!==configuration.baseUrl.trim())errors.push("Provider base URL must not have surrounding whitespace.");
  if(configuration.model!==configuration.model.trim()||configuration.model.length===0)errors.push("Provider model must be a non-empty trimmed string.");
  const credentialError=providerCredentialError(configuration);
  if(credentialError)errors.push(credentialError);
  if(configuration.enabled&&configuration.credentialReference===null)errors.push("An enabled real provider requires a credential reference.");
  if(configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID){
    const providerErrors=validateOpenAICompatibleProviderConfig({
      baseUrl:configuration.baseUrl,
      model:configuration.model,
      credential:configuration.credentialReference,
      timeoutMs:configuration.timeoutMs
    });
    for(const error of providerErrors)if(!errors.includes(error))errors.push(error);
  }else if(configuration.providerId===GEMINI_PROVIDER_ID){
    const providerErrors=validateGeminiProviderConfig({
      baseUrl:configuration.baseUrl,
      model:configuration.model,
      credential:configuration.credentialReference,
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

function readChatError(error:unknown):{code?:string;details?:Record<string,unknown>}|undefined{
  if(error&&typeof error==="object"&&"chatError" in error){
    const chatError=(error as {chatError?:unknown}).chatError;
    if(chatError&&typeof chatError==="object")return chatError as {code?:string;details?:Record<string,unknown>};
  }
  return undefined;
}

function classify(error:unknown,providerId:string):ProviderConnectionTestResult{
  const chatError=readChatError(error);
  const category=chatError?.details?.category;
  if(category==="authentication")return result("authentication_failed",providerId,"Provider authentication was rejected.");
  if(category==="timeout")return result("timeout",providerId,"Provider connection timed out.");
  if(category==="network"||category==="transport")return result("network_error",providerId,"Provider network request failed.");
  if(category==="configuration"||category==="credential")return result("configuration_error",providerId,"Provider configuration or credential is unavailable.");
  return result("provider_error",providerId,"Provider returned an error.");
}

export async function testProviderConfiguration(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient):Promise<ProviderConnectionTestResult>{
  const validation=validateProviderConfiguration(configuration);
  if(!validation.valid)return result("configuration_error",configuration.providerId,"Provider configuration is invalid.");
  if(!configuration.enabled)return result("configuration_error",configuration.providerId,"Real chat provider is disabled.");
  const provider=buildProviderForPreset(configuration,credentialStore,httpClient);
  if(!provider)return result("configuration_error",configuration.providerId,"Configured provider is not supported.");
  const providers=new ProviderRegistry();
  providers.register(provider,["chat"]);
  const aiRuntime=new AiRuntime(providers,{validator,diagnostics:new InMemoryDiagnosticsStore()});
  const request:ChatRequest={
    apiVersion:CHAT_API_VERSION,schemaVersion:CHAT_SCHEMA_VERSION,requestId:"provider-config-test",
    providerId:configuration.providerId,model:configuration.model,
    context:{conversationId:"provider-config-test",messages:[{role:"user",content:"Connection test. Reply with OK."}]}
  };
  try{
    await aiRuntime.generate(request);
    return result("connected",configuration.providerId,"Provider connection succeeded.");
  }catch(error){
    return classify(error,configuration.providerId);
  }
}

function validateProviderPresetConfiguration(configuration:ProviderConfiguration):{valid:boolean;errors:readonly string[]}{
  return validateProviderConfiguration(configuration);
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

export function buildChatProviderForSource(
  source:ProviderPresetSource,
  credentialStore:CredentialStore,
  httpClient?:HttpClient,
  diagnostics?:DiagnosticsStore,
  providerPresetId?:string
):ChatProvider|undefined{
  const configuration:ProviderConfiguration={
    apiVersion:"1",
    schemaVersion:"1",
    providerId:source.providerId,
    enabled:source.enabled&&source.model.trim().length>0,
    baseUrl:source.baseUrl,
    model:source.model,
    credentialReference:source.credentialReference?{...source.credentialReference}:null,
    ...(source.timeoutMs===undefined?{}:{timeoutMs:source.timeoutMs})
  };
  if(!isSupportedChatProvider(configuration.providerId))return undefined;
  const validation=validateProviderPresetConfiguration(configuration);
  if(!validation.valid)return undefined;
  if(configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID){
    return new OpenAICompatibleChatProvider({
      baseUrl:configuration.baseUrl,
      model:configuration.model,
      credential:configuration.credentialReference,
      timeoutMs:configuration.timeoutMs,
      ...(diagnostics?{diagnostics}:{}),
      ...(providerPresetId?{providerPresetId}:{})
    },credentialStore,httpClient);
  }
  return new GeminiChatProvider({
    baseUrl:configuration.baseUrl,
    model:configuration.model,
    credential:configuration.credentialReference,
    timeoutMs:configuration.timeoutMs,
    ...(diagnostics?{diagnostics}:{}),
    ...(providerPresetId?{providerPresetId}:{})
  },credentialStore,httpClient);
}

export function buildProviderForPreset(
  configuration:ProviderConfiguration,
  credentialStore:CredentialStore,
  httpClient?:HttpClient,
  diagnostics?:DiagnosticsStore,
  providerPresetId?:string
):ChatProvider|undefined{
  const validation=validateProviderPresetConfiguration(configuration);
  if(!validation.valid||!configuration.enabled)return undefined;
  if(configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID){
    return new OpenAICompatibleChatProvider({
      baseUrl:configuration.baseUrl,
      model:configuration.model,
      credential:configuration.credentialReference,
      timeoutMs:configuration.timeoutMs,
      ...(diagnostics?{diagnostics}:{}),
      ...(providerPresetId?{providerPresetId}:{})
    },credentialStore,httpClient);
  }
  if(configuration.providerId===GEMINI_PROVIDER_ID){
    return new GeminiChatProvider({
      baseUrl:configuration.baseUrl,
      model:configuration.model,
      credential:configuration.credentialReference,
      timeoutMs:configuration.timeoutMs,
      ...(diagnostics?{diagnostics}:{}),
      ...(providerPresetId?{providerPresetId}:{})
    },credentialStore,httpClient);
  }
  return undefined;
}

export async function testProviderPresetConfiguration(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient):Promise<ProviderConnectionTestResult>{
  const validation=validateProviderPresetConfiguration(configuration);
  if(!validation.valid)return result("configuration_error",configuration.providerId,validation.errors.join(" "));
  if(!configuration.enabled)return result("configuration_error",configuration.providerId,"Provider preset is not active.");
  return testProviderConfiguration(configuration,credentialStore,httpClient);
}

export function buildProviderForDiscovery(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient):ChatProvider|undefined{
  if(!isSupportedChatProvider(configuration.providerId))return undefined;
  const common={
    baseUrl:configuration.baseUrl,
    model:configuration.model,
    credential:configuration.credentialReference,
    timeoutMs:configuration.timeoutMs
  };
  if(configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID){
    if(validateOpenAICompatibleProviderConfig(common,{allowEmptyModel:true}).length>0)return undefined;
    return new OpenAICompatibleChatProvider(common,credentialStore,httpClient);
  }
  if(validateGeminiProviderConfig(common,{allowEmptyModel:true}).length>0)return undefined;
  return new GeminiChatProvider(common,credentialStore,httpClient);
}

export async function testProviderConfigurationForPreset(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient):Promise<ProviderConnectionTestResult>{
  return testProviderConfiguration(configuration,credentialStore,httpClient);
}

export async function listProviderModels(configuration:ProviderConfiguration,credentialStore:CredentialStore,httpClient?:HttpClient):Promise<import("../../../contracts/src/index").ModelInfo[]>{
  const provider=buildProviderForDiscovery(configuration,credentialStore,httpClient);
  return provider?provider.listModels():[];
}

export function buildConfiguredProvider(
  configuration:ProviderConfiguration|undefined,
  credentialStore:CredentialStore,
  httpClient?:HttpClient,
  diagnostics?:DiagnosticsStore,
  providerPresetId?:string
):ChatProvider|undefined{
  if(!configuration||!configuration.enabled)return undefined;
  return buildProviderForPreset(configuration,credentialStore,httpClient,diagnostics,providerPresetId);
}

export function activeProviderId(configuration:ProviderConfiguration|undefined):string{
  if(configuration?.enabled&&validateProviderConfiguration(configuration).valid){
    if(configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID||configuration.providerId===GEMINI_PROVIDER_ID)return configuration.providerId;
  }
  return "fake.chat";
}
