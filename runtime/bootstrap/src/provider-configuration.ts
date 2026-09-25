import {
  AiRuntime,
  AiRuntimeError,
  InMemoryDiagnosticsStore,
  ProviderRegistry
} from "../../core/src";
import {
  CHAT_API_VERSION,
  CHAT_SCHEMA_VERSION,
  PROVIDER_CONFIGURATION_API_VERSION,
  PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  STANDARD_SCHEMAS,
  StandardContractValidator,
  type ChatRequest,
  type ChatProvider,
  type CredentialStore,
  type ProviderConfiguration,
  type ProviderConnectionTestResult
} from "../../contracts/src";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  OpenAICompatibleChatProvider,
  OpenAICompatibleProviderError,
  type HttpClient,
  validateOpenAICompatibleProviderConfig
} from "../../providers/chat/openai-compatible/src";

const validator=new StandardContractValidator();

export function validateProviderConfiguration(configuration:ProviderConfiguration):{valid:boolean;errors:readonly string[]}{
  const schemaResult=validator.validate(configuration,STANDARD_SCHEMAS["provider-configuration"]!);
  if(!schemaResult.valid)return {valid:false,errors:[...schemaResult.errors]};
  const errors:string[]=[];
  if(configuration.providerId!==OPENAI_COMPATIBLE_PROVIDER_ID)errors.push("Unsupported chat provider: "+configuration.providerId);
  if(configuration.baseUrl!==configuration.baseUrl.trim())errors.push("Provider base URL must not have surrounding whitespace.");
  if(configuration.model!==configuration.model.trim()||configuration.model.length===0)errors.push("Provider model must be a non-empty trimmed string.");
  if(configuration.credentialReference!==null){
    const ref=configuration.credentialReference;
    if(ref.kind!=="api-key")errors.push("Provider credential reference kind must be api-key.");
    if(ref.provider!==undefined&&ref.provider!==OPENAI_COMPATIBLE_PROVIDER_ID)errors.push("Provider credential reference provider does not match providerId.");
  }
  if(configuration.enabled&&configuration.credentialReference===null)errors.push("An enabled real provider requires a credential reference.");
  if(configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID){
    const providerErrors=validateOpenAICompatibleProviderConfig({
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
  if(configuration.providerId!==OPENAI_COMPATIBLE_PROVIDER_ID||!configuration.credentialReference)return result("configuration_error",configuration.providerId,"Configured provider is not supported or has no credential reference.");
  const provider=new OpenAICompatibleChatProvider({
    baseUrl:configuration.baseUrl,model:configuration.model,credential:configuration.credentialReference,timeoutMs:configuration.timeoutMs
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

export function buildConfiguredProvider(configuration:ProviderConfiguration|undefined,credentialStore:CredentialStore,httpClient?:HttpClient):ChatProvider|undefined{
  if(!configuration||!configuration.enabled)return undefined;
  const validation=validateProviderConfiguration(configuration);
  if(!validation.valid||!configuration.credentialReference)return undefined;
  if(configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID){
    return new OpenAICompatibleChatProvider({
      baseUrl:configuration.baseUrl,model:configuration.model,credential:configuration.credentialReference,timeoutMs:configuration.timeoutMs
    },credentialStore,httpClient);
  }
  return undefined;
}

export function activeProviderId(configuration:ProviderConfiguration|undefined):string{
  if(configuration?.enabled&&validateProviderConfiguration(configuration).valid&&configuration.providerId===OPENAI_COMPATIBLE_PROVIDER_ID)return OPENAI_COMPATIBLE_PROVIDER_ID;
  return "fake.chat";
}
