import type {
  ChatRequest,
  CredentialReference,
  CredentialStore
} from "../../contracts/src/index";
import {
  CHAT_API_VERSION,
  CHAT_SCHEMA_VERSION
} from "../../contracts/src/index";
import {
  OllamaChatProvider,
  OllamaProviderError,
  validateOllamaBaseUrl,
  type OllamaHttpClient,
  type OllamaHttpRequest,
  type OllamaHttpResponse,
  type OllamaHttpStreamResponse
} from "../../providers/chat/ollama/src/index";
import { testProviderPresetConfiguration } from "../../runtime/bootstrap/src/provider-configuration";

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(label + ": expected " + String(expected) + ", got " + String(actual));
}
function ok(value: unknown, label: string): void {
  if (!value) throw new Error(label);
}
function deepEqual(actual: unknown, expected: unknown, label: string): void {
  equal(JSON.stringify(actual), JSON.stringify(expected), label);
}
async function rejects(
  fn: () => Promise<unknown>,
  check: (error: unknown) => boolean,
  label: string
): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    if (!check(error)) throw new Error(label + " returned unexpected error: " + String(error));
    return error;
  }
  throw new Error(label + " did not reject");
}

class EmptyCredentialStore implements CredentialStore {
  async getSecret(_reference: CredentialReference): Promise<string | undefined> { return undefined; }
  async setSecret(_reference: CredentialReference, _value: string): Promise<void> {}
  async deleteSecret(_reference: CredentialReference): Promise<void> {}
}

type RequestHandler = (request: OllamaHttpRequest) => Promise<OllamaHttpResponse>;
type StreamHandler = (request: OllamaHttpRequest) => Promise<OllamaHttpStreamResponse>;

class FakeOllamaHttpClient implements OllamaHttpClient {
  readonly requests: OllamaHttpRequest[] = [];
  readonly streamRequests: OllamaHttpRequest[] = [];
  requestHandler: RequestHandler = async request => {
    if (request.url.endsWith("/api/tags")) {
      return {status: 200, body: JSON.stringify({models: [
        {name: "llama3.2:latest", model: "llama3.2:latest", size: 123},
        {name: "qwen2.5:14b-instruct-q4_K_M", model: "qwen2.5:14b-instruct-q4_K_M"}
      ]})};
    }
    return {status: 200, body: JSON.stringify({
      model: "llama3.2:latest",
      message: {role: "assistant", content: "hello from Ollama"},
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 5
    })};
  };
  streamHandler: StreamHandler = async () => ({
    status: 200,
    body: chunks([JSON.stringify({
      model: "llama3.2:latest", message: {role: "assistant", content: "streamed"}, done: false
    }) + "\n", JSON.stringify({model: "llama3.2:latest", done: true, done_reason: "stop"})])
  });

  async request(request: OllamaHttpRequest): Promise<OllamaHttpResponse> {
    this.requests.push(request);
    return this.requestHandler(request);
  }
  async stream(request: OllamaHttpRequest): Promise<OllamaHttpStreamResponse> {
    this.streamRequests.push(request);
    return this.streamHandler(request);
  }
}

async function* chunks(parts: readonly string[]): AsyncIterable<string> {
  for (const part of parts) {
    await Promise.resolve();
    yield part;
  }
}

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    apiVersion: CHAT_API_VERSION,
    schemaVersion: CHAT_SCHEMA_VERSION,
    requestId: "ollama-test-request",
    providerId: "ollama",
    model: "llama3.2:latest",
    context: {
      conversationId: "ollama-test-conversation",
      messages: [
        {role: "system", content: "Keep responses accurate."},
        {role: "user", content: "Hello."}
      ]
    },
    ...overrides
  };
}

function provider(http: FakeOllamaHttpClient, overrides: Partial<{
  baseUrl: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  topP: number;
  numCtx: number;
  numPredict: number;
  keepAlive: string | number;
}> = {}): OllamaChatProvider {
  return new OllamaChatProvider({
    baseUrl: "http://127.0.0.1:11434",
    model: "llama3.2:latest",
    timeoutMs: 2_000,
    ...overrides
  }, new EmptyCredentialStore(), http);
}

