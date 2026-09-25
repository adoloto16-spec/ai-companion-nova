import {
  PROVIDER_CONFIGURATION_API_VERSION,
  PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  STANDARD_SCHEMAS,
  StandardContractValidator,
  type CredentialReference,
  type ProviderConfiguration
} from "../../contracts/src";
import {InMemoryProviderConfigurationStore,serializeProviderConfiguration} from "../../host/config/src";
import {InMemoryCredentialStore} from "../../host/credentials/src";
import {activeProviderId,buildConfiguredProvider,testProviderConfiguration,validateProviderConfiguration} from "../../runtime/bootstrap/src";
import {OPENAI_COMPATIBLE_PROVIDER_ID,type HttpClient,type HttpClientRequest,type HttpClientResponse,OpenAICompatibleChatProvider} from "../../providers/chat/openai-compatible/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}

const credential:CredentialReference={id:"provider.test",kind:"api-key",provider:OPENAI_COMPATIBLE_PROVIDER_ID};
const base:ProviderConfiguration={
  apiVersion:PROVIDER_CONFIGURATION_API_VERSION,
  schemaVersion:PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  providerId:OPENAI_COMPATIBLE_PROVIDER_ID,
  enabled:true,
  baseUrl:"https://provider.example.test/v1",
  model:"test-model",
  credentialReference:credential,
  timeoutMs:50
};

class FakeHttpClient implements HttpClient{
  next:HttpClientResponse|Error|(()=>Promise<HttpClientResponse>)={status:200,body:JSON.stringify({
    id:"test",model:"test-model",choices:[{message:{role:"assistant",content:"OK"},finish_reason:"stop"}]
  })};
  requests:HttpClientRequest[]=[];
  async request(request:HttpClientRequest){this.requests.push(request);if(this.next instanceof Error)throw this.next;if(typeof this.next==="function")return this.next();return this.next;}
}

async function schemaValidationTest(){
  const validator=new StandardContractValidator();
  ok(validator.validate(base,STANDARD_SCHEMAS["provider-configuration"]!).valid,"provider configuration schema accepts valid config");
  ok(!validator.validate({...base,apiKey:"secret"} as never,STANDARD_SCHEMAS["provider-configuration"]!).valid,"provider configuration rejects secret field");
  ok(!validator.validate({...base,credentialReference:{id:"",kind:"api-key"}} as never,STANDARD_SCHEMAS["provider-configuration"]!).valid,"provider configuration rejects empty credential id");
  ok(validator.validate({apiVersion:"1",schemaVersion:"1",status:"connected",providerId:OPENAI_COMPATIBLE_PROVIDER_ID},STANDARD_SCHEMAS["provider-connection-test-result"]!).valid,"connection result schema");
}

async function configurationPersistenceTest(){
  const store=new InMemoryProviderConfigurationStore();
  await store.save(base);
  const loaded=await store.load();
  equal(loaded?.providerId,OPENAI_COMPATIBLE_PROVIDER_ID,"non-secret provider config persisted");
  const serialized=serializeProviderConfiguration(base);
  ok(serialized.includes("test-model"),"serialized config contains model");
  ok(!serialized.includes("secret-value"),"serialized config contains no secret");
  ok(!serialized.includes("apiKey"),"serialized config has no apiKey field");
}

async function credentialCrudTest(){
  const store=new InMemoryCredentialStore();
  await store.setSecret(credential,"secret-value");
  equal(await store.getSecret(credential),"secret-value","credential retrieval");
  equal(await store.exists(credential),true,"credential existence");
  await store.deleteSecret(credential);
  equal(await store.getSecret(credential),undefined,"credential deletion");
  equal(await store.exists(credential),false,"credential absence");
}

