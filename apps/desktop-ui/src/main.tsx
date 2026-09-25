import React from "react";
import {createRoot} from "react-dom/client";
import {invoke} from "@tauri-apps/api/core";
import {ChatSessionController,ConversationSession,type FoundationRuntime} from "../../../core/src/index";
import {startFoundationRuntime,testProviderConfiguration,validateProviderConfiguration} from "../../../runtime/bootstrap/src/index";
import {IpcCredentialStore} from "../../../host/credentials/src/index";
import {IpcProviderConfigurationStore} from "../../../host/config/src/index";
import {
  PROVIDER_CONFIGURATION_API_VERSION,PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  type ProviderConfiguration, type ProviderConnectionTestResult, type RuntimeDiagnostics
} from "../../../contracts/src/index";
import "./styles.css";

type HostDiagnostics={status:string;runtime:string;capabilities:string[]};
const credentialReference={id:"provider.openai-compatible.default",kind:"api-key",provider:"openai-compatible"} as const;
const defaultConfiguration=():ProviderConfiguration=>({
  apiVersion:PROVIDER_CONFIGURATION_API_VERSION,schemaVersion:PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  providerId:"openai-compatible",enabled:false,baseUrl:"https://api.openai.com/v1",model:"",
  credentialReference,timeoutMs:30000
});
const preview:RuntimeDiagnostics={schemaVersion:"1",timestamp:new Date().toISOString(),runtimeStatus:"stopped",coreStatus:"stopped",modules:[],providers:[],recentErrors:[],capabilities:[]};

async function loadHost():Promise<HostDiagnostics>{
  try{return await invoke<HostDiagnostics>("get_host_diagnostics")}
  catch{return {status:"browser-preview",runtime:"host-unavailable",capabilities:[]}}
}
async function publishAndReadRuntimeDiagnostics(snapshot:RuntimeDiagnostics):Promise<RuntimeDiagnostics>{
  try{
    await invoke("set_runtime_diagnostics",{diagnostics:snapshot});
    const live=await invoke<RuntimeDiagnostics|null>("get_runtime_diagnostics");
    return live??snapshot;
  }catch{return snapshot}
}
function resultLabel(result:ProviderConnectionTestResult):string{
  switch(result.status){
    case "connected":return "Connected";
    case "authentication_failed":return "Authentication failed";
    case "configuration_error":return "Configuration error";
    case "network_error":return "Network error";
    case "timeout":return "Timed out";
    case "provider_error":return "Provider error";
  }
}

function ChatView({controller,runtime}:{controller:ChatSessionController;runtime:FoundationRuntime|undefined}){
  const [snapshot,setSnapshot]=React.useState(()=>controller.getSnapshot());
  const [input,setInput]=React.useState("");
  const bottomRef=React.useRef<HTMLDivElement|null>(null);

  React.useEffect(()=>controller.subscribe(setSnapshot),[controller]);
  React.useEffect(()=>{bottomRef.current?.scrollIntoView({block:"end"})},[snapshot.messages.length,snapshot.sending]);

  const send=React.useCallback(async()=>{
    const result=await controller.submit(input,runtime?.getActiveChatModel()??"fake-chat");
    if(result.status!=="rejected")setInput("");
  },[controller,input,runtime]);

  const onKeyDown=(event:React.KeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.key==="Enter"&&!event.shiftKey){
      event.preventDefault();
      if(!snapshot.sending)void send();
    }
  };

  return <section className="chat-panel">
    <div className="chat-toolbar">
      <div><h2>Chat</h2><p className="chat-subtitle">Current conversation is kept only for this session.</p></div>
      <button onClick={()=>controller.clear()} disabled={snapshot.sending||snapshot.messages.length===0}>Clear</button>
    </div>
    <div className="message-list" aria-live="polite">
      {snapshot.messages.length===0&&<div className="empty-chat">Write a message to start the conversation.</div>}
      {snapshot.messages.map((message,index)=>
        <article className={"chat-message "+message.role} key={message.id??"message-"+index}>
          <div className="message-author">{message.role==="user"?"You":"Nova"}</div>
          <div className="message-content">{message.content}</div>
        </article>
      )}
      {snapshot.sending&&<article className="chat-message assistant pending"><div className="message-author">Nova</div><div className="message-content">Thinking…</div></article>}
      <div ref={bottomRef}/>
    </div>
    <form className="chat-composer" onSubmit={event=>{event.preventDefault();if(!snapshot.sending)void send()}}>
      <textarea value={input} onChange={event=>setInput(event.target.value)} onKeyDown={onKeyDown} placeholder="Write a message…" aria-label="Chat message" disabled={snapshot.sending} rows={2}/>
      <button type="submit" disabled={snapshot.sending||input.trim().length===0}>{snapshot.sending?"Sending…":"Send"}</button>
    </form>
    <p className="chat-hint">Enter to send · Shift+Enter for a new line</p>
    {snapshot.error&&<div className="chat-error" role="alert">{snapshot.error}</div>}
  </section>;
}

