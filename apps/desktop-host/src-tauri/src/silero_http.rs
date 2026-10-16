use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap,sync::{atomic::{AtomicBool,Ordering},Arc,Mutex},time::{Duration,Instant}};
use tauri::{ipc::Channel,State};
use url::Url;
const MAX_REQUEST_BODY_BYTES:usize=64*1024;
const MAX_OPENAPI_RESPONSE_BYTES:usize=4*1024*1024;
const MAX_WAV_RESPONSE_BYTES:usize=64*1024*1024;
const MAX_CHANNEL_CHUNK_BYTES:usize=64*1024;
const MAX_REQUEST_ID_CHARS:usize=128;
const MAX_PENDING_CANCELLATIONS:usize=128;
const PENDING_CANCELLATION_TTL:Duration=Duration::from_secs(30);
const CONNECT_TIMEOUT:Duration=Duration::from_secs(5);
const OPENAPI_TIMEOUT:Duration=Duration::from_secs(5);
const SPEECH_TIMEOUT:Duration=Duration::from_secs(125);

#[derive(Default)]
pub struct SileroHttpState{active:Mutex<HashMap<String,Arc<AtomicBool>>>,pending:Mutex<HashMap<String,Instant>>}
impl SileroHttpState{
 fn register(&self,id:&str)->Result<Arc<AtomicBool>,String>{
  validate_request_id(id)?;
  let mut active=self.active.lock().map_err(|_|"Silero request registry is unavailable.".to_string())?;
  if active.contains_key(id){return Err("Silero request id is already active.".into());}
  let mut pending=self.pending.lock().map_err(|_|"Silero request registry is unavailable.".to_string())?;
  pending.retain(|_,at|at.elapsed()<PENDING_CANCELLATION_TTL);
  let token=Arc::new(AtomicBool::new(pending.remove(id).is_some()));active.insert(id.into(),token.clone());Ok(token)
 }
 fn finish(&self,id:&str){if let Ok(mut a)=self.active.lock(){a.remove(id);}if let Ok(mut p)=self.pending.lock(){p.remove(id);}}
 fn cancel(&self,id:&str)->Result<(),String>{
  validate_request_id(id)?;
  let active=self.active.lock().map_err(|_|"Silero request registry is unavailable.".to_string())?;
  if let Some(token)=active.get(id){token.store(true,Ordering::Release);return Ok(());}drop(active);
  let mut pending=self.pending.lock().map_err(|_|"Silero request registry is unavailable.".to_string())?;
  pending.retain(|_,at|at.elapsed()<PENDING_CANCELLATION_TTL);
  if pending.len()>=MAX_PENDING_CANCELLATIONS&&!pending.contains_key(id){return Err("Silero cancellation registry is busy.".into());}
  pending.insert(id.into(),Instant::now());Ok(())
 }
}
#[derive(Serialize,Clone,Debug)]
#[serde(rename_all="camelCase")]
pub struct SileroHttpEvent{
 kind:String,
 #[serde(skip_serializing_if="Option::is_none")]status:Option<u16>,
 #[serde(skip_serializing_if="Option::is_none")]content_type:Option<String>,
 #[serde(skip_serializing_if="Option::is_none")]content_length:Option<u64>,
 #[serde(skip_serializing_if="Option::is_none")]chunk:Option<Vec<u8>>,
 #[serde(skip_serializing_if="Option::is_none")]code:Option<String>,
 #[serde(skip_serializing_if="Option::is_none")]message:Option<String>,
}
impl SileroHttpEvent{
 fn headers(s:u16,t:Option<String>,l:Option<u64>)->Self{Self{kind:"headers".into(),status:Some(s),content_type:t,content_length:l,chunk:None,code:None,message:None}}
 fn chunk(b:Vec<u8>)->Self{Self{kind:"chunk".into(),status:None,content_type:None,content_length:None,chunk:Some(b),code:None,message:None}}
 fn end()->Self{Self{kind:"end".into(),status:None,content_type:None,content_length:None,chunk:None,code:None,message:None}}
 fn error(c:&str,m:&str)->Self{Self{kind:"error".into(),status:None,content_type:None,content_length:None,chunk:None,code:Some(c.into()),message:Some(m.into())}}
}
#[derive(Clone,Copy)]
struct TransportFailure{code:&'static str,message:&'static str}
impl TransportFailure{
 fn timeout()->Self{Self{code:"timeout",message:"Silero local API request timed out."}}
 fn unreachable()->Self{Self{code:"connection_refused",message:"Silero local API is unreachable. Check that the server is running and the port is correct."}}
 fn cancelled()->Self{Self{code:"cancelled",message:"Silero operation was cancelled."}}
 fn stream()->Self{Self{code:"transport_error",message:"Silero local API response could not be read."}}
}
fn validate_request_id(id:&str)->Result<(),String>{
 if id.is_empty()||id.len()>MAX_REQUEST_ID_CHARS||!id.starts_with("silero-")||!id.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){
  return Err("Silero request id is invalid.".into());
 }Ok(())
}
fn validate_speech_body(body:&str)->Result<(),String>{
 if body.len()>MAX_REQUEST_BODY_BYTES{return Err("Silero request body exceeds the allowed size.".into());}
 let value:Value=serde_json::from_str(body).map_err(|_|"Silero speech request must be valid JSON.".to_string())?;
 let o=value.as_object().ok_or_else(||"Silero speech request must be a JSON object.".to_string())?;
 let allowed=["model","input","voice","response_format","speed"];
 if o.len()!=allowed.len()||o.keys().any(|k|!allowed.contains(&k.as_str())){return Err("Silero speech request contains unsupported fields.".into());}
 for(f,max)in[("model",120usize),("input",4000usize),("voice",80usize)]{
  let v=o.get(f).and_then(Value::as_str).ok_or_else(||format!("Silero speech field '{f}' must be a string."))?;
  if v.trim().is_empty()||v.chars().count()>max||v.chars().any(char::is_control){return Err(format!("Silero speech field '{f}' is invalid."));}
 }
 if o.get("response_format").and_then(Value::as_str)!=Some("wav"){return Err("Silero speech response_format must be wav.".into());}
 let speed=o.get("speed").and_then(Value::as_f64).ok_or_else(||"Silero speech speed must be a number.".to_string())?;
 if !speed.is_finite()||!(0.5..=2.0).contains(&speed){return Err("Silero speech speed must be between 0.5 and 2.".into());}Ok(())
}
struct ValidatedRequest{url:Url,method:reqwest::Method,body:Option<String>,timeout:Duration,max_response_bytes:usize}
fn validated_request(base:&str,route:&str,method:&str,body:Option<&str>)->Result<ValidatedRequest,String>{
 if base.len()>1024||base.trim().is_empty(){return Err("Silero base URL is invalid.".into());}
 let mut url=Url::parse(base).map_err(|_|"Silero base URL is invalid.".to_string())?;
 if url.scheme()!="http"{return Err("Silero base URL must use HTTP.".into());}
 if !url.username().is_empty()||url.password().is_some(){return Err("Silero base URL must not contain credentials.".into());}
 if url.query().is_some()||url.fragment().is_some()||url.path()!="/"{return Err("Silero base URL must not contain a path, query, or fragment.".into());}
 let host=url.host_str().ok_or_else(||"Silero base URL has no host.".to_string())?;
 let host=host.strip_prefix('[').and_then(|v|v.strip_suffix(']')).unwrap_or(host);
 if !(host.eq_ignore_ascii_case("localhost")||host=="127.0.0.1"||host=="::1"){return Err("Silero HTTP transport is restricted to 127.0.0.1, localhost, and ::1.".into());}
 if url.port()==Some(0){return Err("Silero port is invalid.".into());}
 let(m,t,max)=match(method,route){
  ("GET","/openapi.json")=>{if body.is_some(){return Err("Silero OpenAPI requests must not contain a body.".into());}(reqwest::Method::GET,OPENAPI_TIMEOUT,MAX_OPENAPI_RESPONSE_BYTES)}
  ("POST","/v1/audio/speech")=>{let b=body.ok_or_else(||"Silero speech request requires a JSON body.".to_string())?;validate_speech_body(b)?;(reqwest::Method::POST,SPEECH_TIMEOUT,MAX_WAV_RESPONSE_BYTES)}
  _=>return Err("Silero HTTP method or route is not allowed.".into())
 };url.set_path(route);Ok(ValidatedRequest{url,method:m,body:body.map(str::to_owned),timeout:t,max_response_bytes:max})
}
async fn wait_for_cancel(token:Arc<AtomicBool>){while !token.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(20)).await;}}
fn map_error(e:&reqwest::Error)->TransportFailure{if e.is_timeout(){TransportFailure::timeout()}else if e.is_connect(){TransportFailure::unreachable()}else{TransportFailure::stream()}}
fn emit<F>(f:&mut F,event:SileroHttpEvent)->Result<(),TransportFailure>where F:FnMut(SileroHttpEvent)->Result<(),String>{
 f(event).map_err(|_|TransportFailure{code:"transport_error",message:"Silero response channel is unavailable."})
}
async fn perform_request<F>(r:ValidatedRequest,token:Arc<AtomicBool>,mut send_event:F)->Result<(),TransportFailure>
where F:FnMut(SileroHttpEvent)->Result<(),String>{
 if token.load(Ordering::Acquire){return Err(TransportFailure::cancelled());}
 let client=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().connect_timeout(CONNECT_TIMEOUT).timeout(r.timeout).build().map_err(|_|TransportFailure::stream())?;
 let mut request=client.request(r.method,r.url);
 if let Some(body)=r.body{request=request.header(reqwest::header::CONTENT_TYPE,"application/json").header(reqwest::header::ACCEPT,"audio/wav").body(body);}
 else{request=request.header(reqwest::header::ACCEPT,"application/json");}
 let send=request.send();
 let mut response=tokio::select!{result=send=>result.map_err(|e|map_error(&e))?,_=wait_for_cancel(token.clone())=>return Err(TransportFailure::cancelled()),};
 let status=response.status().as_u16();
 let content_type=response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v|v.to_str().ok()).filter(|v|v.len()<=128&&!v.chars().any(char::is_control)).map(str::to_owned);
 let content_length=response.content_length();
 emit(&mut send_event,SileroHttpEvent::headers(status,content_type,content_length))?;
 if content_length.map(|n|n>r.max_response_bytes as u64).unwrap_or(false){emit(&mut send_event,SileroHttpEvent::error("response_too_large","Silero response exceeds the allowed size."))?;return Ok(());}
 if !response.status().is_success(){emit(&mut send_event,SileroHttpEvent::end())?;return Ok(());}
 let mut total=0usize;
 loop{
  let part=tokio::select!{result=response.chunk()=>result.map_err(|e|map_error(&e))?,_=wait_for_cancel(token.clone())=>return Err(TransportFailure::cancelled()),};
  let Some(bytes)=part else{break};total=total.saturating_add(bytes.len());
  if total>r.max_response_bytes{emit(&mut send_event,SileroHttpEvent::error("response_too_large","Silero response exceeds the allowed size."))?;return Ok(());}
  for chunk in bytes.chunks(MAX_CHANNEL_CHUNK_BYTES){if token.load(Ordering::Acquire){return Err(TransportFailure::cancelled());}emit(&mut send_event,SileroHttpEvent::chunk(chunk.to_vec()))?;}
 }emit(&mut send_event,SileroHttpEvent::end())
}
#[tauri::command]
pub async fn silero_http_request(base_url:String,route:String,method:String,body:Option<String>,request_id:String,channel:Channel<SileroHttpEvent>,state:State<'_,SileroHttpState>)->Result<(),String>{
 validate_request_id(&request_id)?;let request=validated_request(&base_url,&route,&method,body.as_deref())?;let token=state.register(&request_id)?;
 let result=perform_request(request,token,|event|channel.send(event).map_err(|_|"Silero response channel is unavailable.".to_string())).await;
 state.finish(&request_id);if let Err(e)=result{let _=channel.send(SileroHttpEvent::error(e.code,e.message));}Ok(())
}
#[tauri::command]
pub fn silero_http_cancel(request_id:String,state:State<'_,SileroHttpState>)->Result<(),String>{state.cancel(&request_id)}

#[cfg(test)]
mod tests{
 use super::*;use std::{io::{Read,Write},net::TcpListener,thread::{self,JoinHandle}};
 fn valid_body()->String{serde_json::json!({"model":"tts-1","input":"Привет","voice":"xenia","response_format":"wav","speed":1.0}).to_string()}
 fn wire(status:&str,kind:&str,body:&[u8])->Vec<u8>{let mut r=format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).into_bytes();r.extend_from_slice(body);r}
 fn fixture(response:Vec<u8>)->(String,JoinHandle<Vec<u8>>){
  let listener=TcpListener::bind("127.0.0.1:0").unwrap();let addr=listener.local_addr().unwrap();
  let thread=thread::spawn(move||{let(mut stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();let mut req=Vec::new();let mut buf=[0u8;4096];
   loop{let n=stream.read(&mut buf).unwrap();if n==0{break;}req.extend_from_slice(&buf[..n]);if let Some(e)=req.windows(4).position(|x|x==b"\r\n\r\n"){
    let h=String::from_utf8_lossy(&req[..e]);let len=h.lines().find(|x|x.to_ascii_lowercase().starts_with("content-length:")).and_then(|x|x.split_once(':')).and_then(|(_,v)|v.trim().parse::<usize>().ok()).unwrap_or(0);
    if req.len()>=e+4+len{break;}
   }}let _=stream.write_all(&response);req});
  (format!("http://{addr}"),thread)
 }
 #[test]fn rejects_nonloopback_credentials_and_routes(){
  let body=valid_body();
  for url in ["http://example.com:8081","http://127.0.0.2:8081","https://127.0.0.1:8081","http://user:secret@127.0.0.1:8081","http://127.0.0.1:8081/path","http://127.0.0.1:8081/?x=1"]{
   assert!(validated_request(url,"/openapi.json","GET",None).is_err(),"accepted {url}");
  }
  for(m,p,b)in[("GET","/v1/audio/speech",None),("POST","/openapi.json",Some(body.as_str())),("DELETE","/v1/audio/speech",Some(body.as_str())),("POST","/v1/audio/speech/skip",Some(body.as_str())),("POST","/other",Some(body.as_str()))]{
   assert!(validated_request("http://127.0.0.1:8081",p,m,b).is_err(),"accepted {m} {p}");
  }
  let mut bad:Value=serde_json::from_str(&body).unwrap();bad["response_format"]=Value::String("mp3".into());
  assert!(validated_request("http://127.0.0.1:8081","/v1/audio/speech","POST",Some(&bad.to_string())).is_err());
  bad=serde_json::from_str(&body).unwrap();bad["authorization"]=Value::String("secret".into());
  assert!(validated_request("http://127.0.0.1:8081","/v1/audio/speech","POST",Some(&bad.to_string())).is_err());
  assert!(validated_request("http://127.0.0.1:8081","/v1/audio/speech","POST",Some(&"x".repeat(MAX_REQUEST_BODY_BYTES+1))).is_err());
 }
 #[tokio::test]async fn local_server_checks_openapi_with_native_transport(){
  let body=br#"{"openapi":"3.1.0","paths":{"/v1/audio/speech":{"post":{"requestBody":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/SpeechRequest"}}}}}}},"components":{"schemas":{"SpeechRequest":{"type":"object","required":["model","input","voice"],"properties":{"model":{"type":"string"},"input":{"type":"string"},"voice":{"type":"string"},"response_format":{"type":"string"},"speed":{"type":"number"}}}}}"#;
  let(base,server)=fixture(wire("200 OK","application/json",body));let req=validated_request(&base,"/openapi.json","GET",None).unwrap();let mut events=Vec::new();
  perform_request(req,Arc::new(AtomicBool::new(false)),|e|{events.push(e);Ok(())}).await.unwrap();
  let request=server.join().unwrap();assert!(String::from_utf8_lossy(&request).starts_with("GET /openapi.json HTTP/1.1"));
  let got:Vec<u8>=events.iter().filter_map(|e|e.chunk.as_ref()).flatten().copied().collect();assert_eq!(got,body);assert_eq!(events.first().unwrap().status,Some(200));assert_eq!(events.last().unwrap().kind,"end");
 }
 #[tokio::test]async fn local_server_preserves_binary_wav_and_request_contract(){
  let audio=vec![b'R',b'I',b'F',b'F',38,0,0,0,b'W',b'A',b'V',b'E',b'f',b'm',b't',b' ',16,0,0,0,1,0,1,0,0x22,0x56,0,0,0x44,0xac,0,0,2,0,16,0,b'd',b'a',b't',b'a',2,0,0,0,0xff,0x80];
  let(base,server)=fixture(wire("200 OK","audio/wav",&audio));let body=valid_body();let req=validated_request(&base,"/v1/audio/speech","POST",Some(&body)).unwrap();let mut events=Vec::new();
  perform_request(req,Arc::new(AtomicBool::new(false)),|e|{events.push(e);Ok(())}).await.unwrap();let sent=server.join().unwrap();let end=sent.windows(4).position(|p|p==b"\r\n\r\n").unwrap();
  let headers=String::from_utf8_lossy(&sent[..end]).to_ascii_lowercase();assert!(headers.starts_with("post /v1/audio/speech http/1.1"));assert!(headers.contains("content-type: application/json"));assert!(headers.contains("accept: audio/wav"));
  let json:Value=serde_json::from_slice(&sent[end+4..]).unwrap();assert_eq!(json["model"],"tts-1");assert_eq!(json["input"],"Привет");assert_eq!(json["voice"],"xenia");assert_eq!(json["response_format"],"wav");assert_eq!(json["speed"],1.0);
  let received:Vec<u8>=events.iter().filter_map(|e|e.chunk.as_ref()).flatten().copied().collect();assert_eq!(received,audio,"binary WAV bytes must be preserved exactly");
  assert_eq!(events.first().unwrap().status,Some(200));assert_eq!(events.last().unwrap().kind,"end");assert!(events.iter().filter_map(|e|e.chunk.as_ref()).all(|c|c.len()<=MAX_CHANNEL_CHUNK_BYTES));
 }
 #[tokio::test]async fn redirects_are_not_followed_and_large_responses_are_blocked(){
  let redir=b"HTTP/1.1 302 Found\r\nLocation: http://example.com/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec();
  let(base,server)=fixture(redir);let req=validated_request(&base,"/openapi.json","GET",None).unwrap();let mut events=Vec::new();
  perform_request(req,Arc::new(AtomicBool::new(false)),|e|{events.push(e);Ok(())}).await.unwrap();let sent=server.join().unwrap();assert!(String::from_utf8_lossy(&sent).starts_with("GET /openapi.json HTTP/1.1"));
  assert_eq!(events.first().unwrap().status,Some(302));assert!(!events.iter().any(|e|e.chunk.is_some()));
  let large=format!("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",MAX_WAV_RESPONSE_BYTES+1).into_bytes();
  let(base,server)=fixture(large);let req=validated_request(&base,"/v1/audio/speech","POST",Some(&valid_body())).unwrap();let mut events=Vec::new();
  perform_request(req,Arc::new(AtomicBool::new(false)),|e|{events.push(e);Ok(())}).await.unwrap();let _=server.join().unwrap();
  assert!(events.iter().any(|e|e.code.as_deref()==Some("response_too_large")));assert!(!events.iter().any(|e|e.chunk.is_some()));
 }
 #[test]fn active_and_early_cancellation_are_recorded(){
  let state=SileroHttpState::default();let token=state.register("silero-live-1").unwrap();state.cancel("silero-live-1").unwrap();assert!(token.load(Ordering::Acquire));state.finish("silero-live-1");
  state.cancel("silero-early-2").unwrap();let early=state.register("silero-early-2").unwrap();assert!(early.load(Ordering::Acquire));assert!(state.register("bad-id").is_err());state.finish("silero-early-2");
 }
}
