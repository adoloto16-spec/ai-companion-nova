import React from "react";
import {createRoot} from "react-dom/client";
import {invoke} from "@tauri-apps/api/core";
import "./styles.css";

type D={status:string;runtime:string;modules:{id:string;state:string;health:string}[]};
const fallback:D={status:"browser-preview",runtime:"typescript mock",modules:[
  {id:"character.fake",state:"running",health:"healthy"},
  {id:"memory.fake",state:"running",health:"healthy"},
  {id:"browser.fake",state:"running",health:"healthy"}
]};
async function load():Promise<D>{try{return await invoke<D>("get_diagnostics");}catch{return fallback;}}
function App(){
  const [d,setD]=React.useState(fallback);
  React.useEffect(()=>{load().then(setD);},[]);
  return <main className="shell"><h1>AI Companion Nova</h1><p>Foundation diagnostics</p>
    <section><b>Status</b><div>{d.status}</div><b>Runtime</b><div>{d.runtime}</div></section>
    <section><b>Modules</b>{d.modules.map(m=><div className="row" key={m.id}><span>{m.id}</span><span>{m.state} · {m.health}</span></div>)}</section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
