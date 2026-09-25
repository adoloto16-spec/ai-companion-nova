export * from "./diagnostics";
export * from "./events";
export * from "./state";
export * from "./capabilities";
export * from "./module-manager";
export * from "./security";
export * from "./tools";
export * from "./providers";
export * from "./action-broker";

import type {ChatProvider,ChatRequest,ChatEvent} from "../../contracts/src/index";
export class BasicAiRuntime{
  constructor(private readonly chat:ChatProvider){}
  async *chatStream(request:ChatRequest):AsyncIterable<ChatEvent>{
    for await(const event of this.chat.chat(request))yield event;
  }
}
