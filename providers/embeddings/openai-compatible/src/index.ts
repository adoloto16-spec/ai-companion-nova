import type {
  CredentialReference,CredentialStore,EmbeddingProvider,HealthStatus,ProviderCapabilities
} from "../../../../contracts/src/index";

export interface EmbeddingHttpRequest{
  url:string;
  method:"POST";
  headers:Record<string,string>;
  body:string;
}
export interface EmbeddingHttpResponse{status:number;body:string;}
export interface EmbeddingHttpClient{
  request(request:EmbeddingHttpRequest):Promise<EmbeddingHttpResponse>;
}

export interface OpenAICompatibleEmbeddingProviderConfig{
  baseUrl:string;
  model:string;
  credential:CredentialReference|null;
  timeoutMs?:number;
}

export const OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID="openai-compatible.embeddings";
const DEFAULT_TIMEOUT_MS=30000;

export function validateOpenAICompatibleEmbeddingProviderConfig(
  config:OpenAICompatibleEmbeddingProviderConfig,
  options:{allowEmptyModel?:boolean}={}
):string[]{
  const errors:string[]=[];
  if(config.baseUrl!==config.baseUrl.trim()||!config.baseUrl.trim())errors.push("Embedding provider base URL must be a non-empty trimmed string.");
  if(!options.allowEmptyModel&&(config.model!==config.model.trim()||!config.model.trim()))errors.push("Embedding model must be a non-empty trimmed string.");
  if(config.model.length>200)errors.push("Embedding model is too long.");
  if(config.credential!==null&&config.credential.kind!=="api-key")errors.push("Embedding provider credential reference kind must be api-key.");
  if(config.timeoutMs!==undefined&&(!Number.isFinite(config.timeoutMs)||config.timeoutMs<1||config.timeoutMs>120000))errors.push("Embedding provider timeout must be between 1 and 120000 ms.");
  return errors;
}

export class OpenAICompatibleEmbeddingProviderError extends Error{
  readonly code:"INVALID_REQUEST"|"PROVIDER_UNAVAILABLE"|"PROVIDER_ERROR"|"INVALID_RESPONSE";
  readonly category:string;
  constructor(input:{code:OpenAICompatibleEmbeddingProviderError["code"];message:string;category:string}){
    super(input.message);
    this.name="OpenAICompatibleEmbeddingProviderError";
    this.code=input.code;
    this.category=input.category;
  }
}

