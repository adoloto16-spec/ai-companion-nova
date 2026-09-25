import React from "react";
import {createRoot} from "react-dom/client";
import {invoke} from "@tauri-apps/api/core";
import {
  startFoundationRuntime,
  testProviderConfiguration,
  validateProviderConfiguration,
  type FoundationRuntime
} from "../../../runtime/bootstrap/src/index";
import {IpcCredentialStore} from "../../../host/credentials/src/index";
import {IpcProviderConfigurationStore} from "../../../host/config/src/index";
import {
  PROVIDER_CONFIGURATION_API_VERSION,
  PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  type ProviderConfiguration,
  type ProviderConnectionTestResult,
  type RuntimeDiagnostics
} from "../../../contracts/src/index";
import "./styles.css";

type HostDiagnostics={status:string;runtime:string;capabilities:string[]};

const credentialReference={
  id:"provider.openai-compatible.default",
  kind:"api-key",
  provider:"openai-compatible"
} as const;

const defaultConfiguration=():ProviderConfiguration=>({
  apiVersion:PROVIDER_CONFIGURATION_API_VERSION,
  schemaVersion:PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  providerId:"openai-compatible",
  enabled:false,
  baseUrl:"https://api.openai.com/v1",
  model:"",
  credentialReference,
  timeoutMs:30000
});

const preview:RuntimeDiagnostics={
  schemaVersion:"1",
  timestamp:new Date().toISOString(),
  runtimeStatus:"stopped",
  coreStatus:"stopped",
  modules:[],
  providers:[],
  recentErrors:[],
  capabilities:[]
};

async function loadHost():Promise<HostDiagnostics>{
  try{return await invoke<HostDiagnostics>("get_host_diagnostics");}
  catch{return {status:"browser-preview",runtime:"host-unavailable",capabilities:[]};}
}

async function publishAndReadRuntimeDiagnostics(snapshot:RuntimeDiagnostics):Promise<RuntimeDiagnostics>{
  try{
    await invoke("set_runtime_diagnostics",{diagnostics:snapshot});
    const live=await invoke<RuntimeDiagnostics|null>("get_runtime_diagnostics");
    return live??snapshot;
  }catch{return snapshot;}
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

function App(){
  const [runtime,setRuntime]=React.useState<RuntimeDiagnostics>(preview);
  const [host,setHost]=React.useState<HostDiagnostics>({status:"starting",runtime:"unknown",capabilities:[]});
  const [configuration,setConfiguration]=React.useState<ProviderConfiguration>(defaultConfiguration());
  const [credentialSaved,setCredentialSaved]=React.useState(false);
  const [apiKey,setApiKey]=React.useState("");
  const [message,setMessage]=React.useState("");
  const [testing,setTesting]=React.useState(false);
  const [saving,setSaving]=React.useState(false);
  const foundationRef=React.useRef<FoundationRuntime|undefined>(undefined);

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
        if(saved||reference){
          setCredentialSaved(await credentialStore.exists(reference));
        }
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
          }catch(error){
            if(active)setRuntime(current=>({...current,runtimeStatus:"error",coreStatus:"error",recentErrors:[{
              timestamp:new Date().toISOString(),
              source:"desktop-ui",
              code:"DIAGNOSTICS_FAILED",
              message:error instanceof Error?error.message:String(error)
            },...current.recentErrors].slice(0,20)}));
          }
        };

        await sync();
        timer=setInterval(()=>{void sync();},1000);
      }catch(error){
        if(active)setRuntime({...preview,runtimeStatus:"error",coreStatus:"error",recentErrors:[{
          timestamp:new Date().toISOString(),
          source:"desktop-ui",
          code:"BOOTSTRAP_FAILED",
          message:error instanceof Error?error.message:String(error)
        }]});
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
    setMessage("");
    const validation=validateProviderConfiguration(configuration);
    if(!validation.valid){setMessage(validation.errors.join(" "));return;}
    setSaving(true);
    try{
      if(apiKey.length>0)await credentialStore.setSecret(configuration.credentialReference!,apiKey);
      const hasCredential=await credentialStore.exists(configuration.credentialReference!);
      if(configuration.enabled&&!hasCredential){setMessage("Save an API credential before enabling the provider.");return;}
      await configurationStore.save(configuration);
      setApiKey("");
      setCredentialSaved(hasCredential);
      await refreshRuntime(configuration);
      setMessage("Provider configuration saved.");
    }catch(error){
      setMessage(error instanceof Error?error.message:"Provider configuration could not be saved.");
    }finally{setSaving(false);}
  };

  const removeCredential=async()=>{
    setMessage("");
    try{
      if(!configuration.credentialReference){setMessage("No credential reference is configured.");return;}
      await credentialStore.deleteSecret(configuration.credentialReference);
      const disabled={...configuration,enabled:false};
      await configurationStore.save(disabled);
      setConfiguration(disabled);
      setCredentialSaved(false);
      setApiKey("");
      await refreshRuntime(disabled);
      setMessage("Stored credential removed and real provider disabled.");
    }catch(error){
      setMessage(error instanceof Error?error.message:"Credential removal failed.");
    }
  };

  const test=async()=>{
    setMessage("");
    setTesting(true);
    try{
      const result=await testProviderConfiguration(configuration,credentialStore);
      setMessage(resultLabel(result)+(result.message?" · "+result.message:""));
    }catch(error){
      setMessage(error instanceof Error?error.message:"Provider connection test failed.");
    }finally{setTesting(false);}
  };

  return <main className="shell">
    <h1>AI Companion Nova</h1>
    <p>Foundation diagnostics and provider settings</p>

    <section>
      <h2>Provider settings</h2>
      <label>Provider type
        <select value={configuration.providerId} onChange={e=>setConfiguration(c=>({...c,providerId:e.target.value}))}>
          <option value="openai-compatible">OpenAI-compatible</option>
        </select>
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
        <button onClick={()=>void save()} disabled={saving}>{saving?"Saving…":"Save"}</button>
        <button onClick={()=>void test()} disabled={testing||!credentialSaved||!configuration.enabled}>{testing?"Testing…":"Test provider"}</button>
        <button onClick={()=>void removeCredential()} disabled={!credentialSaved}>Remove stored credential</button>
      </div>
      {credentialSaved&&<small>Saved credential</small>}
      {message&&<div className="notice" role="status">{message}</div>}
      <p className="hint">The saved API key is never loaded back into the settings UI.</p>
    </section>

    <section>
      <b>Runtime</b><div>{runtime.runtimeStatus}</div>
      <b>Core</b><div>{runtime.coreStatus}</div>
      <b>Host IPC</b><div>{host.status} · {host.runtime}</div>
    </section>

    <section>
      <b>Providers</b>
      {runtime.providers.length===0?<div>No providers in current runtime.</div>:runtime.providers.map(p=>
        <div className="row" key={p.id}><span>{p.id}</span><span>{p.health?.status??"unknown"}</span></div>
      )}
    </section>

    <section>
      <b>Recent errors</b>
      {runtime.recentErrors.length===0?<div>None</div>:runtime.recentErrors.map((error,index)=>
        <div className="error" key={error.timestamp+error.code+index}><code>{error.code}</code> · {error.message}</div>
      )}
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App/></React.StrictMode>
);