async function loopbackValidationTest(): Promise<void> {
  for (const url of [
    "http://127.0.0.1:11434",
    "http://localhost:11434",
    "http://[::1]:11434"
  ]) equal(validateOllamaBaseUrl(url).length, 0, url + " is allowed");
  for (const url of [
    "https://127.0.0.1:11434",
    "http://127.0.0.2:11434",
    "http://192.168.1.15:11434",
    "http://example.com:11434",
    "http://user:secret@127.0.0.1:11434",
    "http://127.0.0.1:11434/api",
    "http://127.0.0.1:11434?key=value",
    "http://127.0.0.1:0"
  ]) ok(validateOllamaBaseUrl(url).length > 0, url + " must be rejected");
}

async function modelDiscoveryAndNoKeyTest(): Promise<void> {
  const http = new FakeOllamaHttpClient();
  const models = await provider(http).listModels();
  deepEqual(models.map(item => item.id), ["llama3.2:latest", "qwen2.5:14b-instruct-q4_K_M"], "tagged model names are preserved");
  equal(http.requests[0]?.url, "http://127.0.0.1:11434/api/tags", "native tags endpoint");
  equal(http.requests[0]?.method, "GET", "model discovery method");
  ok(http.requests.every(item => !("Authorization" in item.headers) && !("authorization" in item.headers)), "no API key is sent");
  equal(provider(http).capabilities().structuredOutput, true, "structured output capability is explicit");
  equal(provider(http).capabilities().vision, false, "vision capability remains disabled");
  equal(provider(http).capabilities().toolCalling, false, "tool calling capability remains disabled");
  equal(provider(http).capabilities().reasoning, false, "reasoning capability remains disabled");
}

async function ordinaryRequestMappingTest(): Promise<void> {
  const http = new FakeOllamaHttpClient();
  const response = await provider(http).chat(chatRequest({
    generation: {temperature: 0.35, topP: 0.75, maxTokens: 120, responseFormat: {type: "text"}}
  }));
  equal(response.message.content, "hello from Ollama", "ordinary response content");
  equal(response.finishReason, "stop", "done maps to stop");
  deepEqual(response.usage, {promptTokens: 3, completionTokens: 5, totalTokens: 8}, "token counts map");
  const req = http.requests[0]!;
  equal(req.url, "http://127.0.0.1:11434/api/chat", "native chat endpoint");
  const body = JSON.parse(req.body!) as Record<string, unknown>;
  equal(body.stream, false, "ordinary request disables streaming");
  equal(body.format, undefined, "text generation omits JSON format");
  deepEqual(body.options, {temperature: 0.35, top_p: 0.75, num_predict: 120}, "generation parameters map without invented context window");
  equal(body.model, "llama3.2:latest", "model tag preserved");
  const sentMessages = body.messages as Array<{role: string; content: string}>;
  deepEqual(sentMessages, [
    {role: "system", content: "Keep responses accurate."},
    {role: "user", content: "Hello."}
  ], "single system message content and ordinary user message are preserved in the actual request body");
  equal(req.headers.Authorization, undefined, "local requests do not carry credentials");
}

async function multipleSystemMessagesAreNormalizedInWireBodyTest(): Promise<void> {
  const http = new FakeOllamaHttpClient();
  await provider(http).chat(chatRequest({
    context: {
      conversationId: "ollama-multiple-system-conversation",
      messages: [
        {role: "system", content: "Base instruction."},
        {role: "user", content: "First question."},
        {role: "assistant", content: "Earlier answer."},
        {role: "system", content: "Memory: user prefers concise answers."},
        {role: "user", content: "Follow-up question."},
        {role: "system", content: "Core Book: use metric units."},
        {role: "system", content: "   "}
      ]
    }
  }));

  const request = http.requests[0]!;
  equal(request.url, "http://127.0.0.1:11434/api/chat", "normalization is verified on the actual /api/chat request");
  const body = JSON.parse(request.body!) as {messages: Array<{role: string; content: string}>};
  deepEqual(body.messages, [
    {role: "system", content: "Base instruction.\n\n---\n\nMemory: user prefers concise answers.\n\n---\n\nCore Book: use metric units."},
    {role: "user", content: "First question."},
    {role: "assistant", content: "Earlier answer."},
    {role: "user", content: "Follow-up question."}
  ], "all non-empty system content is merged in source order and user/assistant order is preserved in the wire JSON");
  equal(body.messages.filter(message => message.role === "system").length, 1, "wire JSON contains exactly one system message");
}

