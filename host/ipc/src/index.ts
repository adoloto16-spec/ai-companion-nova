import type { JsonRpcMessage, JsonRpcTransport } from "../../../contracts/src/index";

export class InMemoryJsonRpcTransport implements JsonRpcTransport {
  private peer?: InMemoryJsonRpcTransport;
  private handler?: (message: JsonRpcMessage) => void | Promise<void>;
  connect(peer:InMemoryJsonRpcTransport){this.peer=peer;peer.peer=this;}
  async send(message:JsonRpcMessage){if(!this.peer?.handler)throw new Error("not connected");await this.peer.handler(message);}
  onMessage(handler:(message:JsonRpcMessage)=>void|Promise<void>){this.handler=handler;return ()=>{this.handler=undefined;};}
  async close(){this.peer=undefined;this.handler=undefined;}
}
