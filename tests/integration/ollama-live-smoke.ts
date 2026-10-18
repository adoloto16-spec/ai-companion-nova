import type {ChatRequest,ChatReasoningOptions,CredentialReference,CredentialStore} from "../../contracts/src/index";
import {AiRuntime,ProviderRegistry} from "../../core/src";
import {OllamaChatProvider} from "../../providers/chat/ollama/src/index";

async function main():Promise<void>{
  const model=process.env.OLLAMA_MODEL?.trim();
  if(!model)throw new Error("Set OLLAMA_MODEL to an installed local model tag before running pnpm test:ollama-live.");
  const baseUrl=process.env.OLLAMA_BASE_URL?.trim()||"http://127.0.0.1:11434";
  const rawMode=process.env.OLLAMA_REASONING_MODE?.trim()||"disabled";
  if(rawMode!=="disabled"&&rawMode!=="enabled"&&rawMode!=="provider-default")
    throw new Error("OLLAMA_REASONING_MODE must be disabled, enabled, or provider-default.");
  const effort=process.env.OLLAMA_REASONING_EFFORT?.trim();
  if(effort&&rawMode!=="enabled")throw new Error("OLLAMA_REASONING_EFFORT requires OLLAMA_REASONING_MODE=enabled.");
  const reasoning:ChatReasoningOptions={mode:rawMode as ChatReasoningOptions["mode"],...(effort?{effort:effort as NonNullable<ChatReasoningOptions["effort"]>}:{})};
  const credentials:CredentialStore={
    async getSecret(_reference:CredentialReference):Promise<string|undefined>{return undefined;},
    async setSecret(_reference:CredentialReference,_value:string):Promise<void>{},
    async deleteSecret(_reference:CredentialReference):Promise<void>{}
  };
  const provider=new OllamaChatProvider({baseUrl,model,timeoutMs:120_000},credentials);
  const registry=new ProviderRegistry();
  registry.register(provider,["chat"]);
  const runtime=new AiRuntime(registry);
  const request:ChatRequest={
    apiVersion:"1",schemaVersion:"1",requestId:"ollama-live-smoke-"+Date.now(),
    providerId:provider.id,model,
    context:{conversationId:"ollama-live-smoke",messages:[{role:"user",content:"Reply with the exact text OLLAMA_SMOKE_OK and nothing else."}]},
    generation:{temperature:0,maxTokens:64},
    reasoning
  };
  const response=await runtime.generate(request);
  if(!response.message.content.trim())throw new Error("Ollama POST /api/chat returned no public assistant content.");
  console.log("PASS real Ollama HTTP smoke: POST /api/chat returned public content; provider="+provider.id+
    ", model="+response.model+", publicCharacters="+response.message.content.length+", finishReason="+response.finishReason);
}
void main().catch(error=>{console.error("FAIL real Ollama HTTP smoke:",error);process.exitCode=1;});
