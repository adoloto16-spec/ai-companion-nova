import {
  OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,
  OpenAICompatibleEmbeddingProvider,
  OpenAICompatibleEmbeddingProviderError,
  type EmbeddingHttpClient,
  type EmbeddingHttpRequest,
  type EmbeddingHttpResponse
} from "../../providers/embeddings/openai-compatible/src";
import type {CredentialReference,CredentialStore} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}

const credentialReference:CredentialReference={id:"credential.embedding.test",kind:"api-key",provider:"openai-compatible"};

class FakeCredentialStore implements CredentialStore{
  value:string|undefined="embedding-test-secret";
  async getSecret(reference:CredentialReference){return reference.id===credentialReference.id?this.value:undefined;}
  async setSecret(_reference:CredentialReference,value:string){this.value=value;}
  async deleteSecret(_reference:CredentialReference){this.value=undefined;}
}

class FakeHttpClient implements EmbeddingHttpClient{
  requests:EmbeddingHttpRequest[]=[];
  next:EmbeddingHttpResponse|Error={status:200,body:JSON.stringify({data:[
    {index:0,embedding:[1,0,0]},
    {index:1,embedding:[0,1,0]}
  ]})};
  async request(request:EmbeddingHttpRequest):Promise<EmbeddingHttpResponse>{
    this.requests.push(request);
    if(this.next instanceof Error)throw this.next;
    return this.next;
  }
}

async function main(){
  const credentials=new FakeCredentialStore();
  const http=new FakeHttpClient();
  const provider=new OpenAICompatibleEmbeddingProvider({
    baseUrl:"https://api.example.test/v1",
    model:"mistral-embed",
    credential:credentialReference
  },credentials,http);
  equal(provider.id,OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID,"provider id is provider-neutral");
  equal(provider.capabilities().embeddings,true,"embedding capability");
  const vectors=await provider.embed(["User likes blue.","User lives in Nuremberg."]);
  equal(vectors,[[1,0,0],[0,1,0]],"vector mapping");
  equal(provider.dimensions(),3,"learned embedding dimension");
  equal(http.requests.length,1,"single batch request");
  equal(http.requests[0]!.url,"https://api.example.test/v1/embeddings","embeddings endpoint");
  equal(http.requests[0]!.headers.Authorization,"Bearer embedding-test-secret","authorization mapping");
  const requestBody=JSON.parse(http.requests[0]!.body);
  equal(requestBody.model,"mistral-embed","explicit embedding model mapping");
  equal(requestBody.input,["User likes blue.","User lives in Nuremberg."],"array input mapping");

  http.next={status:200,body:JSON.stringify({data:[{index:0,embedding:[NaN]}]})};
  let malformed=false;
  try{await provider.embed(["x"]);}catch(error){malformed=error instanceof OpenAICompatibleEmbeddingProviderError&&error.code==="INVALID_RESPONSE";}
  ok(malformed,"invalid embedding vector is rejected");

  http.next={status:429,body:"{"error":{"message":"rate limited"}}"};
  let rateLimited=false;
  try{await provider.embed(["x"]);}catch(error){rateLimited=error instanceof OpenAICompatibleEmbeddingProviderError&&error.code==="PROVIDER_ERROR";}
  ok(rateLimited,"rate limit is a provider failure");

  await credentials.deleteSecret(credentialReference);
  equal((await provider.health()).status,"unavailable","missing embedding credential is unavailable");
  console.log("PASS OpenAI-compatible embedding provider unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
