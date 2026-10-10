use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv4Addr},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tauri::State;
use url::Url;

const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_REQUEST_ID_CHARS: usize = 128;

#[derive(Default)]
pub struct OllamaHttpState {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pending: Mutex<HashSet<String>>,
}

impl OllamaHttpState {
    fn register(&self, request_id: &str) -> Result<Arc<AtomicBool>, String> {
        if request_id.trim().is_empty() || request_id.len() > MAX_REQUEST_ID_CHARS {
            return Err("Ollama request id is invalid.".to_string());
        }
        let mut active = self.active.lock().map_err(|_| "Ollama request registry is unavailable.".to_string())?;
        if active.contains_key(request_id) {
            return Err("Ollama request id is already active.".to_string());
        }
        let cancelled_early = self.pending.lock()
            .map_err(|_| "Ollama request registry is unavailable.".to_string())?
            .remove(request_id);
        let token = Arc::new(AtomicBool::new(cancelled_early));
        active.insert(request_id.to_string(), token.clone());
        Ok(token)
    }

    fn finish(&self, request_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(request_id);
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(request_id);
        }
    }

    fn cancel(&self, request_id: &str) -> Result<(), String> {
        let active = self.active.lock().map_err(|_| "Ollama request registry is unavailable.".to_string())?;
        if let Some(token) = active.get(request_id) {
            token.store(true, Ordering::Release);
            return Ok(());
        }
        drop(active);
        let mut pending = self.pending.lock().map_err(|_| "Ollama request registry is unavailable.".to_string())?;
        if pending.len() < 128 {
            pending.insert(request_id.to_string());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaHttpResponse {
    status: u16,
    body: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OllamaHttpStreamEvent {
    kind: String,
    status: Option<u16>,
    chunk: Option<Vec<u8>>,
    message: Option<String>,
}

impl OllamaHttpStreamEvent {
    fn headers(status: u16) -> Self {
        Self { kind: "headers".to_string(), status: Some(status), chunk: None, message: None }
    }
    fn chunk(bytes: Vec<u8>) -> Self {
        Self { kind: "chunk".to_string(), status: None, chunk: Some(bytes), message: None }
    }
    fn end() -> Self {
        Self { kind: "end".to_string(), status: None, chunk: None, message: None }
    }
    fn error(message: String) -> Self {
        Self { kind: "error".to_string(), status: None, chunk: None, message: Some(message) }
    }
}

pub(super) fn validate_base_url(base_url: &str) -> Result<(), String> {
    let url = Url::parse(base_url).map_err(|_| "Ollama base URL is invalid.".to_string())?;
    if url.scheme() != "http" {
        return Err("Ollama base URL must use HTTP.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Ollama base URL must not contain credentials.".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
        return Err("Ollama base URL must not contain a path, query, or fragment.".to_string());
    }
    let host = url.host_str().ok_or_else(|| "Ollama base URL has no host.".to_string())?;
    let host = host.strip_prefix('[').and_then(|value| value.strip_suffix(']')).unwrap_or(host);
    let loopback = if host.eq_ignore_ascii_case("localhost") {
        true
    } else {
        IpAddr::from_str(host).map(|ip| match ip {
            IpAddr::V4(address) => address == Ipv4Addr::LOCALHOST,
            IpAddr::V6(address) => address.is_loopback(),
        }).unwrap_or(false)
    };
    if !loopback {
        return Err("Ollama HTTP transport is restricted to loopback hosts (127.0.0.1, localhost, or ::1).".to_string());
    }
    if url.port() == Some(0) {
        return Err("Ollama port is invalid.".to_string());
    }
    Ok(())
}

fn validated_url(base_url: &str, route: &str, method: &str) -> Result<Url, String> {
    validate_base_url(base_url)?;
    let mut url = Url::parse(base_url).map_err(|_| "Ollama base URL is invalid.".to_string())?;
    if url.port().is_none() {
        url.set_port(Some(11434)).map_err(|_| "Ollama port is invalid.".to_string())?;
    }
    match (method, route) {
        ("GET", "/api/tags" | "/api/version") | ("POST", "/api/chat") => {}
        _ => return Err("Ollama HTTP route is not allowed.".to_string()),
    }
    url.set_path(route);
    Ok(url)
}

fn request_timeout(timeout_ms: Option<u64>) -> Result<Duration, String> {
    let millis = timeout_ms.unwrap_or(120_000);
    if !(100..=600_000).contains(&millis) {
        return Err("Ollama request timeout must be between 100 and 600000 milliseconds.".to_string());
    }
    Ok(Duration::from_millis(millis))
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|_| "Failed to initialize the local Ollama HTTP transport.".to_string())
}

async fn wait_for_cancel(token: Arc<AtomicBool>) {
    while !token.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tauri::command]
pub async fn ollama_http_request(
    base_url: String,
    route: String,
    method: String,
    body: Option<String>,
    timeout_ms: Option<u64>,
    request_id: String,
    state: State<'_, OllamaHttpState>,
) -> Result<OllamaHttpResponse, String> {
    let url = validated_url(&base_url, &route, &method)?;
    let timeout = request_timeout(timeout_ms)?;
    if body.as_ref().map(|value| value.len()).unwrap_or(0) > MAX_REQUEST_BODY_BYTES {
        return Err("Ollama request body exceeds the allowed size.".to_string());
    }
    if method == "GET" && body.is_some() {
        return Err("Ollama GET requests must not contain a body.".to_string());
    }
    let token = state.register(&request_id)?;
    let result = async {
        let client = client(timeout)?;
        let mut builder = client.request(
            match method.as_str() {
                "GET" => reqwest::Method::GET,
                "POST" => reqwest::Method::POST,
                _ => return Err("Ollama HTTP method is not allowed.".to_string()),
            },
            url,
        ).header(reqwest::header::ACCEPT, "application/json");
        if let Some(body) = body {
            builder = builder.header(reqwest::header::CONTENT_TYPE, "application/json").body(body);
        }
        let request = builder.send();
        let response = tokio::select! {
            response = request => response.map_err(|_| "Ollama connection failed or the local API rejected the request.".to_string())?,
            _ = wait_for_cancel(token.clone()) => return Err("Ollama request was cancelled.".to_string()),
        };
        let status = response.status().as_u16();
        let mut response = response;
        let mut bytes = Vec::new();
        loop {
            let next = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|_| "Failed while reading the Ollama response.".to_string())?,
                _ = wait_for_cancel(token.clone()) => return Err("Ollama request was cancelled.".to_string()),
            };
            let Some(chunk) = next else { break };
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
                return Err("Ollama response exceeds the allowed size.".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(bytes).map_err(|_| "Ollama returned a non-UTF-8 response.".to_string())?;
        Ok(OllamaHttpResponse { status, body })
    }.await;
    state.finish(&request_id);
    result
}

#[tauri::command]
pub async fn ollama_http_stream(
    base_url: String,
    route: String,
    method: String,
    body: Option<String>,
    timeout_ms: Option<u64>,
    request_id: String,
    channel: Channel<OllamaHttpStreamEvent>,
    state: State<'_, OllamaHttpState>,
) -> Result<(), String> {
    let url = validated_url(&base_url, &route, &method)?;
    if method != "POST" || route != "/api/chat" {
        return Err("Ollama streaming is allowed only for POST /api/chat.".to_string());
    }
    let timeout = request_timeout(timeout_ms)?;
    if body.as_ref().map(|value| value.len()).unwrap_or(0) > MAX_REQUEST_BODY_BYTES {
        return Err("Ollama request body exceeds the allowed size.".to_string());
    }
    let body = body.ok_or_else(|| "Ollama chat body is required.".to_string())?;
    let token = state.register(&request_id)?;
    let result = async {
        let client = client(timeout)?;
        let response = tokio::select! {
            response = client.post(url)
                .header(reqwest::header::ACCEPT, "application/x-ndjson")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body)
                .send() => response.map_err(|_| "Ollama connection failed or the local API rejected the request.".to_string())?,
            _ = wait_for_cancel(token.clone()) => return Err("Ollama request was cancelled.".to_string()),
        };
        channel.send(OllamaHttpStreamEvent::headers(response.status().as_u16()))
            .map_err(|_| "Ollama stream receiver closed.".to_string())?;
        let mut response = response;
        loop {
            let next = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|_| "Failed while reading the Ollama stream.".to_string())?,
                _ = wait_for_cancel(token.clone()) => {
                    let _ = channel.send(OllamaHttpStreamEvent::error("Ollama request was cancelled.".to_string()));
                    return Err("Ollama request was cancelled.".to_string());
                }
            };
            match next {
                Some(chunk) => channel.send(OllamaHttpStreamEvent::chunk(chunk.to_vec()))
                    .map_err(|_| "Ollama stream receiver closed.".to_string())?,
                None => {
                    channel.send(OllamaHttpStreamEvent::end())
                        .map_err(|_| "Ollama stream receiver closed.".to_string())?;
                    break;
                }
            }
        }
        Ok(())
    }.await;
    state.finish(&request_id);
    if let Err(error) = &result {
        let _ = channel.send(OllamaHttpStreamEvent::error(error.clone()));
    }
    result
}