async function requestWithoutSystemMessageStaysSystemFreeTest(): Promise<void> {
  const http = new FakeOllamaHttpClient();
  await provider(http).chat(chatRequest({
    context: {
      conversationId: "ollama-no-system-conversation",
      messages: [
        {role: "user", content: "First question."},
        {role: "assistant", content: "Earlier answer."},
        {role: "user", content: "Follow-up question."}
      ]
    }
  }));

  const request = http.requests[0]!;
  const body = JSON.parse(request.body!) as {messages: Array<{role: string; content: string}>};
  deepEqual(body.messages, [
    {role: "user", content: "First question."},
    {role: "assistant", content: "Earlier answer."},
    {role: "user", content: "Follow-up question."}
  ], "no system instruction is invented and original conversation order is preserved in the wire JSON");
  equal(body.messages.some(message => message.role === "system"), false, "wire JSON remains system-free when input has no non-empty system messages");
}

async function configuredOptionsTest(): Promise<void> {
  const http = new FakeOllamaHttpClient();
  await provider(http, {temperature: 0.6, topP: 0.9, numCtx: 8192, numPredict: 300, keepAlive: "5m"}).chat(chatRequest());
  const body = JSON.parse(http.requests[0]!.body!) as {options?: Record<string, unknown>; keep_alive?: string | number};
  deepEqual(body.options, {temperature: 0.6, top_p: 0.9, num_predict: 300, num_ctx: 8192}, "only configured model options are sent");
  equal(body.keep_alive, "5m", "keep_alive is forwarded");
  const forever = new FakeOllamaHttpClient();
  await provider(forever, {keepAlive: -1}).chat(chatRequest());
  equal((JSON.parse(forever.requests[0]!.body!) as {keep_alive?: string | number}).keep_alive, -1, "keep_alive -1 is preserved as a number");
  const noContext = new FakeOllamaHttpClient();
  await provider(noContext).chat(chatRequest());
  const noContextBody = JSON.parse(noContext.requests[0]!.body!) as {options?: Record<string, unknown>};
  ok(!("num_ctx" in (noContextBody.options ?? {})), "num_ctx is not forced to an arbitrary default");
}

async function jsonModeAndSchemaMappingTest(): Promise<void> {
  const jsonHttp = new FakeOllamaHttpClient();
  jsonHttp.requestHandler = async () => ({
    status: 200,
    body: JSON.stringify({model: "llama3.2:latest", message: {role: "assistant", content: "{\"ok\":true}"}, done: true})
  });
  await provider(jsonHttp).chat(chatRequest({generation: {responseFormat: {type: "json"}}}));
  const jsonBody = JSON.parse(jsonHttp.requests[0]!.body!) as Record<string, unknown>;
  equal(jsonBody.format, "json", "JSON mode uses native Ollama JSON format");

  const schema = {
    type: "object",
    properties: {answer: {type: "string"}},
    required: ["answer"],
    additionalProperties: false
  };
  const schemaHttp = new FakeOllamaHttpClient();
  schemaHttp.requestHandler = async () => ({
    status: 200,
    body: JSON.stringify({model: "llama3.2:latest", message: {role: "assistant", content: "{\"answer\":\"ok\"}"}, done: true})
  });
  await provider(schemaHttp).chat(chatRequest({generation: {responseFormat: {type: "json-schema", name: "answer", schema}}}));
  const schemaBody = JSON.parse(schemaHttp.requests[0]!.body!) as Record<string, unknown>;
  deepEqual(schemaBody.format, schema, "the actual JSON Schema is sent in format");
  deepEqual((schemaBody.messages as Array<{role: string; content: string}>)[0], {role: "system", content: "Keep responses accurate."}, "schema is not replaced with a system prompt");
}

