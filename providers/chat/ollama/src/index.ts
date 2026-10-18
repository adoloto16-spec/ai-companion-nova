import type {
  ChatError,
  ChatFinishReason,
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatRequestOptions,
  ChatResponse,
  ChatStreamDone,
  ChatStreamHandlers,
  ChatToolCall,
  ChatReasoningOptions,
  ChatStreamOptions,
  ChatUsage,
  CredentialReference,
  CredentialStore,
  HealthStatus,
  JsonSchema,
  ModelInfo,
  ProviderCapabilities,
  DiagnosticsStore
} from "../../../../contracts/src/index";
import { MinimalJsonSchemaValidator } from "../../../../contracts/src/schema-validator";

export const OLLAMA_PROVIDER_ID = "ollama";
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 600_000;
const schemaValidator = new MinimalJsonSchemaValidator();
const ALLOWED_SCHEMA_KEYS = new Set([
  "$schema", "$id", "title", "description", "default", "examples",
  "type", "properties", "required", "additionalProperties", "items", "enum",
  "oneOf", "const", "minimum", "maximum", "minLength", "maxLength",
  "minItems", "maxItems"
]);

export interface OllamaHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal?: AbortSignal;
}
export interface OllamaHttpResponse { status: number; body: string; }
export interface OllamaHttpStreamResponse {
  status: number;
  body: AsyncIterable<string>;
  headers?: Readonly<Record<string, string>>;
}
export interface OllamaHttpClient {
  request(request: OllamaHttpRequest): Promise<OllamaHttpResponse>;
  stream?(request: OllamaHttpRequest): Promise<OllamaHttpStreamResponse>;
}

export class FetchOllamaHttpClient implements OllamaHttpClient {
  async request(request: OllamaHttpRequest): Promise<OllamaHttpResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: request.signal
    });
    return { status: response.status, body: await response.text() };
  }

  async stream(request: OllamaHttpRequest): Promise<OllamaHttpStreamResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: request.signal
    });
    if (!response.body) throw new Error("Ollama streaming response body is unavailable.");
    const reader = response.body.getReader();
    const body: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        const decoder = new TextDecoder();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            if (item.value?.length) {
              const chunk = decoder.decode(item.value, { stream: true });
              if (chunk) yield chunk;
            }
          }
          const tail = decoder.decode();
          if (tail) yield tail;
        } finally {
          reader.releaseLock();
        }
      }
    };
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  }
}

export interface OllamaProviderConfig {
  baseUrl?: string;
  model: string;
  credential?: CredentialReference | null;
  timeoutMs?: number;
  temperature?: number;
  topP?: number;
  numCtx?: number;
  numPredict?: number;
  keepAlive?: string | number;
  diagnostics?: DiagnosticsStore;
  providerPresetId?: string;
}

export class OllamaProviderError extends Error {
  readonly chatError: ChatError;
  constructor(chatError: ChatError) {
    super(chatError.message);
    this.name = "OllamaProviderError";
    this.chatError = chatError;
  }
}

interface OllamaMessage { role:"system"|"user"|"assistant"|"tool"; content:string; tool_name?:string; tool_calls?:{type:"function";function:{index:number;name:string;arguments:Record<string,unknown>}}[]; }
interface OllamaModelMetadata { capabilities:readonly string[]; thinking?:{values:readonly unknown[];default?:unknown}; }
interface OllamaChunk {
  model?: unknown;
  message?: { role?: unknown; content?: unknown; thinking?: unknown; tool_calls?: unknown } | null;
  done?: unknown;
  done_reason?: unknown;
  error?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

export function validateOllamaBaseUrl(baseUrl: string): string[] {
  const errors: string[] = [];
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "http:") errors.push("Ollama URL must use HTTP.");
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      errors.push("Ollama is restricted to loopback hosts (127.0.0.1, localhost, or ::1).");
    }
    if (url.username || url.password) errors.push("Ollama URL must not contain credentials.");
    if (url.search || url.hash) errors.push("Ollama URL must not contain a query or fragment.");
    if (url.pathname !== "/" && url.pathname !== "") errors.push("Ollama base URL must not contain an API path.");
    const port = url.port ? Number(url.port) : 11434;
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("Ollama port must be between 1 and 65535.");
  } catch {
    errors.push("Ollama base URL is invalid.");
  }
  return errors;
}