#[tauri::command]
pub fn ollama_http_cancel(request_id: String, state: State<'_, OllamaHttpState>) -> Result<(), String> {
    if request_id.trim().is_empty() || request_id.len() > MAX_REQUEST_ID_CHARS {
        return Err("Ollama request id is invalid.".to_string());
    }
    state.cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_and_only_documented_routes_are_allowed() {
        assert!(validated_url("http://127.0.0.1:11434", "/api/tags", "GET").is_ok());
        assert!(validated_url("http://localhost:11434", "/api/version", "GET").is_ok());
        assert!(validated_url("http://[::1]:11434", "/api/chat", "POST").is_ok());
        assert!(validated_url("https://127.0.0.1:11434", "/api/tags", "GET").is_err());
        assert!(validated_url("http://192.168.1.5:11434", "/api/tags", "GET").is_err());
        assert!(validated_url("http://127.0.0.2:11434", "/api/tags", "GET").is_err());
        assert!(validated_url("http://example.com:11434", "/api/tags", "GET").is_err());
        assert!(validated_url("http://127.0.0.1:11434", "/anything", "GET").is_err());
        assert!(validated_url("http://127.0.0.1:11434", "/api/chat", "GET").is_err());
        assert!(validated_url("http://user@127.0.0.1:11434", "/api/tags", "GET").is_err());
        assert!(validated_url("http://127.0.0.1:11434/path", "/api/tags", "GET").is_err());
    }
}