async function invalidJsonAndSchemaViolationTest(): Promise<void> {
  const badJson = new FakeOllamaHttpClient();
  badJson.requestHandler = async () => ({status: 200, body: JSON.stringify({
    model: "llama3.2:latest", message: {role: "assistant", content: "{bad json"}, done: true
  })});
  await rejects(() => provider(badJson).chat(chatRequest({generation: {responseFormat: {type: "json"}}})),
    error => error instanceof OllamaProviderError && error.chatError.details?.category === "invalid_json",
    "invalid JSON response");

  const schema = {type: "object", properties: {answer: {type: "string"}}, required: ["answer"], additionalProperties: false};
  const mismatch = new FakeOllamaHttpClient();
  mismatch.requestHandler = async () => ({status: 200, body: JSON.stringify({
    model: "llama3.2:latest", message: {role: "assistant", content: "{\"answer\":42}"}, done: true
  })});
  await rejects(() => provider(mismatch).chat(chatRequest({generation: {responseFormat: {type: "json-schema", schema}}})),
    error => error instanceof OllamaProviderError && error.chatError.details?.category === "json_schema_violation",
    "schema violation");

  await rejects(() => provider(new FakeOllamaHttpClient()).chat(chatRequest({
    generation: {responseFormat: {type: "json-schema", schema: {type: "object", patternProperties: {answer: {type: "string"}}} as never}}
  })), error => error instanceof OllamaProviderError && error.chatError.details?.category === "unsupported_json_schema",
  "unsupported schema keyword is explicit");
}

async function splitNdjsonStreamingTest(): Promise<void> {
  const http = new FakeOllamaHttpClient();
  const schema = {type: "object", properties: {answer: {type: "string"}}, required: ["answer"], additionalProperties: false};
  const lines = [
    JSON.stringify({model: "llama3.2:latest", message: {role: "assistant", content: "{\"ans"}, done: false}),
    JSON.stringify({model: "llama3.2:latest", message: {role: "assistant", content: "wer\":\"ok\"}"}, done: false}),
    JSON.stringify({model: "llama3.2:latest", done: true, done_reason: "stop", prompt_eval_count: 2, eval_count: 4})
  ];
  const wire = lines.join("\r\n");
  http.streamHandler = async () => ({status: 200, headers: {"content-type": "application/x-ndjson"}, body: chunks([
    wire.slice(0, 9), wire.slice(9, 30), wire.slice(30, 53), wire.slice(53)
  ])});
  const events: Array<{type: string; text?: string; finishReason?: string}> = [];
  const response = await provider(http).stream(chatRequest({generation: {responseFormat: {type: "json-schema", schema}}}), {
    onEvent(event) { events.push(event); }
  });
  equal(response.message.content, "{\"answer\":\"ok\"}", "final JSON is assembled across split NDJSON fragments");
  equal(response.finishReason, "stop", "stream final reason");
  deepEqual(events.map(event => event.type), ["delta", "delta", "completed"], "completion follows final schema validation");
  equal(events[2]?.finishReason, "stop", "final stream event reports stop");
  const body = JSON.parse(http.streamRequests[0]!.body!) as Record<string, unknown>;
  deepEqual(body.format, schema, "streaming request passes schema format");
  equal(body.stream, true, "native chat streaming enabled");
}

async function streamSchemaViolationTest(): Promise<void> {
  const http = new FakeOllamaHttpClient();
  http.streamHandler = async () => ({status: 200, body: chunks([
    JSON.stringify({message: {role: "assistant", content: "{\"answer\":42}"}, done: false}) + "\n",
    JSON.stringify({done: true}) // final line deliberately has no trailing newline
  ])});
  const events: string[] = [];
  await rejects(() => provider(http).stream(chatRequest({generation: {responseFormat: {type: "json-schema", schema: {
    type: "object", properties: {answer: {type: "string"}}, required: ["answer"], additionalProperties: false
  }}}}), {onEvent(event) { events.push(event.type); }}),
    error => error instanceof OllamaProviderError && error.chatError.details?.category === "json_schema_violation",
    "stream schema violation");
  ok(events.includes("error"), "schema violation is emitted as an error stream event");
  ok(!events.includes("completed"), "invalid stream never reports completed");
}