export function validateOllamaProviderConfig(config: OllamaProviderConfig, options: { allowEmptyModel?: boolean } = {}): string[] {
  const errors = validateOllamaBaseUrl(config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL);
  if (!options.allowEmptyModel && (!config.model || config.model.trim().length === 0)) errors.push("Ollama model is not configured.");
  if (config.model !== undefined && config.model !== config.model.trim()) errors.push("Ollama model must not have surrounding whitespace.");
  if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 100)) errors.push("Ollama timeout must be at least 100 milliseconds.");
  if (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) errors.push("Ollama temperature must be between 0 and 2.");
  if (config.topP !== undefined && (!Number.isFinite(config.topP) || config.topP < 0 || config.topP > 1)) errors.push("Ollama top_p must be between 0 and 1.");
  if (config.numCtx !== undefined && (!Number.isInteger(config.numCtx) || config.numCtx < 1)) errors.push("Ollama num_ctx must be a positive integer.");
  if (config.numPredict !== undefined && (!Number.isInteger(config.numPredict) || config.numPredict < 1)) errors.push("Ollama num_predict must be a positive integer.");
  if (config.keepAlive !== undefined && !(typeof config.keepAlive === "string" && config.keepAlive.trim().length > 0) &&
    !(typeof config.keepAlive === "number" && Number.isFinite(config.keepAlive) && (config.keepAlive >= 0 || config.keepAlive === -1))) {
    errors.push("Ollama keep_alive must be a non-empty duration, -1, or a non-negative number.");
  }
  return errors;
}