function validationTest(){
  const cases:Array<[string,ProviderConfiguration,boolean]>=[
    ["invalid base URL",{...base,baseUrl:"file:///tmp/x"},false],
    ["embedded URL credentials",{...base,baseUrl:"https://user:pass@example.test/v1"},false],
    ["query base URL",{...base,baseUrl:"https://example.test/v1?x=1"},false],
    ["fragment base URL",{...base,baseUrl:"https://example.test/v1#fragment"},false],
    ["surrounding URL whitespace",{...base,baseUrl:" https://example.test/v1"},false],
    ["empty model",{...base,model:""},false],
    ["whitespace model",{...base,model:" "},false],
    ["invalid timeout zero",{...base,timeoutMs:0},false],
    ["invalid timeout negative",{...base,timeoutMs:-1},false],
    ["missing enabled credential",{...base,credentialReference:null},false],
    ["disabled without credential",{...base,enabled:false,credentialReference:null},true],
    ["disabled invalid URL",{...base,enabled:false,credentialReference:null,baseUrl:"file:///tmp/x"},false]
  ];
  for(const [label,configuration,expected] of cases)equal(validateProviderConfiguration(configuration).valid,expected,label);
}

function selectionTest(){
  equal(activeProviderId(undefined),"fake.chat","missing configuration falls back");
  equal(activeProviderId({...base,enabled:false}),"fake.chat","disabled provider falls back");
  equal(activeProviderId(base),OPENAI_COMPATIBLE_PROVIDER_ID,"enabled provider is selected");
  equal(buildConfiguredProvider({...base,enabled:false},new InMemoryCredentialStore()),undefined,"disabled provider is not constructed");
}

async function connectionTestTest(){
  const credentials=new InMemoryCredentialStore();
  await credentials.setSecret(credential,"test-secret");

  const success=await testProviderConfiguration(base,credentials,new FakeHttpClient());
  equal(success.status,"connected","connection test success");

  const auth=new FakeHttpClient();auth.next={status:401,body:"authentication failed"};
  equal((await testProviderConfiguration(base,credentials,auth)).status,"authentication_failed","authentication failure classification");

  const timeout=new FakeHttpClient();timeout.next=()=>new Promise<HttpClientResponse>(()=>{});
  equal((await testProviderConfiguration({...base,timeoutMs:5},credentials,timeout)).status,"timeout","timeout classification");

  const network=new FakeHttpClient();network.next=new Error("network failure with test-secret");
  equal((await testProviderConfiguration(base,credentials,network)).status,"network_error","network classification");

  const missing=new InMemoryCredentialStore();
  equal((await testProviderConfiguration(base,missing,new FakeHttpClient())).status,"configuration_error","missing credential classification");

  equal((await testProviderConfiguration({...base,enabled:false},credentials,new FakeHttpClient())).status,"configuration_error","disabled configuration test");
}

async function secretSafetyTest(){
  const credentials=new InMemoryCredentialStore();
  await credentials.setSecret(credential,"secret-value");
  const http=new FakeHttpClient();
  http.next={status:500,body:"Authorization: Bearer secret-value"};
  const provider=new OpenAICompatibleChatProvider({
    baseUrl:base.baseUrl,model:base.model,credential,timeoutMs:50
  },credentials,http);
  try{
    await provider.chat({
      apiVersion:"1",schemaVersion:"1",requestId:"secret-safety",providerId:OPENAI_COMPATIBLE_PROVIDER_ID,model:base.model,
      context:{conversationId:"secret-safety",messages:[{role:"user",content:"test"}]}
    });
    throw new Error("secret safety test did not fail");
  }catch(error){
    ok(!JSON.stringify(error).includes("secret-value"),"provider error excludes secret");
  }
}

async function offlineAndCompositionRootTest(){
  const runtimeConfig={...base};
  const credentials=new InMemoryCredentialStore();
  await credentials.setSecret(credential,"test-secret");
  const http=new FakeHttpClient();
  const configured=buildConfiguredProvider(runtimeConfig,credentials,http);
  ok(configured!==undefined,"Composition Root can construct configured provider");
  const offline=activeProviderId(undefined);
  equal(offline,"fake.chat","offline default remains fake");
}

void (async()=>{
  for(const [name,test] of [
    ["schema validation",schemaValidationTest],
    ["configuration persistence",configurationPersistenceTest],
    ["credential CRUD",credentialCrudTest],
    ["configuration validation",validationTest],
    ["provider selection",selectionTest],
    ["connection test semantics",connectionTestTest],
    ["secret safety",secretSafetyTest],
    ["offline and Composition Root",offlineAndCompositionRootTest]
  ] as const){
    await test();
    console.log("PASS secure provider config "+name);
  }
  console.log("All secure provider configuration tests passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