function SettingsView({
  runtime,host,configuration,setConfiguration,credentialSaved,apiKey,setApiKey,settingsMessage,saving,testing,onSave,onTest,onRemoveCredential
}:{
  runtime:RuntimeDiagnostics;host:HostDiagnostics;configuration:ProviderConfiguration;setConfiguration:React.Dispatch<React.SetStateAction<ProviderConfiguration>>;
  credentialSaved:boolean;apiKey:string;setApiKey:React.Dispatch<React.SetStateAction<string>>;settingsMessage:string;saving:boolean;testing:boolean;
  onSave:()=>Promise<void>;onTest:()=>Promise<void>;onRemoveCredential:()=>Promise<void>;
}){
  return <div className="settings-grid">
    <section>
      <h2>Provider settings</h2>
      <label>Provider type
        <select value={configuration.providerId} onChange={e=>setConfiguration(c=>({...c,providerId:e.target.value}))}><option value="openai-compatible">OpenAI-compatible</option></select>
      </label>
      <label className="checkbox">Enabled
        <input type="checkbox" checked={configuration.enabled} onChange={e=>setConfiguration(c=>({...c,enabled:e.target.checked}))}/>
      </label>
      <label>Base URL
        <input value={configuration.baseUrl} onChange={e=>setConfiguration(c=>({...c,baseUrl:e.target.value}))} placeholder="https://host.example/v1"/>
      </label>
      <label>Model
        <input value={configuration.model} onChange={e=>setConfiguration(c=>({...c,model:e.target.value}))} placeholder="model-id"/>
      </label>
      <label>Timeout (ms)
        <input type="number" min="1" value={configuration.timeoutMs??30000} onChange={e=>setConfiguration(c=>({...c,timeoutMs:Number(e.target.value)}))}/>
      </label>
      <label>API key
        <input type="password" autoComplete="off" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={credentialSaved?"Saved credential":"Enter API key"}/>
      </label>
      <div className="actions">
        <button onClick={()=>void onSave()} disabled={saving}>{saving?"Saving…":"Save"}</button>
        <button onClick={()=>void onTest()} disabled={testing||!credentialSaved||!configuration.enabled}>{testing?"Testing…":"Test provider"}</button>
        <button onClick={()=>void onRemoveCredential()} disabled={!credentialSaved}>Remove stored credential</button>
      </div>
      {credentialSaved&&<small>Saved credential</small>}
      {settingsMessage&&<div className="notice" role="status">{settingsMessage}</div>}
      <p className="hint">The saved API key is never loaded back into the settings UI.</p>
    </section>

    <section>
      <h2>Runtime</h2>
      <div className="status-grid"><span>Runtime</span><strong>{runtime.runtimeStatus}</strong><span>Core</span><strong>{runtime.coreStatus}</strong><span>Host IPC</span><strong>{host.status} · {host.runtime}</strong></div>
    </section>

    <section>
      <h2>Providers</h2>
      {runtime.providers.length===0?<div>No providers in current runtime.</div>:runtime.providers.map(p=>
        <div className="row" key={p.id}><span>{p.id}</span><span>{p.health?.status??"unknown"}</span></div>
      )}
    </section>

    <section>
      <h2>Recent errors</h2>
      {runtime.recentErrors.length===0?<div>None</div>:runtime.recentErrors.map((error,index)=>
        <div className="error" key={error.timestamp+error.code+index}><code>{error.code}</code> · {error.message}</div>
      )}
    </section>
  </div>;
}

