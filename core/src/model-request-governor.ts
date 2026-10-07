import type {DiagnosticsStore} from "../../contracts/src/index";
export type ModelRequestPriority="interactive"|"nova_cognition"|"maintenance";
export interface ModelRequestGovernorRequest<T>{id:string;priority:ModelRequestPriority;signal?:AbortSignal;retry?:boolean;execute:()=>Promise<T>}
export interface ModelRequestGovernorOptions{
  /** @deprecated Accepted for migration but ignored. Provider responses are the source of truth for rate limits. */
  maxRequestsPerMinute?:number|(()=>number);
  maxConcurrentRequests:number|(()=>number);
  backgroundRequestPriority?:number|(()=>number);
  retryDelayMs?:number|(()=>number);
  maxRetryDelayMs?:number|(()=>number);
  maxRetries?:number|(()=>number);
  sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>;
  diagnostics?:DiagnosticsStore
}
const bound=(v:number|undefined,d:number,min:number,max:number)=>typeof v==="number"&&Number.isInteger(v)?Math.min(max,Math.max(min,v)):d;
const resolve=(v:number|(()=>number)|undefined,d:number)=>typeof v==="function"?(()=>{try{return v()}catch{return d}})():v===undefined?d:v;
const abort=()=>{const e=new Error("Model request was aborted.");e.name="AbortError";return e};
const isAbort=(e:unknown)=>Boolean(e&&typeof e==="object"&&"name" in e&&(e as any).name==="AbortError");
const retryable=(e:unknown)=>{if(isAbort(e))return false;const c=(e as any)?.chatError;return Boolean((e as any)?.retryable===true||c?.retryable===true)};
const retryAfter=(e:unknown)=>{const d=(e as any)?.chatError?.details;return typeof d?.retryAfterMs==="number"?Math.max(0,d.retryAfterMs):undefined};
interface Entry{sequence:number;request:ModelRequestGovernorRequest<any>;resolve:(v:any)=>void;reject:(e:any)=>void}
export class ModelRequestGovernor{
 private readonly queue:Entry[]=[];private active=0;private seq=0;
 constructor(private readonly options:ModelRequestGovernorOptions){}
 getSnapshot(){return{active:this.active,queued:this.queue.length,maxConcurrentRequests:this.maxConcurrency()}}
 async run<T>(request:ModelRequestGovernorRequest<T>):Promise<T>{
   let attempt=0;
   for(;;){
     if(request.signal?.aborted)throw abort();
     try{return await this.enqueue(request)}
     catch(error){
       if(request.signal?.aborted||isAbort(error))throw error;
       const max=bound(resolve(this.options.maxRetries,0),0,0,5);
       if(request.retry===false||attempt>=max||!retryable(error))throw error;
       const base=bound(resolve(this.options.retryDelayMs,1000),1000,50,60000);
       const cap=bound(resolve(this.options.maxRetryDelayMs,30000),30000,base,120000);
       const delay=Math.min(cap,retryAfter(error)??Math.min(cap,base*Math.pow(2,attempt)));
       attempt++;this.options.diagnostics?.recordError("model-request-governor","MODEL_REQUEST_RETRY","Retrying model request after provider failure.",{requestId:request.id,attempt,delayMs:delay});
       await this.sleep(delay,request.signal);
     }
   }
 }
 private enqueue<T>(request:ModelRequestGovernorRequest<T>){return new Promise<T>((resolvePromise,rejectPromise)=>{if(request.signal?.aborted){rejectPromise(abort());return}this.queue.push({sequence:this.seq++,request,resolve:resolvePromise,reject:rejectPromise});this.drain()})}
 private drain(){if(this.active>=this.maxConcurrency())return;this.queue.sort((a,b)=>this.priority(b.request.priority)-this.priority(a.request.priority)||a.sequence-b.sequence);while(this.active<this.maxConcurrency()&&this.queue.length){const entry=this.queue.shift()!;if(entry.request.signal?.aborted){entry.reject(abort());continue}this.active++;void entry.request.execute().then(entry.resolve,entry.reject).finally(()=>{this.active--;this.drain()})}}
 private priority(value:ModelRequestPriority){return value==="interactive"?100:value==="nova_cognition"?75:bound(resolve(this.options.backgroundRequestPriority,10),10,0,50)}
 private maxConcurrency(){return bound(resolve(this.options.maxConcurrentRequests,2),2,1,16)}
 private sleep(ms:number,signal?:AbortSignal){if(this.options.sleep)return this.options.sleep(ms,signal);return new Promise<void>((resolvePromise,rejectPromise)=>{if(signal?.aborted){rejectPromise(abort());return}const t=setTimeout(()=>{signal?.removeEventListener("abort",onAbort);resolvePromise()},ms);const onAbort=()=>{clearTimeout(t);rejectPromise(abort())};signal?.addEventListener("abort",onAbort,{once:true})})}
}