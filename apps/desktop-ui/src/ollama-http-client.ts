import {Channel, invoke} from "@tauri-apps/api/core";
import type {
  OllamaHttpClient,
  OllamaHttpRequest,
  OllamaHttpResponse,
  OllamaHttpStreamResponse
} from "../../../providers/chat/ollama/src/index";

interface OllamaHostResponse { status: number; body: string; }
interface OllamaHostStreamEvent {
  kind: "headers" | "chunk" | "end" | "error";
  status?: number;
  chunk?: number[];
  message?: string;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "ollama-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function routeFor(request: OllamaHttpRequest): { baseUrl: string; route: string } {
  let url: URL;
  try { url = new URL(request.url); }
  catch { throw new Error("Ollama URL is invalid."); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error("Ollama HTTP transport is restricted to HTTP loopback URLs.");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Ollama URL cannot contain credentials, query, or fragment components.");
  if (!["/api/tags", "/api/version", "/api/chat"].includes(url.pathname)) throw new Error("Ollama HTTP route is not allowed.");
  if ((url.pathname === "/api/chat") !== (request.method === "POST")) throw new Error("Ollama HTTP method is not allowed for this route.");
  return { baseUrl: url.origin, route: url.pathname };
}

class AsyncStringQueue implements AsyncIterable<string>, AsyncIterator<string> {
  private readonly values: string[] = [];
  private readonly waiters: Array<{ resolve: (result: IteratorResult<string>) => void; reject: (error: unknown) => void }> = [];
  private ended = false;
  private failure: unknown;
  constructor(private readonly cleanup: () => void, private readonly cancel: () => void) {}

  [Symbol.asyncIterator](): AsyncIterator<string> { return this; }

  next(): Promise<IteratorResult<string>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  return(): Promise<IteratorResult<string>> {
    if (!this.ended && this.failure === undefined) this.cancel();
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(value: string): void {
    if (!value || this.ended || this.failure !== undefined) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.ended || this.failure !== undefined) return;
    this.ended = true;
    this.cleanup();
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    this.cleanup();
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

export class TauriOllamaHttpClient implements OllamaHttpClient {
  constructor(private readonly timeoutMs = 120_000) {}

  async request(request: OllamaHttpRequest): Promise<OllamaHttpResponse> {
    const {baseUrl, route} = routeFor(request);
    if (request.signal?.aborted) throw abortError();
    const id = requestId();
    const cancel = () => { void invoke("ollama_http_cancel", {requestId: id}).catch(() => undefined); };
    request.signal?.addEventListener("abort", cancel, {once: true});
    try {
      const response = await invoke<OllamaHostResponse>("ollama_http_request", {
        baseUrl, route, method: request.method, body: request.body,
        timeoutMs: this.timeoutMs, requestId: id
      });
      return {status: response.status, body: response.body};
    } catch (error) {
      if (request.signal?.aborted) throw abortError();
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", cancel);
    }
  }

  async stream(request: OllamaHttpRequest): Promise<OllamaHttpStreamResponse> {
    const {baseUrl, route} = routeFor(request);
    if (route !== "/api/chat" || request.method !== "POST") throw new Error("Ollama streaming is allowed only for POST /api/chat.");
    if (!request.body) throw new Error("Ollama chat request body is required.");
    if (request.signal?.aborted) throw abortError();

    const id = requestId();
    let headersSeen = false;
    let resolveHeaders!: (status: number) => void;
    let rejectHeaders!: (error: unknown) => void;
    const headers = new Promise<number>((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
    const decoder = new TextDecoder();
    let signalHandler: (() => void) | undefined;
    const cleanup = () => {
      if (signalHandler) request.signal?.removeEventListener("abort", signalHandler);
      signalHandler = undefined;
    };
    const cancel = () => { void invoke("ollama_http_cancel", {requestId: id}).catch(() => undefined); };
    const queue = new AsyncStringQueue(cleanup, cancel);
    const channel = new Channel<OllamaHostStreamEvent>();
    channel.onmessage = event => {
      switch (event.kind) {
        case "headers":
          if (!headersSeen) {
            headersSeen = true;
            resolveHeaders(event.status ?? 500);
          }
          break;
        case "chunk": {
          const bytes = new Uint8Array(event.chunk ?? []);
          queue.push(decoder.decode(bytes, {stream: true}));
          break;
        }
        case "end":
          queue.push(decoder.decode());
          queue.close();
          break;
        case "error": {
          const error = new Error(event.message || "Ollama streaming transport failed.");
          if (!headersSeen) {
            headersSeen = true;
            rejectHeaders(error);
          }
          queue.fail(error);
          break;
        }
      }
    };

    signalHandler = () => {
      cancel();
      const error = abortError();
      if (!headersSeen) {
        headersSeen = true;
        rejectHeaders(error);
      }
      queue.fail(error);
    };
    request.signal?.addEventListener("abort", signalHandler, {once: true});

    void invoke<void>("ollama_http_stream", {
      baseUrl, route, method: request.method, body: request.body,
      timeoutMs: this.timeoutMs, requestId: id, channel
    }).catch(error => {
      if (!headersSeen) {
        headersSeen = true;
        rejectHeaders(error);
      }
      queue.fail(error);
    });

    try {
      const status = await headers;
      return {status, body: queue};
    } catch (error) {
      queue.fail(error);
      cleanup();
      throw error;
    }
  }
}