async function cancellationAndTimeoutTest(): Promise<void> {
  const cancelled = new FakeOllamaHttpClient();
  cancelled.streamHandler = async request => ({
    status: 200,
    body: chunksWithAbort(request.signal)
  });
  const controller = new AbortController();
  await rejects(() => provider(cancelled).stream(chatRequest(), {
    onEvent(event) { if (event.type === "delta") controller.abort(); }
  }, {signal: controller.signal}), error => error instanceof Error && error.name === "AbortError", "stream cancellation");
  
  const timedOut = new FakeOllamaHttpClient();
  timedOut.requestHandler = async () => new Promise<OllamaHttpResponse>(() => {});
  await rejects(() => provider(timedOut, {timeoutMs: 100}).chat(chatRequest()),
    error => error instanceof OllamaProviderError && error.chatError.details?.category === "timeout", "chat timeout");

  const streamTimeout = new FakeOllamaHttpClient();
  streamTimeout.streamHandler = async request => ({status: 200, body: chunksWithAbort(request.signal, false)});
  await rejects(() => provider(streamTimeout, {timeoutMs: 100}).stream(chatRequest(), {onEvent() {}}),
    error => error instanceof OllamaProviderError && error.chatError.details?.category === "timeout", "stream timeout");
}

async function* chunksWithAbort(signal?: AbortSignal, emitFirstDelta = true): AsyncIterable<string> {
  if (emitFirstDelta) {
    yield JSON.stringify({message: {role: "assistant", content: "partial"}, done: false}) + "\n";
  }
  await new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error); return;
    }
    signal?.addEventListener("abort", () => {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error);
    }, {once: true});
  });
}

async function apiErrorTest(): Promise<void> {
  const http = new FakeOllamaHttpClient();
  http.requestHandler = async () => ({status: 404, body: JSON.stringify({error: "model 'llama3.2:latest' not found, try pulling it first"})});
  const error = await rejects(() => provider(http).chat(chatRequest()),
    item => item instanceof OllamaProviderError && item.chatError.details?.category === "model_not_found",
    "missing model");
  ok(error instanceof Error && error.message.includes("select an installed model tag"), "missing model error is actionable");

  const api = new FakeOllamaHttpClient();
  api.requestHandler = async () => ({status: 400, body: JSON.stringify({error: "unsupported format"})});
  await rejects(() => provider(api).chat(chatRequest()),
    item => item instanceof OllamaProviderError && item.chatError.details?.category === "http",
    "Ollama API error");
}

async function connectionTestUsesNativeTransport(): Promise<void> {
  const http = new FakeOllamaHttpClient();
  const result = await testProviderPresetConfiguration({
    apiVersion: "1",
    schemaVersion: "1",
    providerId: "ollama",
    enabled: true,
    baseUrl: "http://127.0.0.1:11434",
    model: "llama3.2:latest",
    credentialReference: null
  }, new EmptyCredentialStore(), http);
  equal(result.status, "connected", "connection test performs provider generation");
  equal(http.requests.length, 1, "connection test performs exactly one chat request");
  equal(http.requests[0]?.url, "http://127.0.0.1:11434/api/chat", "connection test uses native Ollama route");
  equal(http.requests[0]?.headers.Authorization, undefined, "connection test does not load a key");
}

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ["Loopback URL restrictions", loopbackValidationTest],
    ["Model discovery and no API key", modelDiscoveryAndNoKeyTest],
    ["Ordinary request mapping and single system preservation", ordinaryRequestMappingTest],
    ["Multiple system messages normalized in wire JSON", multipleSystemMessagesAreNormalizedInWireBodyTest],
    ["Request without system messages stays system-free", requestWithoutSystemMessageStaysSystemFreeTest],
    ["Optional generation parameters", configuredOptionsTest],
    ["JSON and JSON Schema mode", jsonModeAndSchemaMappingTest],
    ["Invalid JSON and schema violations", invalidJsonAndSchemaViolationTest],
    ["Split NDJSON streaming", splitNdjsonStreamingTest],
    ["Streaming schema violation", streamSchemaViolationTest],
    ["Cancellation and timeouts", cancellationAndTimeoutTest],
    ["API and missing model errors", apiErrorTest],
    ["Connection test runtime path", connectionTestUsesNativeTransport]
  ];
  for (const [name, test] of tests) {
    await test();
    console.log("PASS Ollama " + name);
  }
  console.log("All Ollama provider tests passed.");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
