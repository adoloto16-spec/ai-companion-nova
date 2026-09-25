import type {JsonRpcMessage,JsonRpcTransport,Unsubscribe} from "../../../contracts/src/index";

export interface JsonRpcValidation{valid:boolean;error?:string}
export function validateJsonRpcMessage(value:unknown):JsonRpcValidation{
  if(!value||typeof value!=="object")return {valid:false,error:"message must be object"};
  const message=value as Record<string,unknown>;
  if(message.jsonrpc!=="2.0")return {valid:false,error:"jsonrpc must be 2.0"};
  if("method" in message){
    if(typeof message.method!=="string"||message.method.length===0)return {valid:false,error:"invalid method"};
    if("id" in message && typeof message.id!=="string"&&typeof message.id!=="number")return {valid:false,error:"invalid id"};
    if("params" in message && (typeof message.params!=="object"||message.params===null||Array.isArray(message.params)))return {valid:false,error:"params must be object"};
    return {valid:true};
  }
  if(!("id" in message)|| (typeof message.id!=="string"&&typeof message.id!=="number"))return {valid:false,error:"response requires id"};
  const hasResult="result" in message;
  const hasError="error" in message;
  if(hasResult===hasError)return {valid:false,error:"response must contain exactly one of result/error"};
  return {valid:true};
}

export class InMemoryJsonRpcTransport implements JsonRpcTransport{
  private peer?:InMemoryJsonRpcTransport;
  private handler?:((message:JsonRpcMessage)=>void|Promise<void>);
  private disconnectHandlers=new Set<(reason:string)=>void>();
  private closed=false;
  connect(peer:InMemoryJsonRpcTransport){this.peer=peer;peer.peer=this;this.closed=false;peer.closed=false;}
  async send(message:JsonRpcMessage){
    const validation=validateJsonRpcMessage(message);
    if(!validation.valid)throw new Error("RPC_VALIDATION_FAILED: "+validation.error);
    if(this.closed||!this.peer?.handler)throw new Error("RPC_DISCONNECTED");
    await this.peer.handler(message);
  }
  onMessage(handler:(message:JsonRpcMessage)=>void|Promise<void>):Unsubscribe{
    this.handler=handler;return ()=>{if(this.handler===handler)this.handler=undefined;};
  }
  onDisconnect(handler:(reason:string)=>void):Unsubscribe{this.disconnectHandlers.add(handler);return ()=>this.disconnectHandlers.delete(handler);}
  async close(){
    if(this.closed)return;
    this.closed=true;const peer=this.peer;this.peer=undefined;
    if(peer?.peer===this)peer.peer=undefined;
    this.handler=undefined;
    for(const handler of this.disconnectHandlers)handler("closed");
    for(const handler of peer?.disconnectHandlers??[])handler("peer_closed");
  }
}