function App(){
  const [view,setView]=React.useState<"chat"|"settings">("chat");
  const [runtime,setRuntime]=React.useState<RuntimeDiagnostics>(preview);
  const [host,setHost]=React.useState<HostDiagnostics>({status:"starting",runtime:"unknown",capabilities:[]});
  const [configuration,setConfiguration]=React.useState<ProviderConfiguration>(defaultConfiguration());
  const [credentialSaved,setCredentialSaved]=React.useState(false);
  const [apiKey,setApiKey]=React.useState("");
  const [settingsMessage,setSettingsMessage]=React.useState("");
  const [saving,setSaving]=React.useState(false);
  const [testing,setTesting]=React.useState(false);
  const foundationRef=React.useRef<FoundationRuntime|undefined>(undefined);
  const conversationRef=React.useRef<ConversationSession|null>(null);
  const controllerRef=React.useRef<ChatSessionController|null>(null);

  if(!conversationRef.current)conversationRef.current=new ConversationSession(crypto.randomUUID());
  if(!controllerRef.current){
    controllerRef.current=new ChatSessionController(conversationRef.current,{
      chat:request=>{
        const foundation=foundationRef.current;
        if(!foundation)return Promise.reject(new Error("Chat runtime is not available."));
        return foundation.chat(request);
      }
    });
  }

  const chatController=controllerRef.current;
  const credentialStore=React.useMemo(()=>new IpcCredentialStore(invoke),[]);
  const configurationStore=React.useMemo(()=>new IpcProviderConfigurationStore(invoke),[]);

  const refreshRuntime=React.useCallback(async(config:ProviderConfiguration|undefined)=>{
    await foundationRef.current?.stop();
    const next=await startFoundationRuntime({providerConfiguration:config,credentialStore});
    foundationRef.current=next;
    setRuntime(await publishAndReadRuntimeDiagnostics(await next.diagnostics()));
  },[credentialStore]);

  React.useEffect(()=>{
    let active=true;
    let timer:ReturnType<typeof setInterval>|undefined;
    (async()=>{
      try{
        const saved=await configurationStore.load();
        if(!active)return;
        if(saved)setConfiguration(saved);
        const reference=saved?.credentialReference??credentialReference;
        if(saved||reference)setCredentialSaved(await credentialStore.exists(reference));
        await refreshRuntime(saved);
        if(!active)return;
        const hostSnapshot=await loadHost();
        if(active)setHost(hostSnapshot);

        const sync=async()=>{
          const foundation=foundationRef.current;
          if(!foundation||!active)return;
          try{
            const snapshot=await foundation.diagnostics();
            const live=await publishAndReadRuntimeDiagnostics(snapshot);
            if(active)setRuntime(live);
          }catch{
            if(active)setRuntime(current=>({...current,runtimeStatus:"error",coreStatus:"error"}));
          }
        };
        await sync();
        timer=setInterval(()=>{void sync()},1000);
      }catch{
        if(active)setRuntime({...preview,runtimeStatus:"error",coreStatus:"error"});
      }
    })();
    return ()=>{
      active=false;
      if(timer)clearInterval(timer);
      void foundationRef.current?.stop();
      foundationRef.current=undefined;
    };
  },[configurationStore,credentialStore,refreshRuntime]);

  const save=async()=>{
    setSettingsMessage("");
    const validation=validateProviderConfiguration(configuration);
    if(!validation.valid){setSettingsMessage(validation.errors.join(" "));return}
    setSaving(true);
    try{
      if(apiKey.length>0)await credentialStore.setSecret(configuration.credentialReference!,apiKey);
      const hasCredential=await credentialStore.exists(configuration.credentialReference!);
      if(configuration.enabled&&!hasCredential){setSettingsMessage("Save an API credential before enabling the provider.");return}
      await configurationStore.save(configuration);
      setApiKey("");
      setCredentialSaved(hasCredential);
      await refreshRuntime(configuration);
      setSettingsMessage("Provider configuration saved.");
    }catch(error){
      setSettingsMessage(error instanceof Error?error.message:"Provider configuration could not be saved.");
    }finally{setSaving(false)}
  };

  const removeCredential=async()=>{
    setSettingsMessage("");
    try{
      if(!configuration.credentialReference){setSettingsMessage("No credential reference is configured.");return}
      await credentialStore.deleteSecret(configuration.credentialReference);
      const disabled={...configuration,enabled:false};
      await configurationStore.save(disabled);
      setConfiguration(disabled);
      setCredentialSaved(false);
      setApiKey("");
      await refreshRuntime(disabled);
      setSettingsMessage("Stored credential removed and real provider disabled.");
    }catch(error){
      setSettingsMessage(error instanceof Error?error.message:"Credential removal failed.");
    }
  };

  const test=async()=>{
    setSettingsMessage("");
    setTesting(true);
    try{
      const result=await testProviderConfiguration(configuration,credentialStore);
      setSettingsMessage(resultLabel(result)+(result.message?" · "+result.message:""));
    }catch(error){
      setSettingsMessage(error instanceof Error?error.message:"Provider connection test failed.");
    }finally{setTesting(false)}
  };

  return <main className="app-shell">
    <header className="app-header">
      <div><h1>Nova</h1><p>AI Companion</p></div>
      <nav className="app-nav" aria-label="Primary">
        <button className={view==="chat"?"nav-button active":"nav-button"} onClick={()=>setView("chat")}>Chat</button>
        <button className={view==="settings"?"nav-button active":"nav-button"} onClick={()=>setView("settings")}>Settings</button>
      </nav>
    </header>
    {view==="chat"
      ?<ChatView controller={chatController} runtime={foundationRef.current}/>
      :<SettingsView
        runtime={runtime} host={host} configuration={configuration} setConfiguration={setConfiguration} credentialSaved={credentialSaved}
        apiKey={apiKey} setApiKey={setApiKey} settingsMessage={settingsMessage} saving={saving} testing={testing}
        onSave={save} onTest={test} onRemoveCredential={removeCredential}
      />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
