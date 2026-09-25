import React from "react";
import {createRoot} from "react-dom/client";
import {invoke} from "@tauri-apps/api/core";
import {startFoundationRuntime,type RuntimeDiagnostics} from "../../../runtime/bootstrap/src/index";
import "./styles.css";

type HostDiagnostics={status:string;runtime:string;capabilities:string[]};
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

function App(){
  const [runtime,setRuntime]=React.useState<RuntimeDiagnostics>(preview);
  const [host,setHost]=React.useState<HostDiagnostics>({status:"starting",runtime:"unknown",capabilities:[]});

  React.useEffect(()=>{
    let active=true;
    let foundation:Awaited<ReturnType<typeof startFoundationRuntime>>|undefined;
    (async()=>{
      try{
        foundation=await startFoundationRuntime();
        const [snapshot,hostSnapshot]=await Promise.all([foundation.diagnostics(),loadHost()]);
        if(active){setRuntime(snapshot);setHost(hostSnapshot);}
      }catch(error){
        if(active)setRuntime({...preview,runtimeStatus:"error",coreStatus:"error",recentErrors:[{
          timestamp:new Date().toISOString(),source:"desktop-ui",code:"BOOTSTRAP_FAILED",
          message:error instanceof Error?error.message:String(error)
        }]});
      }
    })();
    return ()=>{active=false;void foundation?.stop();};
  },[]);

  return <main className="shell">
    <h1>AI Companion Nova</h1>
    <p>Foundation diagnostics</p>
    <section><b>Runtime</b><div>{runtime.runtimeStatus}</div><b>Core</b><div>{runtime.coreStatus}</div></section>
    <section><b>Host IPC</b><div>{host.status} · {host.runtime}</div></section>
    <section><b>Modules</b>{runtime.modules.length===0?<div>No modules in current runtime.</div>:runtime.modules.map(m=>
      <div className="row" key={m.id}><span>{m.id}</span><span>{m.state} · {m.health?.status??"unknown"}</span></div>
    )}</section>
    <section><b>Providers</b>{runtime.providers.length===0?<div>No providers in current runtime.</div>:runtime.providers.map(p=>
      <div className="row" key={p.id}><span>{p.id}</span><span>{p.health?.status??"unknown"}</span></div>
    )}</section>
    <section><b>Recent errors</b>{runtime.recentErrors.length===0?<div>None</div>:runtime.recentErrors.map((error,index)=>
      <div className="error" key={error.timestamp+error.code+index}><code>{error.code}</code> · {error.message}</div>
    )}</section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