function validateSchemaKeywords(schema: unknown, path = "$schema"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [path + " must be an object JSON Schema."];
  const record = schema as Record<string, unknown>;
  const errors: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) errors.push(path + " uses unsupported JSON Schema keyword '" + key + "'.");
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      for (const [property, propertySchema] of Object.entries(child as Record<string, unknown>)) {
        errors.push(...validateSchemaKeywords(propertySchema, path + ".properties." + property));
      }
    } else if (key === "items" || key === "additionalProperties" && typeof child === "object" && child !== null || key === "oneOf" && Array.isArray(child)) {
      if (key === "oneOf" && Array.isArray(child)) {
        child.forEach((part, index) => errors.push(...validateSchemaKeywords(part, path + ".oneOf[" + index + "]")));
      } else if (typeof child === "object" && child !== null) {
        errors.push(...validateSchemaKeywords(child, path + "." + key));
      }
    }
  }
  return errors;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export class OllamaChatProvider implements ChatProvider {
  readonly id = OLLAMA_PROVIDER_ID;
  private readonly config: OllamaProviderConfig;
  private readonly httpClient: OllamaHttpClient;
  private modelsCache?: { expiresAt: number; models: ModelInfo[] };
  private readonly modelMetadataCache=new Map<string,{expiresAt:number;value:OllamaModelMetadata}>();

  constructor(config: OllamaProviderConfig, _credentialStore: CredentialStore, httpClient: OllamaHttpClient = new FetchOllamaHttpClient()) {
    this.config = { ...config, baseUrl: config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL };
    this.httpClient = httpClient;
  }

  metadata() {
    return {
      id: this.id,
      kind: "chat" as const,
      displayName: "Ollama",
      version: "1.0.0",
      description: "Native local Ollama /api/chat provider with NDJSON streaming and JSON Schema output."
    };
  }

  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, vision: false, structuredOutput: true, reasoning: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    this.ensureConfiguration(undefined, true);
    const now = Date.now();
    if (this.modelsCache && this.modelsCache.expiresAt > now) return this.modelsCache.models.map(model => ({ ...model }));
    const response = await this.requestWithTimeout({ url: this.url("/api/tags"), method: "GET", headers: { Accept: "application/json" } }, this.timeoutMs(), undefined);
    if (response.status < 200 || response.status >= 300) throw this.httpFailure(response.status, response.body);
    let payload: unknown;
    try { payload = JSON.parse(response.body); }
    catch { throw this.failure(undefined, "INVALID_RESPONSE", "Ollama returned an invalid model list.", "malformed_response"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray((payload as Record<string, unknown>).models)) {
      throw this.failure(undefined, "INVALID_RESPONSE", "Ollama returned an invalid model list.", "malformed_response");
    }
    const models = ((payload as { models: unknown[] }).models).flatMap(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      const name = typeof item.name === "string" ? item.name : typeof item.model === "string" ? item.model : "";
      if (!name.trim()) return [];
      return [{ id: name, displayName: name, capabilities: this.capabilities() }];
    });
    this.modelsCache = { expiresAt: now + 30_000, models };
    return models.map(model => ({ ...model }));
  }

  async health(): Promise<HealthStatus> {
    try {
      this.ensureConfiguration(undefined, true);
      const response = await this.requestWithTimeout({ url: this.url("/api/tags"), method: "GET", headers: { Accept: "application/json" } }, this.timeoutMs(), undefined);
      if (response.status >= 200 && response.status < 300) return { status: "healthy", message: "Ollama is reachable." };
      return { status: "unavailable", message: this.httpMessage(response.status, response.body) };
    } catch (error) {
      return { status: "unavailable", message: error instanceof Error ? error.message : "Ollama is unavailable." };
    }
  }

  async chat(request: ChatRequest, options: ChatRequestOptions = {}): Promise<ChatResponse> {
    this.ensureConfiguration(request);
    const messages = this.mapMessages(request.context.messages, request);
    const modelMetadata=await this.modelMetadata(request,options.signal);
    const responseFormat = request.generation?.responseFormat;
    const schema = responseFormat?.type === "json-schema" || responseFormat?.type === "json" ? responseFormat.schema : undefined;
    if (schema) this.ensureSupportedSchema(schema as JsonSchema, request);
    const response = await this.requestWithTimeout({
      url: this.url("/api/chat"),
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(this.mapRequest(request, messages, false,modelMetadata)),
      signal: options.signal
    }, this.timeoutMs(), request);
    if (response.status < 200 || response.status >= 300) throw this.httpFailure(response.status, response.body, request);
    let payload: unknown;
    try { payload = JSON.parse(response.body); }
    catch { throw this.failure(request, "INVALID_RESPONSE", "Ollama returned malformed JSON.", "malformed_response"); }
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    if (!record) throw this.failure(request, "INVALID_RESPONSE", "Ollama returned an invalid chat response.", "malformed_response");
    if (typeof record.error === "string") throw this.failure(request, "PROVIDER_ERROR", record.error, "api");
    const message = record.message && typeof record.message === "object" ? record.message as Record<string, unknown> : undefined;
    if (!message || (typeof message.content !== "string" && message.tool_calls===undefined)) throw this.failure(request, "INVALID_RESPONSE", "Ollama returned no assistant message.", "malformed_response");
    const content=typeof message.content==="string"?message.content:"";
    const toolCalls=this.mapToolCalls(message.tool_calls,request);
    if(!toolCalls.length)this.validateOutput(content, request);
    const model = typeof record.model === "string" && record.model ? record.model : request.model;
    const usage = this.usage(record);
    const reasoning=typeof message.thinking==="string"&&message.thinking.length>0?message.thinking:undefined;
    return {
      apiVersion: "1", schemaVersion: "1", requestId: request.requestId,
      conversationId: request.context.conversationId, providerId: this.id, model,
      message: { role: "assistant", content, ...(toolCalls.length?{toolCalls}:{}) },
      finishReason: this.finishReason(record.done_reason, record.done),
      ...(usage ? { usage } : {}),
      ...(reasoning ? {reasoning}:{}),
      ...(request.tools?.length&&!modelMetadata?.capabilities.includes("tools")?{metadata:{toolCallingUnavailableForModel:true}}:{})
    };
  }

  async stream(request: ChatRequest, handlers: ChatStreamHandlers, options: ChatStreamOptions = {}): Promise<ChatResponse> {
    this.ensureConfiguration(request);
    if (!this.httpClient.stream) throw this.failure(request, "UNSUPPORTED", "The configured HTTP transport does not support Ollama streaming.", "transport");
    const messages = this.mapMessages(request.context.messages, request);
    const modelMetadata=await this.modelMetadata(request,options.signal);
    const responseFormat = request.generation?.responseFormat;
    const schema = responseFormat?.type === "json-schema" || responseFormat?.type === "json" ? responseFormat.schema : undefined;
    if (schema) this.ensureSupportedSchema(schema, request);

    const controller = new AbortController();
    const callerSignal = options.signal;
    const forwardAbort = () => controller.abort();
    if (callerSignal?.aborted) throw abortError();
    callerSignal?.addEventListener("abort", forwardAbort, { once: true });
    let timedOut = false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const resetIdleTimeout=()=>{
      clearTimeout(timer);
      timer=setTimeout(()=>{timedOut=true;controller.abort();},this.timeoutMs());
    };
    resetIdleTimeout();
    const started = Date.now();
    let status: number | undefined;
    let model = request.model;
    let content = "";
    let reasoning = "";
    let rawToolCalls:unknown;
    let usage: ChatUsage | undefined;
    let finishReason: ChatFinishReason = "unknown";
    let sawDone = false;
    let buffer = "";
    let responseForFailure = "";

    const emitError = async (error: OllamaProviderError) => {
      await handlers.onEvent({
        apiVersion: "1", schemaVersion: "1", requestId: request.requestId,
        conversationId: request.context.conversationId, providerId: this.id,
        model, type: "error", error: error.chatError
      });
    };

    try {
      const response = await withAbortSignal(this.httpClient.stream({
        url: this.url("/api/chat"), method: "POST",
        headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
        body: JSON.stringify(this.mapRequest(request, messages, true,modelMetadata)),
        signal: controller.signal
      }), controller.signal);
      status = response.status;
      if (status < 200 || status >= 300) {
        for await (const chunk of response.body) responseForFailure += chunk;
        throw this.httpFailure(status, responseForFailure, request);
      }

      const processLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: unknown;
        try { parsed = JSON.parse(trimmed); }
        catch { throw this.failure(request, "INVALID_RESPONSE", "Ollama returned malformed NDJSON.", "malformed_stream"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw this.failure(request, "INVALID_RESPONSE", "Ollama returned an invalid streaming event.", "malformed_stream");
        }
        const event = parsed as OllamaChunk;
        if (typeof event.error === "string" && event.error) throw this.failure(request, "PROVIDER_ERROR", event.error, "api");
        if (typeof event.model === "string" && event.model) model = event.model;
        const message = event.message;
        if(message&&typeof message.thinking==="string"&&message.thinking.length>0){
          reasoning+=message.thinking;
          await handlers.onEvent({
            apiVersion:"1",schemaVersion:"1",requestId:request.requestId,
            conversationId:request.context.conversationId,providerId:this.id,
            model,type:"reasoning",text:message.thinking
          });
        }
        if(message&&Array.isArray(message.tool_calls)&&message.tool_calls.length>0)rawToolCalls=message.tool_calls;
        if (message && typeof message.content === "string" && message.content.length > 0) {
          content += message.content;
          await handlers.onEvent({
            apiVersion: "1", schemaVersion: "1", requestId: request.requestId,
            conversationId: request.context.conversationId, providerId: this.id,
            model, type: "delta", text: message.content
          });
        }
        const mappedUsage = this.usage(event as Record<string, unknown>);
        if (mappedUsage) usage = mappedUsage;
        if (event.done === true) {
          sawDone = true;
          finishReason = this.finishReason(event.done_reason, event.done);
        }
      };

      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        if (callerSignal?.aborted) throw abortError();
        if (timedOut) throw this.failure(request, "PROVIDER_ERROR", "Ollama streaming request timed out.", "timeout", true, { timeoutMs: this.timeoutMs() });
        const item = await withAbortSignal(iterator.next(), controller.signal);
        if (item.done) break;
        resetIdleTimeout();
        buffer += item.value;
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          await processLine(line);
        }
      }
      if (buffer.trim()) await processLine(buffer);
      if (!sawDone) throw this.failure(request, "INVALID_RESPONSE", "Ollama stream ended before its final done event.", "incomplete_stream");
      const toolCalls=this.mapToolCalls(rawToolCalls,request);
      if(!toolCalls.length)this.validateOutput(content, request);
      const done: ChatStreamDone = {
        apiVersion: "1", schemaVersion: "1", requestId: request.requestId,
        conversationId: request.context.conversationId, providerId: this.id,
        model, type: "completed", finishReason, ...(usage ? { usage } : {})
      };
      await handlers.onEvent(done);
      return {
        apiVersion: "1", schemaVersion: "1", requestId: request.requestId,
        conversationId: request.context.conversationId, providerId: this.id, model,
        message: { role: "assistant", content, ...(toolCalls.length?{toolCalls}:{}) }, finishReason, ...(usage ? { usage } : {}),
        ...(reasoning?{reasoning}:{}),
        ...(request.tools?.length&&!modelMetadata?.capabilities.includes("tools")?{metadata:{toolCallingUnavailableForModel:true}}:{})
      };
    } catch (error) {
      if (callerSignal?.aborted) throw abortError();
      if (timedOut && !(error instanceof OllamaProviderError)) throw this.failure(request, "PROVIDER_ERROR", "Ollama streaming request timed out.", "timeout", true, { timeoutMs: this.timeoutMs() });
      const providerError = error instanceof OllamaProviderError ? error : this.networkFailure(error, request, Date.now() - started);
      try { await emitError(providerError); } catch { /* Keep the provider error as the primary failure. */ }
      throw providerError;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async modelMetadata(request:ChatRequest,signal?:AbortSignal):Promise<OllamaModelMetadata|undefined>{
    const needsMetadata=Boolean(request.tools?.length)||(request.reasoning!==undefined&&request.reasoning.mode!=="provider-default");
    if(!needsMetadata)return undefined;
    const cached=this.modelMetadataCache.get(request.model);
    if(cached&&cached.expiresAt>Date.now())return cached.value;
    try{
      const response=await this.requestWithTimeout({
        url:this.url("/api/show"),method:"POST",
        headers:{Accept:"application/json","Content-Type":"application/json"},
        body:JSON.stringify({model:request.model}),signal
      },this.timeoutMs(),request);
      if(response.status<200||response.status>=300)return undefined;
      const parsed:unknown=JSON.parse(response.body);
      if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return undefined;
      const raw=parsed as Record<string,unknown>;
      const capabilities=Array.isArray(raw.capabilities)?raw.capabilities.filter((value):value is string=>typeof value==="string"):[];
      const rawThinking=raw.thinking&&typeof raw.thinking==="object"&&!Array.isArray(raw.thinking)?raw.thinking as Record<string,unknown>:undefined;
      const thinking=rawThinking&&Array.isArray(rawThinking.values)?{values:rawThinking.values,...("default" in rawThinking?{default:rawThinking.default}:{})}:undefined;
      const metadata:OllamaModelMetadata={capabilities,...(thinking?{thinking}:{})};
      this.modelMetadataCache.set(request.model,{expiresAt:Date.now()+30_000,value:metadata});
      return metadata;
    }catch(error){
      if(signal?.aborted)throw abortError();
      return undefined;
    }
  }

  private resolveThink(options:ChatReasoningOptions|undefined,metadata:OllamaModelMetadata|undefined):boolean|string|undefined{
    if(!options||options.mode==="provider-default")return undefined;
    // Explicit opt-out is authoritative even when /api/show is unavailable or older Ollama
    // builds omit thinking metadata. Never collapse "disabled" into provider-default.
    if(options.mode==="disabled")return false;
    const values=metadata?.thinking?.values;
    if(!values||values.length===0)return true;
    if(options.effort&&values.includes(options.effort))return options.effort;
    if(values.includes(true))return true;
    const defaultValue=metadata?.thinking?.default;
    if(typeof defaultValue==="string"&&values.includes(defaultValue))return defaultValue;
    const named=values.find(value=>typeof value==="string");
    return typeof named==="string"?named:(values.includes(false)?false:true);
  }

  private mapToolCalls(raw:unknown,request:ChatRequest):ChatToolCall[]{
    if(raw===undefined||raw===null)return [];
    if(!Array.isArray(raw))throw this.failure(request,"INVALID_RESPONSE","Ollama returned malformed native tool calls.","malformed_tool_calls");
    if(raw.length>32)throw this.failure(request,"INVALID_RESPONSE","Ollama returned too many native tool calls.","tool_call_limit");
    return raw.map((entry,index)=>{
      const item=entry&&typeof entry==="object"&&!Array.isArray(entry)?entry as Record<string,unknown>:undefined;
      const fn=item?.function&&typeof item.function==="object"&&!Array.isArray(item.function)?item.function as Record<string,unknown>:undefined;
      const name=typeof fn?.name==="string"?fn.name:"";
      let args:unknown=fn?.arguments;
      if(typeof args==="string"){
        if(args.length>4000)throw this.failure(request,"INVALID_RESPONSE","Ollama tool arguments exceed the input limit.","tool_arguments_limit");
        try{args=JSON.parse(args);}catch{throw this.failure(request,"INVALID_RESPONSE","Ollama returned invalid JSON in tool arguments.","invalid_tool_arguments");}
      }
      if(!name||!args||typeof args!=="object"||Array.isArray(args))throw this.failure(request,"INVALID_RESPONSE","Ollama returned an invalid native tool call.","malformed_tool_call");
      if(JSON.stringify(args).length>4000)throw this.failure(request,"INVALID_RESPONSE","Ollama tool arguments exceed the input limit.","tool_arguments_limit");
      const id=typeof item?.id==="string"&&item.id.trim()?item.id:request.requestId+":tool:"+index;
      return {id,name,arguments:args as Record<string,unknown>};
    });
  }

  private mapMessages(messages: readonly ChatMessage[], request: ChatRequest): OllamaMessage[] {
    const mapped: OllamaMessage[] = messages.map(message => {
      if(message.role==="tool"){
        if(!message.toolCallId||!message.toolName)throw this.failure(request,"INVALID_REQUEST","Ollama tool result is missing its call id or tool name.","invalid_tool_message");
        return {role:"tool",tool_name:message.toolName,content:message.content};
      }
      return {
        role:message.role,
        content:message.content,
        ...(message.toolCalls?.length?{tool_calls:message.toolCalls.map((call,index)=>({type:"function" as const,function:{index,name:call.name,arguments:call.arguments}}))}:{})
      };
    });
    const systemMessages = mapped.filter(message => message.role === "system" && message.content.trim().length > 0);
    const conversationMessages = mapped.filter(message => message.role !== "system");
    if (systemMessages.length === 0) return conversationMessages;

    const mergedSystemMessage: OllamaMessage = {
      role: "system",
      content: systemMessages.map(message => message.content).join("\n\n---\n\n")
    };
    return [mergedSystemMessage, ...conversationMessages];
  }

  private mapRequest(request: ChatRequest, messages: readonly OllamaMessage[], stream: boolean,modelMetadata?:OllamaModelMetadata) {
    const generation = request.generation;
    const think=this.resolveThink(request.reasoning,modelMetadata);
    const hasNativeTools=Boolean(modelMetadata?.capabilities.includes("tools")&&request.tools?.length);
    const options: Record<string, number> = {};
    const temperature = generation?.temperature ?? this.config.temperature;
    const topP = generation?.topP ?? this.config.topP;
    if (temperature !== undefined) options.temperature = temperature;
    if (topP !== undefined) options.top_p = topP;
    const numPredict = generation?.maxTokens ?? this.config.numPredict;
    if (numPredict !== undefined) options.num_predict = numPredict;
    if (generation?.repeatPenalty !== undefined) options.repeat_penalty = generation.repeatPenalty;
    if (generation?.repeatLastN !== undefined) options.repeat_last_n = generation.repeatLastN;
    if (this.config.numCtx !== undefined) options.num_ctx = this.config.numCtx;
    const format = generation?.responseFormat;
    const schema = format?.type === "json-schema" || format?.type === "json" ? format.schema : undefined;
    return {
      model: request.model,
      messages,
      stream,
      ...(think===undefined?{}:{think}),
      ...(hasNativeTools?{tools:request.tools!.map(tool=>({type:"function",function:{name:tool.name,description:tool.description,parameters:tool.parameters}}))}:{}),
      ...(format?.type === "json" ? { format: schema ?? "json" } : format?.type === "json-schema" ? { format: schema } : {}),
      ...(Object.keys(options).length ? { options } : {}),
      ...(this.config.keepAlive === undefined ? {} : { keep_alive: this.config.keepAlive })
    };
  }

  private validateOutput(content: string, request: ChatRequest): void {
    const format = request.generation?.responseFormat;
    if (!format || format.type === "text") return;
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { throw this.failure(request, "INVALID_RESPONSE", "Ollama response was requested as JSON but returned invalid JSON.", "invalid_json"); }
    const schema = format.type === "json-schema" || format.type === "json" ? format.schema : undefined;
    if (!schema) return;
    const result = schemaValidator.validate(parsed, schema as JsonSchema);
    if (!result.valid) {
      throw this.failure(request, "INVALID_RESPONSE", "Ollama JSON output does not match the requested schema: " + result.errors.slice(0, 4).join("; "), "json_schema_violation", false, { validationErrors: result.errors.slice(0, 10) });
    }
  }

  private ensureSupportedSchema(schema: JsonSchema, request: ChatRequest): void {
    const errors = validateSchemaKeywords(schema);
    if (errors.length) throw this.failure(request, "UNSUPPORTED", "This Ollama provider cannot validate this JSON Schema: " + errors.slice(0, 3).join(" "), "unsupported_json_schema");
  }

  private usage(record: Record<string, unknown>): ChatUsage | undefined {
    const promptTokens = typeof record.prompt_eval_count === "number" ? record.prompt_eval_count : undefined;
    const completionTokens = typeof record.eval_count === "number" ? record.eval_count : undefined;
    if (promptTokens === undefined && completionTokens === undefined) return undefined;
    return {
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens }),
      ...(promptTokens === undefined || completionTokens === undefined ? {} : { totalTokens: promptTokens + completionTokens })
    };
  }

  private finishReason(reason: unknown, done: unknown): ChatFinishReason {
    if (reason === "length") return "length";
    if (done === true || reason === "stop") return "stop";
    return "unknown";
  }

  private url(path: "/api/tags" | "/api/version" | "/api/chat" | "/api/show"): string {
    return (this.config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, "") + path;
  }

  private timeoutMs(): number { return this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS; }

  private ensureConfiguration(request?: ChatRequest, allowEmptyModel = false): void {
    const errors = validateOllamaProviderConfig(this.config, { allowEmptyModel });
    if (errors.length) throw this.failure(request, "INVALID_REQUEST", errors.join(" "), "configuration");
    // Ollama is local and does not use the CredentialStore or require an API key.
  }

  private async requestWithTimeout(request: OllamaHttpRequest, timeoutMs: number, chatRequest?: ChatRequest): Promise<OllamaHttpResponse> {
    const controller = new AbortController();
    const callerSignal = request.signal;
    if (callerSignal?.aborted) throw abortError();
    const onAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await withAbortSignal(this.httpClient.request({ ...request, signal: controller.signal }), controller.signal);
    } catch (error) {
      if (callerSignal?.aborted) throw abortError();
      if (timedOut) throw this.failure(chatRequest, "PROVIDER_ERROR", "Ollama request timed out.", "timeout", true, { timeoutMs });
      throw this.networkFailure(error, chatRequest);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }
  }

  private httpFailure(status: number, body: string, request?: ChatRequest): OllamaProviderError {
    const message = this.httpMessage(status, body);
    const category = status === 404 && /model.*not found|not found.*model/i.test(body) ? "model_not_found" :
      status === 401 || status === 403 ? "authentication" : status >= 500 ? "api" : "http";
    return this.failure(request, status === 404 && category === "model_not_found" ? "PROVIDER_ERROR" : "PROVIDER_ERROR", message, category, status >= 500, { httpStatus: status });
  }

  private httpMessage(status: number, body: string): string {
    let providerMessage = "";
    try {
      const record = JSON.parse(body) as Record<string, unknown>;
      if (typeof record.error === "string") providerMessage = record.error;
    } catch { /* Use the HTTP status description below. */ }
    if (status === 404 && /model.*not found|not found.*model/i.test(providerMessage || body)) return "Ollama model was not found. Pull the model in Ollama or select an installed model tag.";
    if (status === 401 || status === 403) return "Ollama rejected the request. Check the local Ollama server configuration.";
    if (status === 404) return "Ollama API endpoint was not found. Check the Ollama server version and URL.";
    if (status === 400) return "Ollama rejected the chat request: " + (providerMessage || "invalid request");
    if (status >= 500) return "Ollama returned HTTP " + status + ": " + (providerMessage || "server error");
    return "Ollama returned HTTP " + status + (providerMessage ? ": " + providerMessage : ".");
  }

  private networkFailure(error: unknown, request?: ChatRequest, durationMs?: number): OllamaProviderError {
    if (error instanceof Error && error.name === "AbortError") return this.failure(request, "PROVIDER_ERROR", "Ollama request was cancelled.", "cancelled");
    return this.failure(request, "PROVIDER_UNAVAILABLE", "Cannot connect to local Ollama. Start Ollama and verify the URL " + this.config.baseUrl + ".", "network", true, durationMs === undefined ? {} : { durationMs });
  }

  private failure(request: ChatRequest | undefined, code: ChatError["code"], message: string, category: string, retryable = false, details: Record<string, unknown> = {}): OllamaProviderError {
    return new OllamaProviderError({
      apiVersion: "1", schemaVersion: "1", code, message,
      ...(request ? { requestId: request.requestId, providerId: this.id } : { providerId: this.id }),
      retryable, details: { category, ...details }
    });
  }
}

export { OllamaChatProvider as OllamaProvider };