function redact(value:string):string{
  return value
    .replace(/authorization\s*:\s*bearer\s+\S+/gi,"Authorization: Bearer [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._-]{16,}\b/gi,"Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gi,"[REDACTED]");
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider{
  readonly id=OPENAI_COMPATIBLE_EMBEDDING_PROVIDER_ID;
  private lastDimensions=0;
  constructor(
    private readonly config:OpenAICompatibleEmbeddingProviderConfig,
    private readonly credentialStore:CredentialStore,
    private readonly httpClient:EmbeddingHttpClient=defaultHttpClient()
  ){}

  capabilities():ProviderCapabilities{return {embeddings:true};}
  dimensions():number{return this.lastDimensions;}

  async embed(texts:string[]):Promise<number[][]>{
    const validation=validateOpenAICompatibleEmbeddingProviderConfig(this.config);
    if(validation.length>0)throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_REQUEST",message:validation.join(" "),category:"configuration"});
    if(texts.length===0)return [];
    if(texts.length>128)throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_REQUEST",message:"Embedding batch exceeds the 128-input limit.",category:"input"});
    if(texts.some(text=>typeof text!=="string"))throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_REQUEST",message:"Embedding input texts must be strings.",category:"input"});
    const secret=await this.resolveCredential();
    const payload=JSON.stringify({model:this.config.model,input:[...texts]});
    let response:EmbeddingHttpResponse;
    try{
      response=await this.requestWithTimeout({
        url:this.embeddingsUrl(),
        method:"POST",
        headers:{Accept:"application/json","Content-Type":"application/json",...(secret?{Authorization:"Bearer "+secret}:{})},
        body:payload
      });
    }catch(error){
      if(error instanceof OpenAICompatibleEmbeddingProviderError)throw error;
      throw new OpenAICompatibleEmbeddingProviderError({code:"PROVIDER_UNAVAILABLE",message:"OpenAI-compatible embedding provider request failed.",category:"network"});
    }
    if(response.status<200||response.status>=300){
      const message=redact(response.body||"");
      const category=response.status===401||response.status===403?"authentication":response.status===429?"rate_limit":response.status>=500?"server":"provider";
      throw new OpenAICompatibleEmbeddingProviderError({
        code:response.status===400||response.status===422?"INVALID_REQUEST":"PROVIDER_ERROR",
        message:"OpenAI-compatible embedding provider returned HTTP "+response.status+"."+((category==="authentication"||category==="rate_limit")?"":" "+message.slice(0,500)),
        category
      });
    }
    let payloadValue:unknown;
    try{payloadValue=JSON.parse(response.body);}catch{
      throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_RESPONSE",message:"Embedding provider returned malformed JSON.",category:"malformed_response"});
    }
    if(!payloadValue||typeof payloadValue!=="object"||Array.isArray(payloadValue)){
      throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_RESPONSE",message:"Embedding provider returned an invalid response object.",category:"malformed_response"});
    }
    const data=(payloadValue as Record<string,unknown>).data;
    if(!Array.isArray(data)||data.length!==texts.length){
      throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_RESPONSE",message:"Embedding provider returned a vector count different from the input count.",category:"malformed_response"});
    }
    const indexed=data.map((entry,index)=>{
      const item=entry&&typeof entry==="object"&&!Array.isArray(entry)?entry as Record<string,unknown>:undefined;
      const order=item&&typeof item.index==="number"&&Number.isInteger(item.index)?item.index:index;
      return {order,vector:this.parseVector(entry,index)};
    }).sort((a,b)=>a.order-b.order);
    if(indexed.some((entry,index)=>entry.order!==index)){
      throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_RESPONSE",message:"Embedding provider returned invalid vector indexes.",category:"malformed_response"});
    }
    const vectors=indexed.map(entry=>entry.vector);
    const dimensions=vectors[0]?.length??0;
    if(dimensions===0||vectors.some(vector=>vector.length!==dimensions)){
      throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_RESPONSE",message:"Embedding provider returned inconsistent vector dimensions.",category:"malformed_response"});
    }
    this.lastDimensions=dimensions;
    return vectors;
  }

  async health():Promise<HealthStatus>{
    const validation=validateOpenAICompatibleEmbeddingProviderConfig(this.config,{allowEmptyModel:true});
    if(validation.length>0)return {status:"unavailable",message:validation.join(" "),capabilities:["embeddings"]};
    if(this.config.model.trim().length===0)return {status:"unavailable",message:"Embedding model is not configured.",capabilities:["embeddings"]};
    try{
      const secret=await this.resolveCredential();
      if(!secret)return {status:"unavailable",message:"Embedding provider credential is not configured.",capabilities:["embeddings"]};
      return {status:"healthy",capabilities:["embeddings"]};
    }catch{
      return {status:"unavailable",message:"Embedding provider credential is unavailable.",capabilities:["embeddings"]};
    }
  }

  private parseVector(entry:unknown,index:number):number[]{
    if(!entry||typeof entry!=="object"||Array.isArray(entry))throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_RESPONSE",message:"Embedding item "+index+" is invalid.",category:"malformed_response"});
    const embedding=(entry as Record<string,unknown>).embedding;
    if(!Array.isArray(embedding)||embedding.length===0||embedding.some(value=>typeof value!=="number"||!Number.isFinite(value))){
      throw new OpenAICompatibleEmbeddingProviderError({code:"INVALID_RESPONSE",message:"Embedding item "+index+" contains an invalid vector.",category:"malformed_response"});
    }
    return embedding as number[];
  }

  private embeddingsUrl():string{
    return this.config.baseUrl.replace(/\/+$/,"")+"/embeddings";
  }

  private async resolveCredential():Promise<string|undefined>{
    if(!this.config.credential)return undefined;
    try{
      const value=await this.credentialStore.getSecret(this.config.credential);
      if(!value)throw new OpenAICompatibleEmbeddingProviderError({code:"PROVIDER_UNAVAILABLE",message:"Embedding provider credential is not configured.",category:"credential"});
      return value;
    }catch(error){
      if(error instanceof OpenAICompatibleEmbeddingProviderError)throw error;
      throw new OpenAICompatibleEmbeddingProviderError({code:"PROVIDER_UNAVAILABLE",message:"Embedding provider credential is unavailable.",category:"credential"});
    }
  }

  private async requestWithTimeout(request:EmbeddingHttpRequest):Promise<EmbeddingHttpResponse>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeoutMs=this.config.timeoutMs??DEFAULT_TIMEOUT_MS;
    try{
      return await Promise.race([
        this.httpClient.request({...request,signal:controller.signal} as EmbeddingHttpRequest & {signal?:AbortSignal}),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new OpenAICompatibleEmbeddingProviderError({code:"PROVIDER_UNAVAILABLE",message:"Embedding provider request timed out.",category:"timeout"}));},timeoutMs);})
      ]);
    }finally{
      if(timer)clearTimeout(timer);
      controller.abort();
    }
  }
}

function defaultHttpClient():EmbeddingHttpClient{
  return {
    async request(request){
      const response=await fetch((request as EmbeddingHttpRequest & {signal?:AbortSignal}).url,{
        method:request.method,
        headers:request.headers,
        body:request.body,
        signal:(request as EmbeddingHttpRequest & {signal?:AbortSignal}).signal
      });
      return {status:response.status,body:await response.text()};
    }
  };
}
