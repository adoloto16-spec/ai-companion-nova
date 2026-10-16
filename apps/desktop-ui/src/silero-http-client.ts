import {Channel,invoke} from "@tauri-apps/api/core";
import type {SileroFetch} from "../../../providers/tts/silero/src";
interface SileroNativeEvent{kind:"headers"|"chunk"|"end"|"error";status?:number;contentType?:string;contentLength?:number;chunk?:number[];code?:string;message?:string;}
class SileroNativeTransportError extends Error{
  readonly code:string;
  constructor(code:string,message:string){super(message);this.name="SileroTransportError";this.code=code;}
}
const MAX_REQUEST_BODY_BYTES=64*1024;
function validateRequest(rawUrl:string,init:RequestInit):{baseUrl:string;route:string;method:"GET"|"POST";body?:string;signal?:AbortSignal}{
  let url:URL;try{url=new URL(rawUrl);}catch{throw new SileroNativeTransportError("unsafe_base_url","Silero URL is invalid.");}
  const host=url.hostname.toLowerCase(),method=(init.method??"GET").toUpperCase();
  if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]","::1"].includes(host)||
    url.username!==""||url.password!==""||url.search!==""||url.hash!==""||url.port==="0")
    throw new SileroNativeTransportError("unsafe_base_url","Silero is restricted to an HTTP loopback URL.");
  if(init.redirect!=="error")throw new SileroNativeTransportError("invalid_request","Silero requests must reject redirects.");
  if(!((method==="GET"&&url.pathname==="/openapi.json")||(method==="POST"&&url.pathname==="/v1/audio/speech")))
    throw new SileroNativeTransportError("unsafe_route","Silero HTTP method or route is not allowed.");
  let body:string|undefined;
  if(method==="GET"){
    if(init.body!==null&&init.body!==undefined)throw new SileroNativeTransportError("invalid_request","Silero OpenAPI requests must not contain a body.");
  }else{
    if(typeof init.body!=="string")throw new SileroNativeTransportError("invalid_request","Silero speech request body must be JSON text.");
    body=init.body;if(new TextEncoder().encode(body).byteLength>MAX_REQUEST_BODY_BYTES)
      throw new SileroNativeTransportError("request_too_large","Silero speech request exceeds the allowed size.");
  }
  return {baseUrl:url.origin,route:url.pathname,method,body,...(init.signal?{signal:init.signal}: {})};
}
function nativeCancel(requestId:string):void{void invoke("silero_http_cancel",{requestId}).catch(()=>undefined);}
/** Route-restricted native HTTP transport; avoids WebView CORS restrictions. */
export function createSileroNativeFetch():SileroFetch{
  return(rawUrl,init)=>new Promise<Response>((resolve,reject)=>{
    let request:{baseUrl:string;route:string;method:"GET"|"POST";body?:string;signal?:AbortSignal};
    try{request=validateRequest(rawUrl,init);}catch(error){reject(error);return;}
    if(request.signal?.aborted){reject(new DOMException("Silero operation was cancelled.","AbortError"));return;}
    const requestId="silero-"+crypto.randomUUID(),channel=new Channel<SileroNativeEvent>();
    let resolved=false,finished=false,bodyController:ReadableStreamDefaultController<Uint8Array>|undefined;
    let onAbort:()=>void=()=>{};
    const cleanup=()=>request.signal?.removeEventListener("abort",onAbort);
    const fail=(error:Error)=>{
      if(finished)return;finished=true;
      if(!resolved){resolved=true;reject(error);}else bodyController?.error(error);
      cleanup();
    };
    const body=new ReadableStream<Uint8Array>({
      start(controller){bodyController=controller;},
      cancel(){if(finished)return;finished=true;cleanup();nativeCancel(requestId);}
    });
    onAbort=()=>{if(finished)return;fail(new DOMException("Silero operation was cancelled.","AbortError"));nativeCancel(requestId);};
    channel.onmessage=(event)=>{
      if(finished)return;
      if(event.kind==="headers"){
        const status=event.status;
        if(resolved||typeof status!=="number"||!Number.isInteger(status)||status<200||status>599){
          fail(new SileroNativeTransportError("transport_error","Silero returned invalid HTTP response headers."));return;
        }
        try{
          const headers=new Headers();
          if(typeof event.contentType==="string"&&event.contentType.length<=128)headers.set("content-type",event.contentType);
          if(typeof event.contentLength==="number"&&Number.isSafeInteger(event.contentLength)&&event.contentLength>=0)headers.set("content-length",String(event.contentLength));
          resolved=true;resolve(new Response([204,205,304].includes(status)?null:body,{status,headers}));
        }catch{fail(new SileroNativeTransportError("transport_error","Silero response headers could not be processed."));}
        return;
      }
      if(event.kind==="chunk"){
        if(!resolved||!bodyController||!Array.isArray(event.chunk)){fail(new SileroNativeTransportError("transport_error","Silero response stream is out of sequence."));return;}
        try{bodyController.enqueue(new Uint8Array(event.chunk));}
        catch{fail(new SileroNativeTransportError("transport_error","Silero response stream is unavailable."));}
        return;
      }
      if(event.kind==="end"){
        finished=true;
        if(!resolved)reject(new SileroNativeTransportError("transport_error","Silero transport ended before response headers."));
        else bodyController?.close();
        cleanup();return;
      }
      if(event.kind==="error"){
        fail(new SileroNativeTransportError(typeof event.code==="string"?event.code:"transport_error",
          typeof event.message==="string"?event.message:"Silero local API request failed."));
      }
    };
    request.signal?.addEventListener("abort",onAbort,{once:true});
    void invoke("silero_http_request",{baseUrl:request.baseUrl,route:request.route,method:request.method,body:request.body,requestId,channel})
      .catch(()=>fail(new SileroNativeTransportError("transport_error","Silero native HTTP transport could not be started.")));
  });
}
