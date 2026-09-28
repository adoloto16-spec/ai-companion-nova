import React from "react";
import {createRoot} from "react-dom/client";
import {invoke} from "@tauri-apps/api/core";
import {
  ChatSessionController,ConversationSession,type Character,type FoundationRuntime,InMemoryCharacterStore,type RuntimeDiagnostics,
  type CoreBookActivation,type CoreBookEntry
} from "../../../core/src/index";
import {startFoundationRuntime,testProviderConfiguration,validateProviderConfiguration,listProviderModels} from "../../../runtime/bootstrap/src/index";
import {IpcCredentialStore,InMemoryCredentialStore} from "../../../host/credentials/src/index";
import {IpcCredentialProfileStore,InMemoryCredentialProfileStore,emptyCredentialProfileState} from "../../../host/credential-profiles/src/index";
import {IpcProviderPresetStore,InMemoryProviderPresetStore,materializeProviderConfiguration,migrateProviderConfiguration,emptyProviderPresetState} from "../../../host/provider-presets/src/index";
import {IpcProviderConfigurationStore,loadProviderConfigurationSafely} from "../../../host/config/src/index";
import {IpcCharacterStore} from "../../../host/characters/src/index";
import {IpcCoreBookStore,InMemoryCoreBookStore} from "../../../host/core-book/src/index";
import {IpcMemoryStore,InMemoryMemoryStore} from "../../../host/memory/src/index";
import {IpcConversationStore,InMemoryConversationStore} from "../../../host/conversations/src/index";
import {IpcModelProfileStore,InMemoryModelProfileStore} from "../../../host/model-profiles/src/index";
import {IpcFullTextRetriever} from "../../../host/retrieval/src/index";
import {
  PROVIDER_CONFIGURATION_API_VERSION,PROVIDER_CONFIGURATION_SCHEMA_VERSION,
  type ProviderConfiguration, type ProviderConnectionTestResult, type Conversation, defaultConversationId,
  type ModelProfile, defaultModelProfile, type CredentialProfile, type CredentialProfileStoreState,
  type ProviderPreset, type ProviderPresetStoreState, type ModelInfo
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
function safeErrorMessage(error:unknown,fallback="Unknown error"):string{
  const extract=(value:unknown):string|undefined=>{
    if(value instanceof Error)return value.message;
    if(typeof value==="string")return value;
    if(value&&typeof value==="object"){
      const record=value as Record<string,unknown>;
      for(const key of ["message","reason","error"]){
        const nested=record[key];
        if(typeof nested==="string"&&nested.trim())return nested;
        if(nested&&typeof nested==="object"){
          const nestedRecord=nested as Record<string,unknown>;
          for(const nestedKey of ["message","reason"]){
            const nestedMessage=nestedRecord[nestedKey];
            if(typeof nestedMessage==="string"&&nestedMessage.trim())return nestedMessage;
          }
        }
      }
    }
    return undefined;
  };
  const message=extract(error)??fallback;
  const normalized=message
    .replace(/\s+/g," ")
    .trim()
    .replace(/\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g,"[path]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi,"Bearer [redacted]");
  return (normalized||fallback).slice(0,512);
}
function safeStartupError(error:unknown):string{
  return safeErrorMessage(error,"Unknown startup error");
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

function ChatView({controller,runtime,character,onPersist,onClear}:{
  controller:ChatSessionController;
  runtime:FoundationRuntime;
  character:Character;
  onPersist:()=>Promise<void>;
  onClear:()=>Promise<void>;
}){
  const [snapshot,setSnapshot]=React.useState(()=>controller.getSnapshot());
  const [input,setInput]=React.useState("");
  const [persistenceError,setPersistenceError]=React.useState("");
  const bottomRef=React.useRef<HTMLDivElement|null>(null);

  React.useEffect(()=>controller.subscribe(setSnapshot),[controller]);
  React.useEffect(()=>{bottomRef.current?.scrollIntoView({block:"end"})},[snapshot.messages.length,snapshot.sending]);

  const send=React.useCallback(async()=>{
    setPersistenceError("");
    const result=await controller.submit(input,runtime.getActiveChatModel());
    if(result.status!=="rejected")setInput("");
    if(result.status==="sent"){
      try{await onPersist();}
      catch(error){setPersistenceError(error instanceof Error?error.message:"Conversation could not be saved.");}
    }
  },[controller,input,runtime,onPersist]);

  const clear=React.useCallback(async()=>{
    setPersistenceError("");
    try{await onClear();}
    catch(error){setPersistenceError(error instanceof Error?error.message:"Conversation could not be cleared.");}
  },[onClear]);

  const onKeyDown=(event:React.KeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.key==="Enter"&&!event.shiftKey){
      event.preventDefault();
      if(!snapshot.sending)void send();
    }
  };

  return <section className="chat-panel">
    <div className="chat-toolbar">
      <div><h2>Chat · {character.name}</h2><p className="chat-subtitle">Conversation is persistent and scoped to {character.name}.</p></div>
      <button onClick={()=>void clear()} disabled={snapshot.sending||snapshot.messages.length===0}>Clear</button>
    </div>
    <div className="message-list" aria-live="polite">
      {snapshot.messages.length===0&&<div className="empty-chat">Write a message to start the conversation.</div>}
      {snapshot.messages.map((message,index)=>
        <article className={"chat-message "+message.role} key={message.id??"message-"+index}>
          <div className="message-author">{message.role==="user"?"You":character.name}</div>
          <div className="message-content">{message.content}</div>
        </article>
      )}
      {snapshot.sending&&<article className="chat-message assistant pending"><div className="message-author">{character.name}</div><div className="message-content">Thinking…</div></article>}
      <div ref={bottomRef}/>
    </div>
    <form className="chat-composer" onSubmit={event=>{event.preventDefault();if(!snapshot.sending)void send()}}>
      <textarea value={input} onChange={event=>setInput(event.target.value)} onKeyDown={onKeyDown} placeholder="Write a message…" aria-label="Chat message" disabled={snapshot.sending} rows={2}/>
      <button type="submit" disabled={snapshot.sending||input.trim().length===0}>{snapshot.sending?"Sending…":"Send"}</button>
    </form>
    <p className="chat-hint">Enter to send · Shift+Enter for a new line</p>
    {snapshot.error&&<div className="chat-error" role="alert">{snapshot.error}</div>}
    {persistenceError&&<div className="chat-error" role="alert">{persistenceError}</div>}
  </section>;
}

function CharactersView({characters,activeCharacter,onSelect,onCreate,onRename,onDelete}:{
  characters:readonly Character[];
  activeCharacter:Character;
  onSelect:(id:string)=>Promise<void>;
  onCreate:(name:string)=>Promise<void>;
  onRename:(id:string,name:string)=>Promise<void>;
  onDelete:(id:string)=>Promise<void>;
}){
  const [newName,setNewName]=React.useState("");
  const [renameName,setRenameName]=React.useState(activeCharacter.name);
  const [busy,setBusy]=React.useState(false);
  const [message,setMessage]=React.useState("");
  React.useEffect(()=>setRenameName(activeCharacter.name),[activeCharacter.id,activeCharacter.name]);

  const run=async(action:()=>Promise<void>,success:string)=>{
    setBusy(true);setMessage("");
    try{await action();setMessage(success)}
    catch(error){setMessage(error instanceof Error?error.message:"Character operation failed.")}
    finally{setBusy(false)}
  };

  return <section className="characters-panel">
    <div className="characters-toolbar">
      <div><h2>Characters</h2><p className="chat-subtitle">Character identity and lifecycle only.</p></div>
      <strong>Active: {activeCharacter.name}</strong>
    </div>

    <div className="character-list" role="listbox" aria-label="Characters">
      {characters.map(character=>
        <button key={character.id}
          className={character.id===activeCharacter.id?"character-row active":"character-row"}
          onClick={()=>void run(()=>onSelect(character.id),"Active character changed.")}
          disabled={busy||character.id===activeCharacter.id||!character.enabled}>
          <span>{character.id===activeCharacter.id?"★ ":""}{character.name}</span>
          <small>{character.enabled?"Enabled":"Disabled"}</small>
        </button>
      )}
    </div>

    <div className="character-actions">
      <h3>New Character</h3>
      <form onSubmit={event=>{event.preventDefault();if(newName.trim())void run(async()=>{await onCreate(newName);setNewName("");},"Character created.")}}>
        <input value={newName} onChange={event=>setNewName(event.target.value)} placeholder="Character name" aria-label="New character name" disabled={busy}/>
        <button type="submit" disabled={busy||!newName.trim()}>+ New Character</button>
      </form>
    </div>

    <div className="character-actions">
      <h3>Selected</h3>
      <label>Name
        <input value={renameName} onChange={event=>setRenameName(event.target.value)} aria-label="Selected character name" disabled={busy}/>
      </label>
      <div className="actions">
        <button onClick={()=>void run(()=>onRename(activeCharacter.id,renameName),"Character renamed.")} disabled={busy||renameName.trim()===activeCharacter.name}>Rename</button>
        <button onClick={()=>{if(window.confirm("Delete this character?"))void run(()=>onDelete(activeCharacter.id),"Character deleted.")}} disabled={busy}>Delete</button>
      </div>
      <div className="character-id">characterId: <code>{activeCharacter.id}</code></div>
      {message&&<div className="notice" role="status">{message}</div>}
    </div>
  </section>;
}

type CoreBookDraft={
  title:string;
  content:string;
  tags:string;
  activationKind:"always"|"keyword"|"regex";
  keywords:string;
  matchMode:"any"|"all";
  caseSensitive:boolean;
  pattern:string;
  flags:string;
  retentionPriority:number;
  placementWeight:number;
  mutationPolicy:"locked"|"suggest"|"auto";
  enabled:boolean;
  source:"user"|"import"|"system"|"other";
};

const emptyCoreBookDraft=():CoreBookDraft=>({
  title:"",content:"",tags:"",activationKind:"always",keywords:"",matchMode:"any",
  caseSensitive:false,pattern:"",flags:"",retentionPriority:50,placementWeight:50,
  mutationPolicy:"locked",enabled:true,source:"user"
});

function coreBookDraftFromEntry(entry:CoreBookEntry):CoreBookDraft{
  const activation=entry.activation;
  return {
    title:entry.title,
    content:entry.content,
    tags:entry.tags.join(", "),
    activationKind:activation.kind==="always"||activation.kind==="keyword"||activation.kind==="regex"?activation.kind:"always",
    keywords:activation.kind==="keyword"?activation.keywords.join(", "):"",
    matchMode:activation.kind==="keyword"?activation.matchMode:"any",
    caseSensitive:activation.kind==="keyword"?activation.caseSensitive:false,
    pattern:activation.kind==="regex"?activation.pattern:"",
    flags:activation.kind==="regex"?activation.flags:"",
    retentionPriority:entry.retentionPriority,
    placementWeight:entry.placementWeight,
    mutationPolicy:entry.mutationPolicy,
    enabled:entry.enabled,
    source:entry.source
  };
}

function coreBookActivationFromDraft(draft:CoreBookDraft):CoreBookActivation{
  switch(draft.activationKind){
    case "always":return {kind:"always"};
    case "keyword":{
      const keywords=draft.keywords.split(",").map(value=>value.trim()).filter(Boolean);
      return {kind:"keyword",keywords,matchMode:draft.matchMode,caseSensitive:draft.caseSensitive};
    }
    case "regex":return {kind:"regex",pattern:draft.pattern,flags:draft.flags};
  }
}

function CoreBookView({runtime,character}:{runtime:FoundationRuntime;character:Character}){
  const [entries,setEntries]=React.useState<readonly CoreBookEntry[]>([]);
  const [selectedId,setSelectedId]=React.useState<string|null>(null);
  const [draft,setDraft]=React.useState<CoreBookDraft>(()=>emptyCoreBookDraft());
  const [busy,setBusy]=React.useState(false);
  const [message,setMessage]=React.useState("");

  const refresh=React.useCallback(async()=>{
    const list=await runtime.listCoreBookEntries(character.id);
    setEntries(list);
    setSelectedId(current=>current&&list.some(entry=>entry.id===current)?current:null);
  },[character.id,runtime]);

  React.useEffect(()=>{
    setDraft(emptyCoreBookDraft());
    setSelectedId(null);
    setMessage("");
    void refresh().catch(error=>setMessage(error instanceof Error?error.message:"Core Book could not be loaded."));
  },[character.id,refresh]);

  React.useEffect(()=>{
    if(!selectedId)return;
    const selected=entries.find(entry=>entry.id===selectedId);
    if(selected)setDraft(coreBookDraftFromEntry(selected));
  },[entries,selectedId]);

  const updateDraft=<K extends keyof CoreBookDraft>(key:K,value:CoreBookDraft[K])=>{
    setDraft(current=>({...current,[key]:value}));
  };

  const createNew=()=>{
    setSelectedId(null);
    setDraft(emptyCoreBookDraft());
    setMessage("");
  };

  const save=async()=>{
    setBusy(true);setMessage("");
    try{
      const activation=coreBookActivationFromDraft(draft);
      const payload={
        title:draft.title,content:draft.content,tags:draft.tags.split(",").map(value=>value.trim()).filter(Boolean),
        activation,retentionPriority:draft.retentionPriority,placementWeight:draft.placementWeight,
        mutationPolicy:draft.mutationPolicy,enabled:draft.enabled,source:draft.source
      };
      if(selectedId)await runtime.updateCoreBookEntry(character.id,selectedId,payload);
      else{
        const created=await runtime.createCoreBookEntry(character.id,payload);
        setSelectedId(created.id);
      }
      await refresh();
      setMessage(selectedId?"Core Book entry updated.":"Core Book entry created.");
    }catch(error){
      setMessage(error instanceof Error?error.message:"Core Book operation failed.");
    }finally{setBusy(false)}
  };

  const toggleEnabled=async(entry:CoreBookEntry)=>{
    setBusy(true);setMessage("");
    try{
      await runtime.setCoreBookEntryEnabled(character.id,entry.id,!entry.enabled);
      await refresh();
      setMessage(!entry.enabled?"Core Book entry enabled.":"Core Book entry disabled.");
    }catch(error){
      setMessage(error instanceof Error?error.message:"Core Book enable/disable failed.");
    }finally{setBusy(false)}
  };

  const deleteEntry=async()=>{
    if(!selectedId)return;
    if(!window.confirm("Delete this Core Book entry?"))return;
    setBusy(true);setMessage("");
    try{
      await runtime.deleteCoreBookEntry(character.id,selectedId);
      createNew();
      await refresh();
      setMessage("Core Book entry deleted.");
    }catch(error){
      setMessage(error instanceof Error?error.message:"Core Book deletion failed.");
    }finally{setBusy(false)}
  };

  const selected=selectedId?entries.find(entry=>entry.id===selectedId):undefined;

  return <section className="core-book-panel">
    <div className="core-book-toolbar">
      <div><h2>Core Book · {character.name}</h2><p className="chat-subtitle">Canonical lore owned by this Character. Semantic and model search are reserved for future retrieval.</p></div>
      <button onClick={createNew} disabled={busy}>+ New Entry</button>
    </div>

    <div className="core-book-layout">
      <div className="core-book-list" role="listbox" aria-label="Core Book entries">
        {entries.length===0&&<div className="core-book-empty">No Core Book entries yet.</div>}
        {entries.map(entry=>
          <button key={entry.id}
            className={entry.id===selectedId?"core-book-row active":"core-book-row"}
            onClick={()=>setSelectedId(entry.id)}
            disabled={busy}>
            <span><strong>{entry.title}</strong><small>{entry.activation.kind} · {entry.enabled?"Enabled":"Disabled"}</small></span>
            <small>{entry.tags.join(" · ")||"No tags"}</small>
          </button>
        )}
      </div>

      <div className="core-book-editor">
        <div className="core-book-editor-header"><h3>{selected?"Edit entry":"New entry"}</h3>{selected&&<code>{selected.id}</code>}</div>
        <label>Title<input value={draft.title} onChange={event=>updateDraft("title",event.target.value)} disabled={busy}/></label>
        <label>Content<textarea value={draft.content} onChange={event=>updateDraft("content",event.target.value)} disabled={busy} rows={8}/></label>
        <label>Tags<input value={draft.tags} onChange={event=>updateDraft("tags",event.target.value)} placeholder="comma, separated, tags" disabled={busy}/></label>

        <div className="core-book-grid">
          <label>Activation
            <select value={draft.activationKind} onChange={event=>updateDraft("activationKind",event.target.value as CoreBookDraft["activationKind"])} disabled={busy}>
              <option value="always">Always</option>
              <option value="keyword">Keyword</option>
              <option value="regex">Regex</option>
            </select>
          </label>
          <label>Mutation Policy
            <select value={draft.mutationPolicy} onChange={event=>updateDraft("mutationPolicy",event.target.value as CoreBookDraft["mutationPolicy"])} disabled={busy}>
              <option value="locked">Locked</option>
              <option value="suggest">Suggest</option>
              <option value="auto">Auto</option>
            </select>
          </label>
        </div>

        {draft.activationKind==="keyword"&&<div className="core-book-activation-box">
          <label>Keywords<input value={draft.keywords} onChange={event=>updateDraft("keywords",event.target.value)} placeholder="Nova, academy, castle" disabled={busy}/></label>
          <div className="core-book-grid">
            <label>Match
              <select value={draft.matchMode} onChange={event=>updateDraft("matchMode",event.target.value as "any"|"all")} disabled={busy}>
                <option value="any">Any</option><option value="all">All</option>
              </select>
            </label>
            <label className="checkbox"><input type="checkbox" checked={draft.caseSensitive} onChange={event=>updateDraft("caseSensitive",event.target.checked)} disabled={busy}/> Case sensitive</label>
          </div>
        </div>}

        {draft.activationKind==="regex"&&<div className="core-book-activation-box">
          <label>Pattern<input value={draft.pattern} onChange={event=>updateDraft("pattern",event.target.value)} placeholder="\\bNova\\b" disabled={busy}/></label>
          <label>Flags<input value={draft.flags} onChange={event=>updateDraft("flags",event.target.value)} placeholder="i" disabled={busy}/></label>
        </div>}

        <div className="core-book-grid">
          <label>Retention Priority (0–100)<input type="number" min={0} max={100} value={draft.retentionPriority} onChange={event=>updateDraft("retentionPriority",Number(event.target.value))} disabled={busy}/></label>
          <label>Placement Weight (0–100)<input type="number" min={0} max={100} value={draft.placementWeight} onChange={event=>updateDraft("placementWeight",Number(event.target.value))} disabled={busy}/></label>
        </div>

        <div className="core-book-grid">
          <label>Source
            <select value={draft.source} onChange={event=>updateDraft("source",event.target.value as CoreBookDraft["source"])} disabled={busy}>
              <option value="user">User</option><option value="import">Import</option><option value="system">System</option><option value="other">Other</option>
            </select>
          </label>
          <label className="checkbox"><input type="checkbox" checked={draft.enabled} onChange={event=>updateDraft("enabled",event.target.checked)} disabled={busy}/> Enabled</label>
        </div>

        <div className="actions">
          <button onClick={()=>void save()} disabled={busy||draft.title.trim().length===0}>{selected?"Save Entry":"Create Entry"}</button>
          {selected&&<><button onClick={()=>void toggleEnabled(selected)} disabled={busy}>{selected.enabled?"Disable":"Enable"}</button><button onClick={()=>void deleteEntry()} disabled={busy}>Delete</button></>}
        </div>
        {message&&<div className="notice" role="status">{message}</div>}
      </div>
    </div>
  </section>;
}

function ModelProfileView({profile,runtime,onSave}:{profile:ModelProfile;runtime:RuntimeDiagnostics;onSave:(profile:ModelProfile)=>Promise<void>}){
  const [draft,setDraft]=React.useState<ModelProfile>(()=>profile);
  const [busy,setBusy]=React.useState(false);
  const [message,setMessage]=React.useState("");
  React.useEffect(()=>setDraft(profile),[profile.id,profile.characterId,profile.updatedAt]);

  const chatProviders=runtime.providers.filter(provider=>provider.roles.includes("chat"));
  const selectedProviderAvailable=!draft.providerId||chatProviders.some(provider=>provider.id===draft.providerId);

  const updateGeneration=(key:"temperature"|"topP"|"maxTokens",value:string)=>{
    const numeric=value.trim()===""?undefined:Number(value);
    setDraft(current=>({
      ...current,
      generation:{
        ...current.generation,
        ...(numeric===undefined?{}:{[key]:numeric})
      }
    }));
  };

  const save=async()=>{
    setBusy(true);setMessage("");
    try{
      const generation={
        ...(draft.generation.temperature!==undefined?{temperature:draft.generation.temperature}:{}),
        ...(draft.generation.topP!==undefined?{topP:draft.generation.topP}:{}),
        ...(draft.generation.maxTokens!==undefined?{maxTokens:draft.generation.maxTokens}:{}),
        ...(draft.generation.responseFormat!==undefined?{responseFormat:draft.generation.responseFormat}:{}),
      };
      const next:ModelProfile={
        ...draft,
        ...(draft.providerId?.trim()?{providerId:draft.providerId.trim()}:{}),
        ...(draft.model?.trim()?{model:draft.model.trim()}:{}),
        generation,
        updatedAt:new Date().toISOString()
      };
      if(!selectedProviderAvailable)throw new Error("Selected provider is not currently registered.");
      await onSave(next);
      setMessage("Model Profile saved.");
    }catch(error){
      setMessage("Model Profile could not be saved: "+safeErrorMessage(error));
    }finally{setBusy(false)}
  };

  return <section className="settings-grid">
    <section>
      <h2>Model Profile</h2>
      <p className="chat-subtitle">Character-scoped request preferences. Provider credentials and base URLs remain global.</p>
      <label>Provider
        <select
          value={draft.providerId??""}
          onChange={event=>setDraft(current=>({...current,providerId:event.target.value||undefined}))}
          disabled={busy}>
          <option value="">Use active/default provider</option>
          {!selectedProviderAvailable&&draft.providerId&&<option value={draft.providerId} disabled>Unavailable: {draft.providerId}</option>}
          {chatProviders.map(provider=><option key={provider.id} value={provider.id}>{provider.id}</option>)}
        </select>
      </label>
      <label>Model
        <input
          value={draft.model??""}
          onChange={event=>setDraft(current=>({...current,model:event.target.value||undefined}))}
          placeholder={draft.providerId?"Provider default model":"Current runtime model"}
          disabled={busy}/>
      </label>
      <div className="core-book-grid">
        <label>Temperature
          <input
            type="number" min="0" max="2" step="0.01"
            value={draft.generation.temperature??""}
            onChange={event=>updateGeneration("temperature",event.target.value)}
            placeholder="Runtime default"
            disabled={busy}/>
        </label>
        <label>Top P
          <input
            type="number" min="0" max="1" step="0.01"
            value={draft.generation.topP??""}
            onChange={event=>updateGeneration("topP",event.target.value)}
            placeholder="Runtime default"
            disabled={busy}/>
        </label>
      </div>
      <label>Max Tokens
        <input
          type="number" min="1" step="1"
          value={draft.generation.maxTokens??""}
          onChange={event=>updateGeneration("maxTokens",event.target.value)}
          placeholder="Runtime default"
          disabled={busy}/>
      </label>
      <div className="actions"><button onClick={()=>void save()} disabled={busy}>{busy?"Saving…":"Save Model Profile"}</button></div>
      {message&&<div className="notice" role="status">{message}</div>}
      <p className="hint">No API keys, credentials or base URLs are stored here.</p>
    </section>
    <section>
      <h2>Available chat providers</h2>
      {chatProviders.length===0?<div>No registered chat providers.</div>:chatProviders.map(provider=>
        <div className="row" key={provider.id}><span>{provider.id}</span><span>{provider.health?.status??"unknown"}</span></div>
      )}
    </section>
  </section>;
}

function slugId(value:string):string{
  const slug=value.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,48);
  return slug||"credential";
}
function blankProviderPreset():ProviderPreset{
  const now=new Date().toISOString();
  return {
    id:"provider-preset:new-"+Date.now(),
    name:"",
    providerId:"openai-compatible",
    baseUrl:"https://api.openai.com/v1",
    createdAt:now,
    updatedAt:now
  };
}
function ProviderPresetsView({
  presets,activePresetId,credentialProfiles,credentialSaved,
  runtime,onSavePreset,onActivatePreset,onDeletePreset,onCreateCredential,onDeleteCredential,onRefreshModels,onTestPreset
}:{
  presets:readonly ProviderPreset[];
  activePresetId:string|null;
  credentialProfiles:readonly CredentialProfile[];
  credentialSaved:Record<string,boolean>;
  runtime:RuntimeDiagnostics;
  onSavePreset:(preset:ProviderPreset,activate:boolean)=>Promise<void>;
  onActivatePreset:(id:string)=>Promise<void>;
  onDeletePreset:(id:string)=>Promise<void>;
  onCreateCredential:(label:string,secret:string)=>Promise<CredentialProfile>;
  onDeleteCredential:(id:string)=>Promise<void>;
  onRefreshModels:(preset:ProviderPreset)=>Promise<readonly ModelInfo[]>;
  onTestPreset:(preset:ProviderPreset)=>Promise<ProviderConnectionTestResult>;
}){
  const [selectedId,setSelectedId]=React.useState<string|undefined>(presets.find(p=>p.id===activePresetId)?.id??presets[0]?.id);
  const selected=presets.find(p=>p.id===selectedId);
  const [draft,setDraft]=React.useState<ProviderPreset>(()=>selected??blankProviderPreset());
  const [models,setModels]=React.useState<readonly ModelInfo[]>([]);
  const [customModel,setCustomModel]=React.useState(true);
  const [busy,setBusy]=React.useState(false);
  const [message,setMessage]=React.useState("");
  const [credentialChoice,setCredentialChoice]=React.useState(draft.credentialProfileId??"");
  const [newCredentialLabel,setNewCredentialLabel]=React.useState("");
  const [newCredentialSecret,setNewCredentialSecret]=React.useState("");

  React.useEffect(()=>{
    const next=presets.find(p=>p.id===selectedId)??presets[0];
    if(next){
      setSelectedId(next.id);
      setDraft({...next});
      setCredentialChoice(next.credentialProfileId??"");
      setCustomModel(true);
      setModels([]);
    }else{
      setDraft(blankProviderPreset());
      setCredentialChoice("");
      setModels([]);
    }
  },[selectedId,presets]);

  React.useEffect(()=>{
    if(draft.model&&models.length>0)setCustomModel(!models.some(model=>model.id===draft.model));
    else setCustomModel(true);
  },[draft.model,models]);

  const active=activePresetId===draft.id;
  const credentialInUseCount=(id:string)=>presets.filter(p=>p.credentialProfileId===id).length;

  const refresh=async()=>{
    setBusy(true);setMessage("");
    try{
      const result=await onRefreshModels(draft);
      setModels(result);
      setMessage(result.length>0?"Models refreshed.":"Model discovery unavailable; manual model input is active.");
    }catch(error){setMessage("Model discovery failed: "+safeErrorMessage(error));setModels([])}
    finally{setBusy(false)}
  };

  const save=async(activate:boolean)=>{
    setBusy(true);setMessage("");
    try{
      const next:ProviderPreset={
        ...draft,
        name:draft.name.trim(),
        providerId:"openai-compatible",
        baseUrl:draft.baseUrl.trim(),
        ...(credentialChoice?{credentialProfileId:credentialChoice}:{}),
        ...(draft.model?.trim()?{model:draft.model.trim()}:{}),
        updatedAt:new Date().toISOString()
      };
      if(!next.name)throw new Error("Provider preset name is required.");
      await onSavePreset(next,activate);
      setDraft(next);
      setSelectedId(next.id);
      setMessage(activate?"Provider preset saved and activated.":"Provider preset saved.");
    }catch(error){setMessage("Provider preset could not be saved: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const saveAsNew=async()=>{
    const now=new Date().toISOString();
    const next:ProviderPreset={
      ...draft,
      id:"provider-preset:"+slugId(draft.name||"preset")+":"+Date.now(),
      createdAt:now,
      updatedAt:now
    };
    setDraft(next);
    setSelectedId(next.id);
    await (async()=>{
      setBusy(true);setMessage("");
      try{
        await onSavePreset(next,false);
        setMessage("Provider preset saved as new preset.");
      }catch(error){setMessage("Provider preset could not be saved: "+safeErrorMessage(error))}
      finally{setBusy(false)}
    })();
  };

  const activate=async()=>{
    if(!selectedId)return;
    setBusy(true);setMessage("");
    try{await onActivatePreset(selectedId);setMessage("Provider preset activated.");}
    catch(error){setMessage("Provider preset could not be activated: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const removePreset=async()=>{
    if(!selectedId)return;
    if(!window.confirm("Delete this provider preset?"))return;
    setBusy(true);setMessage("");
    try{await onDeletePreset(selectedId);setMessage("Provider preset deleted.");}
    catch(error){setMessage("Provider preset could not be deleted: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const createCredential=async()=>{
    setBusy(true);setMessage("");
    try{
      if(!newCredentialLabel.trim()||!newCredentialSecret)throw new Error("Credential label and API key are required.");
      const profile=await onCreateCredential(newCredentialLabel.trim(),newCredentialSecret);
      setCredentialChoice(profile.id);
      setNewCredentialLabel("");
      setNewCredentialSecret("");
      setMessage("Credential saved. The API key is no longer displayed.");
    }catch(error){setMessage("Credential could not be saved: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const deleteCredential=async(id:string)=>{
    const used=credentialInUseCount(id);
    if(used>0){
      setMessage("Credential is used by "+used+" provider preset"+(used===1?"":"s")+". Reassign the preset before deletion.");
      return;
    }
    if(!window.confirm("Delete this saved credential?"))return;
    setBusy(true);setMessage("");
    try{await onDeleteCredential(id);if(credentialChoice===id)setCredentialChoice("");setMessage("Credential removed.");}
    catch(error){setMessage("Credential could not be removed: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const selectedCredential=credentialProfiles.find(profile=>profile.id===credentialChoice);
  const discoveredModelMode=draft.model&&models.some(model=>model.id===draft.model)?"known":"custom";
  const modelMode=models.length>0?(customModel||discoveredModelMode==="custom"?"custom":draft.model??""):"manual";

  return <div className="settings-grid">
    <section>
      <h2>Provider Presets</h2>
      <p className="chat-subtitle">Saved OpenAI-compatible connections. Secrets stay in Windows Credential Manager.</p>
      <label>Active preset
        <select value={activePresetId??""} onChange={event=>event.target.value&&void onActivatePreset(event.target.value)} disabled={busy||presets.length===0}>
          {presets.length===0?<option value="">No saved presets</option>:presets.map(p=><option key={p.id} value={p.id}>{p.name||p.id}</option>)}
        </select>
      </label>
      <label>Preset to edit
        <select value={selectedId??""} onChange={event=>setSelectedId(event.target.value)} disabled={busy||presets.length===0}>
          {presets.length===0?<option value="">Create a preset below</option>:presets.map(p=><option key={p.id} value={p.id}>{p.name||p.id}</option>)}
        </select>
      </label>
      <label>Name
        <input value={draft.name} onChange={e=>setDraft(current=>({...current,name:e.target.value}))} placeholder="Mistral"/>
      </label>
      <label>Provider type
        <select value={draft.providerId} disabled><option value="openai-compatible">OpenAI-compatible</option></select>
      </label>
      <label>Base URL
        <input value={draft.baseUrl} onChange={e=>setDraft(current=>({...current,baseUrl:e.target.value}))} placeholder="https://api.example/v1"/>
      </label>
      <label>API credential
        <select value={credentialChoice} onChange={e=>setCredentialChoice(e.target.value)} disabled={busy}>
          <option value="">No credential / local server</option>
          {credentialProfiles.map(profile=><option key={profile.id} value={profile.id}>{profile.label} {credentialSaved[profile.id]?"••••••••":"(not saved)"}</option>)}
          <option value="__new__">+ Add new credential</option>
        </select>
      </label>
      {credentialChoice==="__new__"&&<div className="character-actions">
        <label>Label
          <input value={newCredentialLabel} onChange={e=>setNewCredentialLabel(e.target.value)} placeholder="Mistral Main"/>
        </label>
        <label>API key
          <input type="password" autoComplete="off" value={newCredentialSecret} onChange={e=>setNewCredentialSecret(e.target.value)} placeholder="Enter API key"/>
        </label>
        <button onClick={()=>void createCredential()} disabled={busy}>Save credential</button>
      </div>}
      {selectedCredential&&<small>Credential: {selectedCredential.label} {credentialSaved[selectedCredential.id]?"••••••••":"not currently saved"}</small>}
      <label>Model
        {models.length>0
          ?<select value={modelMode==="custom"?"__custom__":draft.model??""} onChange={e=>{
            if(e.target.value==="__custom__"){setCustomModel(true);return;}
            setCustomModel(false);
            setDraft(current=>({...current,model:e.target.value||undefined}));
          }} disabled={busy}>
            {draft.model&&models.some(m=>m.id===draft.model)&&<option value={draft.model}>{draft.model}</option>}
            {models.filter(m=>m.id!==draft.model).map(m=><option key={m.id} value={m.id}>{m.displayName&&m.displayName!==m.id?m.displayName+" · "+m.id:m.id}</option>)}
            <option value="__custom__">Custom...</option>
          </select>
          :<input value={draft.model??""} onChange={e=>setDraft(current=>({...current,model:e.target.value||undefined}))} placeholder="model-id"/>}
      </label>
      {(models.length===0||modelMode==="custom")&&<label>Custom model
        <input value={draft.model??""} onChange={e=>setDraft(current=>({...current,model:e.target.value||undefined}))} placeholder="model-id"/>
      </label>}
      <label>Timeout (ms)
        <input type="number" min="1" value={draft.timeoutMs??30000} onChange={e=>setDraft(current=>({...current,timeoutMs:Number(e.target.value)}))}/>
      </label>
      <div className="actions">
        <button onClick={()=>void refresh()} disabled={busy}>Refresh models</button>
        <button onClick={()=>void save(false)} disabled={busy||!draft.name.trim()}>{busy?"Saving…":"Save"}</button>
        <button onClick={()=>void save(true)} disabled={busy||!draft.name.trim()}>Save &amp; activate</button>
        <button onClick={()=>void saveAsNew()} disabled={busy||!draft.name.trim()}>Save as new preset</button>
        {selectedId&&<button onClick={()=>void activate()} disabled={busy||active}>Activate preset</button>}
        {selectedId&&<button onClick={()=>void removePreset()} disabled={busy}>Delete preset</button>}
      </div>
      <div className="actions">
        <button onClick={()=>setDraft({name:"Mistral",id:"provider-preset:mistral:"+Date.now(),providerId:"openai-compatible",baseUrl:"https://api.mistral.ai/v1",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})} disabled={busy}>Starter: Mistral</button>
        <button onClick={()=>setDraft({name:"Groq",id:"provider-preset:groq:"+Date.now(),providerId:"openai-compatible",baseUrl:"https://api.groq.com/openai/v1",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})} disabled={busy}>Starter: Groq</button>
        <button onClick={()=>setDraft({name:"OpenAI",id:"provider-preset:openai:"+Date.now(),providerId:"openai-compatible",baseUrl:"https://api.openai.com/v1",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})} disabled={busy}>Starter: OpenAI</button>
      </div>
      {message&&<div className="notice" role="status">{message}</div>}
      <p className="hint">API keys are never loaded back into UI state from Credential Manager. Only masked saved/not-saved status is shown.</p>
    </section>
    <section>
      <h2>Saved API credentials</h2>
      {credentialProfiles.length===0?<div>No saved credential metadata.</div>:credentialProfiles.map(profile=>
        <div className="row" key={profile.id}>
          <span>{profile.label} {credentialSaved[profile.id]?"••••••••":"(not saved)"}</span>
          <button onClick={()=>void deleteCredential(profile.id)} disabled={busy||credentialInUseCount(profile.id)>0}>Delete</button>
        </div>
      )}
      <h2>Runtime</h2>
      <div className="status-grid"><span>Runtime</span><strong>{runtime.runtimeStatus}</strong><span>Core</span><strong>{runtime.coreStatus}</strong><span>Active</span><strong>{activePresetId??"none"}</strong></div>
    </section>
  </div>;
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

function isTauriRuntime():boolean{
  return typeof window!=="undefined" && Boolean((window as unknown as Record<string,unknown>).__TAURI_INTERNALS__);
}

function materializePresetConfigurations(
  presets:readonly ProviderPreset[],
  profiles:readonly CredentialProfile[]
):readonly {presetId:string;configuration:ProviderConfiguration}[]{
  return presets.map(preset=>{
    const credential=profiles.find(profile=>profile.id===preset.credentialProfileId);
    return {presetId:preset.id,configuration:materializeProviderConfiguration(preset,credential)};
  });
}
function credentialSavedEntries(
  profiles:readonly CredentialProfile[],
  saved:Record<string,boolean>
):Record<string,boolean>{
  return profiles.reduce<Record<string,boolean>>((result,profile)=>{
    result[profile.id]=saved[profile.id]??false;
    return result;
  },{});
}

function App(){
  const [view,setView]=React.useState<"chat"|"characters"|"core-book"|"model-profile"|"settings">("chat");
  const [runtime,setRuntime]=React.useState<RuntimeDiagnostics>(preview);
  const [host,setHost]=React.useState<HostDiagnostics>({status:"starting",runtime:"unknown",capabilities:[]});
  const [configuration,setConfiguration]=React.useState<ProviderConfiguration>(defaultConfiguration());
  const [credentialSaved,setCredentialSaved]=React.useState(false);
  const [apiKey,setApiKey]=React.useState("");
  const [settingsMessage,setSettingsMessage]=React.useState("");
  const [saving,setSaving]=React.useState(false);
  const [testing,setTesting]=React.useState(false);
  const [startupStatus,setStartupStatus]=React.useState<"initializing"|"ready"|"error">("initializing");
  const [startupError,setStartupError]=React.useState("");
  const [characters,setCharacters]=React.useState<readonly Character[]>([]);
  const [activeCharacter,setActiveCharacter]=React.useState<Character|undefined>();
  const [activeModelProfile,setActiveModelProfile]=React.useState<ModelProfile|undefined>();
  const [chatController,setChatController]=React.useState<ChatSessionController|null>(null);
  const foundationRef=React.useRef<FoundationRuntime|undefined>();
  const providerConfigurationErrorRef=React.useRef<string|undefined>();
  const conversationLoadErrorRef=React.useRef<string|undefined>();
  const modelProfileLoadErrorRef=React.useRef<string|undefined>();
  const conversationMetadataRef=React.useRef(new Map<string,{id:string;createdAt:string}>());
  const credentialStore=React.useMemo(()=>new IpcCredentialStore(invoke),[]);
  const configurationStore=React.useMemo(()=>new IpcProviderConfigurationStore(invoke),[]);
  const characterStore=React.useMemo(()=>isTauriRuntime()?new IpcCharacterStore(invoke):new InMemoryCharacterStore(),[]);
  const coreBookStore=React.useMemo(()=>isTauriRuntime()?new IpcCoreBookStore(invoke):new InMemoryCoreBookStore(),[]);
  const memoryStore=React.useMemo(()=>isTauriRuntime()?new IpcMemoryStore(invoke):new InMemoryMemoryStore(),[]);
  const conversationStore=React.useMemo(()=>isTauriRuntime()?new IpcConversationStore(invoke):new InMemoryConversationStore(),[]);
  const modelProfileStore=React.useMemo(()=>isTauriRuntime()?new IpcModelProfileStore(invoke):new InMemoryModelProfileStore(),[]);
  const credentialProfileStore=React.useMemo(()=>isTauriRuntime()?new IpcCredentialProfileStore(invoke):new InMemoryCredentialProfileStore(),[]);
  const providerPresetStore=React.useMemo(()=>isTauriRuntime()?new IpcProviderPresetStore(invoke):new InMemoryProviderPresetStore(),[]);
  const [credentialProfiles,setCredentialProfiles]=React.useState<readonly CredentialProfile[]>([]);
  const [credentialSavedMap,setCredentialSavedMap]=React.useState<Record<string,boolean>>({});
  const [providerPresets,setProviderPresets]=React.useState<readonly ProviderPreset[]>([]);
  const [activePresetId,setActivePresetId]=React.useState<string|null>(null);
  const credentialProfileStateRef=React.useRef<CredentialProfileStoreState>(emptyCredentialProfileState());
  const providerPresetStateRef=React.useRef<ProviderPresetStoreState>(emptyProviderPresetState());
  const retriever=React.useMemo(()=>isTauriRuntime()?new IpcFullTextRetriever(invoke):undefined,[]);

  const controllerForSession=React.useCallback((session:ConversationSession)=>new ChatSessionController(
    session,
    {
      chat:(request,providerPresetId)=>{
        const foundation=foundationRef.current;
        if(!foundation)return Promise.reject(new Error("Chat runtime is not available."));
        return foundation.chat(request,providerPresetId);
      },
      getChatModel:providerId=>{
        const foundation=foundationRef.current;
        if(!foundation)return Promise.reject(new Error("Chat runtime is not available."));
        return foundation.getChatModel(providerId);
      },
      getChatModelForPreset:providerPresetId=>{
        const foundation=foundationRef.current;
        if(!foundation)return Promise.reject(new Error("Chat runtime is not available."));
        return foundation.getChatModelForPreset(providerPresetId);
      },
      getActiveProviderPresetId:()=>{
        return foundationRef.current?.getActiveProviderPresetId();
      }
    },
    {
      contextBuilder:{
        buildContext:request=>{
          const foundation=foundationRef.current;
          if(!foundation)return Promise.reject(new Error("Chat context runtime is not available."));
          return foundation.buildContext(request);
        }
      }
    }
  ),[]);

  const loadConversationSession=React.useCallback(async(characterId:string):Promise<ConversationSession>=>{
    try{
      const stored=await conversationStore.load(characterId);
      if(stored){
        if(stored.characterId!==characterId)throw new Error("Conversation storage character scope mismatch.");
        conversationMetadataRef.current.set(characterId,{id:stored.id,createdAt:stored.createdAt});
        conversationLoadErrorRef.current=undefined;
        const session=new ConversationSession(stored.id,characterId);
        for(const message of stored.messages)session.addMessage(message);
        return session;
      }
      const conversationId=defaultConversationId(characterId);
      conversationMetadataRef.current.set(characterId,{id:conversationId,createdAt:new Date().toISOString()});
      conversationLoadErrorRef.current=undefined;
      return new ConversationSession(conversationId,characterId);
    }catch(error){
      conversationLoadErrorRef.current=safeStartupError(error);
      const conversationId=defaultConversationId(characterId);
      conversationMetadataRef.current.set(characterId,{id:conversationId,createdAt:new Date().toISOString()});
      return new ConversationSession(conversationId,characterId);
    }
  },[conversationStore]);

  const loadModelProfile=React.useCallback(async(characterId:string):Promise<ModelProfile>=>{
    try{
      const stored=await modelProfileStore.load(characterId);
      if(stored){
        if(stored.characterId!==characterId)throw new Error("Model Profile character scope mismatch.");
        modelProfileLoadErrorRef.current=undefined;
        return stored;
      }
      modelProfileLoadErrorRef.current=undefined;
      return defaultModelProfile(characterId);
    }catch(error){
      modelProfileLoadErrorRef.current=safeStartupError(error);
      return defaultModelProfile(characterId);
    }
  },[modelProfileStore]);

  const controllerForCharacter=React.useCallback(async(characterId:string)=>{
    const [session,profile]=await Promise.all([
      loadConversationSession(characterId),
      loadModelProfile(characterId)
    ]);
    const controller=controllerForSession(session);
    controller.setModelProfile(profile);
    return controller;
  },[controllerForSession,loadConversationSession,loadModelProfile]);

  const persistConversation=React.useCallback(async(controller:ChatSessionController)=>{
    const snapshot=controller.getSnapshot();
    const current=conversationMetadataRef.current.get(snapshot.characterId);
    const metadata=current??{id:snapshot.conversationId,createdAt:new Date().toISOString()};
    const conversation:Conversation={
      apiVersion:"1",
      schemaVersion:"1",
      id:metadata.id,
      characterId:snapshot.characterId,
      messages:snapshot.messages,
      createdAt:metadata.createdAt,
      updatedAt:new Date().toISOString()
    };
    await conversationStore.save(conversation);
    conversationMetadataRef.current.set(snapshot.characterId,{id:conversation.id,createdAt:conversation.createdAt});
    conversationLoadErrorRef.current=undefined;
  },[conversationStore]);

  const clearConversation=React.useCallback(async(characterId:string,controller:ChatSessionController)=>{
    await conversationStore.clear(characterId);
    conversationMetadataRef.current.delete(characterId);
    conversationLoadErrorRef.current=undefined;
    controller.clear();
  },[conversationStore]);

  const syncCharacters=React.useCallback(async(runtimeInstance:FoundationRuntime)=>{
    const list=await runtimeInstance.listCharacters();
    const active=await runtimeInstance.getActiveCharacter();
    const controller=await controllerForCharacter(active.id);
    setCharacters(list);
    setActiveCharacter(active);
    setActiveModelProfile(controller.getModelProfile()??defaultModelProfile(active.id));
    setChatController(current=>current?.getSnapshot().characterId===active.id?current:controller);
  },[controllerForCharacter]);

  const addConfigurationLoadError=React.useCallback((diagnostics:RuntimeDiagnostics):RuntimeDiagnostics=>{
    const recentErrors=[...diagnostics.recentErrors];
    const providerMessage=providerConfigurationErrorRef.current;
    const conversationMessage=conversationLoadErrorRef.current;
    const modelProfileMessage=modelProfileLoadErrorRef.current;
    if(providerMessage){
      recentErrors.push({
        timestamp:new Date().toISOString(),
        source:"provider-configuration",
        code:"LOAD_FAILED",
        message:providerMessage
      });
    }
    if(conversationMessage){
      recentErrors.push({
        timestamp:new Date().toISOString(),
        source:"conversation-storage",
        code:"LOAD_FAILED",
        message:conversationMessage
      });
    }
    if(modelProfileMessage){
      recentErrors.push({
        timestamp:new Date().toISOString(),
        source:"model-profile-storage",
        code:"LOAD_FAILED",
        message:modelProfileMessage
      });
    }
    return recentErrors.length===diagnostics.recentErrors.length?diagnostics:{...diagnostics,recentErrors};
  },[]);

  const refreshRuntime=React.useCallback(async(
    config:ProviderConfiguration|undefined,
    configurationLoadError?:string,
    presetState:ProviderPresetStoreState=providerPresetStateRef.current,
    credentialState:CredentialProfileStoreState=credentialProfileStateRef.current
  )=>{
    providerConfigurationErrorRef.current=configurationLoadError;
    providerPresetStateRef.current=presetState;
    credentialProfileStateRef.current=credentialState;
    await foundationRef.current?.stop();
    const next=await startFoundationRuntime({
      providerConfiguration:config,credentialStore,characterStore,coreBookStore,memoryStore,retriever,retrievalIndexWriter:retriever,
      providerPresetConfigurations:materializePresetConfigurations(presetState.presets,credentialState.profiles),
      activeProviderPresetId:presetState.activePresetId??undefined
    });
    foundationRef.current=next;
    setRuntime(await publishAndReadRuntimeDiagnostics(addConfigurationLoadError(await next.diagnostics())));
    await syncCharacters(next);
    setRuntime(await publishAndReadRuntimeDiagnostics(addConfigurationLoadError(await next.diagnostics())));
    setStartupStatus("ready");
    setStartupError("");
  },[addConfigurationLoadError,characterStore,coreBookStore,memoryStore,credentialStore,retriever,syncCharacters]);

  React.useEffect(()=>{
    let active=true;
    setStartupStatus("initializing");setStartupError("");
    let timer:ReturnType<typeof setInterval>|undefined;
    (async()=>{
      try{
        const loaded=await loadProviderConfigurationSafely(configurationStore);
        const legacy=loaded.configuration;
        let credentialState=await credentialProfileStore.load();
        if(!credentialState)credentialState=emptyCredentialProfileState();
        let presetState=await providerPresetStore.load();
        if(!presetState&&legacy){
          const migration=migrateProviderConfiguration(legacy);
          const existing=migration.credentialProfile?credentialState.profiles.find(profile=>profile.credentialReference.id===migration.credentialProfile!.credentialReference.id):undefined;
          credentialState={...credentialState,profiles:[...credentialState.profiles,...(migration.credentialProfile&&!existing?[migration.credentialProfile]:[])]};
          presetState={...emptyProviderPresetState(),presets:[migration.preset],activePresetId:migration.preset.id};
          await credentialProfileStore.save(credentialState);
          await providerPresetStore.save(presetState);
        }
        if(!presetState)presetState=emptyProviderPresetState();
        if(presetState.presets.length>0&&!presetState.activePresetId){
          presetState={...presetState,activePresetId:presetState.presets[0]!.id};
          await providerPresetStore.save(presetState);
        }
        if(legacy)setConfiguration(legacy);
        const savedMap:Record<string,boolean>={};
        for(const profile of credentialState.profiles){
          try{savedMap[profile.id]=await credentialStore.exists(profile.credentialReference)}catch{savedMap[profile.id]=false;}
        }
        const activePreset=presetState.activePresetId?presetState.presets.find(preset=>preset.id===presetState.activePresetId):undefined;
        const activeCredential=activePreset?.credentialProfileId?credentialState.profiles.find(profile=>profile.id===activePreset.credentialProfileId):undefined;
        const activeConfiguration=activePreset?materializeProviderConfiguration(activePreset,activeCredential):undefined;
        setCredentialProfiles(credentialState.profiles);
        setCredentialSavedMap(savedMap);
        setProviderPresets(presetState.presets);
        setActivePresetId(presetState.activePresetId);
        providerPresetStateRef.current=presetState;
        credentialProfileStateRef.current=credentialState;
        if(legacy){
          const legacyProfile=credentialState.profiles.find(profile=>profile.credentialReference.id===legacy.credentialReference?.id);
          setCredentialSaved(Boolean(legacyProfile&&savedMap[legacyProfile.id]));
        }else setCredentialSaved(false);
        if(loaded.error)setSettingsMessage("Legacy provider configuration could not be loaded: "+loaded.error);
        await refreshRuntime(activeConfiguration,loaded.error,presetState,credentialState);
        if(!active)return;
        const hostSnapshot=await loadHost();if(active)setHost(hostSnapshot);
        const sync=async()=>{
          const foundation=foundationRef.current;if(!foundation||!active)return;
          try{const snapshot=await foundation.diagnostics();const live=await publishAndReadRuntimeDiagnostics(addConfigurationLoadError(snapshot));if(active)setRuntime(live)}
          catch{if(active)setRuntime(current=>({...current,runtimeStatus:"error",coreStatus:"error"}))}
        };
        await sync();timer=setInterval(()=>{void sync()},1000);
      }catch(error){
        if(active){setStartupStatus("error");setStartupError(safeStartupError(error));setRuntime({...preview,runtimeStatus:"error",coreStatus:"error"});}
      }
    })();
    return ()=>{active=false;if(timer)clearInterval(timer);void foundationRef.current?.stop();foundationRef.current=undefined};
  },[configurationStore,credentialProfileStore,providerPresetStore,credentialStore,refreshRuntime]);

  const selectCharacter=React.useCallback(async(id:string)=>{
    const foundation=foundationRef.current;
    if(!foundation)return;
    const selected=await foundation.setActiveCharacter(id);
    const controller=await controllerForCharacter(selected.id);
    setActiveCharacter(selected);
    setActiveModelProfile(controller.getModelProfile()??defaultModelProfile(selected.id));
    setChatController(controller);
    setCharacters(await foundation.listCharacters());
    setView("chat");
  },[controllerForCharacter]);

  const createCharacter=React.useCallback(async(name:string)=>{
    const foundation=foundationRef.current;
    if(!foundation)return;
    await foundation.createCharacter({name});
    setCharacters(await foundation.listCharacters());
  },[]);

  const renameCharacter=React.useCallback(async(id:string,name:string)=>{
    const foundation=foundationRef.current;
    if(!foundation)return;
    const updated=await foundation.updateCharacter(id,{name});
    setCharacters(await foundation.listCharacters());
    setActiveCharacter(current=>current?.id===updated.id?updated:current);
  },[]);

  const deleteCharacter=React.useCallback(async(id:string)=>{
    const foundation=foundationRef.current;
    if(!foundation)return;
    const before=activeCharacter;
    await foundation.deleteCharacter(id);
    try{await modelProfileStore.delete(id)}catch(error){modelProfileLoadErrorRef.current=safeStartupError(error)}
    const nextActive=await foundation.getActiveCharacter();
    setCharacters(await foundation.listCharacters());
    setActiveCharacter(nextActive);
    if(before?.id===id||before?.id!==nextActive.id){
      const controller=await controllerForCharacter(nextActive.id);
      setActiveModelProfile(controller.getModelProfile()??defaultModelProfile(nextActive.id));
      setChatController(controller);
    }
  },[activeCharacter,controllerForCharacter,modelProfileStore]);

  const saveProviderPreset=React.useCallback(async(preset:ProviderPreset,activate:boolean)=>{
    const current=providerPresetStateRef.current;
    const nextState:ProviderPresetStoreState={...current,presets:[...current.presets.filter(item=>item.id!==preset.id),preset],activePresetId:activate?preset.id:current.activePresetId};
    await providerPresetStore.save(nextState);providerPresetStateRef.current=nextState;setProviderPresets(nextState.presets);setActivePresetId(nextState.activePresetId);
    if(activate||current.activePresetId===preset.id){
      const credential=preset.credentialProfileId?credentialProfileStateRef.current.profiles.find(profile=>profile.id===preset.credentialProfileId):undefined;
      await refreshRuntime(materializeProviderConfiguration(preset,credential),undefined,nextState,credentialProfileStateRef.current);
    }
  },[providerPresetStore,refreshRuntime]);

  const activateProviderPreset=React.useCallback(async(id:string)=>{
    const preset=providerPresetStateRef.current.presets.find(item=>item.id===id);if(!preset)throw new Error("Provider preset was not found.");
    const nextState={...providerPresetStateRef.current,activePresetId:id};await providerPresetStore.save(nextState);providerPresetStateRef.current=nextState;setProviderPresets(nextState.presets);setActivePresetId(id);
    const credential=preset.credentialProfileId?credentialProfileStateRef.current.profiles.find(profile=>profile.id===preset.credentialProfileId):undefined;
    await refreshRuntime(materializeProviderConfiguration(preset,credential),undefined,nextState,credentialProfileStateRef.current);
  },[providerPresetStore,refreshRuntime]);

  const deleteProviderPreset=React.useCallback(async(id:string)=>{
    const current=providerPresetStateRef.current;const remaining=current.presets.filter(item=>item.id!==id);const nextActive=current.activePresetId===id?(remaining[0]?.id??null):current.activePresetId;
    const nextState={...current,presets:remaining,activePresetId:nextActive};await providerPresetStore.save(nextState);providerPresetStateRef.current=nextState;setProviderPresets(remaining);setActivePresetId(nextActive);
    if(nextActive){const preset=remaining.find(item=>item.id===nextActive)!;const credential=preset.credentialProfileId?credentialProfileStateRef.current.profiles.find(profile=>profile.id===preset.credentialProfileId):undefined;await refreshRuntime(materializeProviderConfiguration(preset,credential),undefined,nextState,credentialProfileStateRef.current)}
    else await refreshRuntime(undefined,undefined,nextState,credentialProfileStateRef.current);
  },[providerPresetStore,refreshRuntime]);

  const createCredentialProfile=React.useCallback(async(label:string,secret:string):Promise<CredentialProfile>{
    const now=new Date().toISOString();const reference={id:"credential."+slugId(label)+"."+Date.now(),kind:"api-key",provider:"openai-compatible",version:"1"} as const;
    await credentialStore.setSecret(reference,secret);
    const profile:CredentialProfile={id:"credential-profile:"+slugId(label)+":"+Date.now(),label,providerId:"openai-compatible",credentialReference:reference,createdAt:now,updatedAt:now};
    const nextState={...credentialProfileStateRef.current,profiles:[...credentialProfileStateRef.current.profiles,profile]};await credentialProfileStore.save(nextState);credentialProfileStateRef.current=nextState;setCredentialProfiles(nextState.profiles);setCredentialSavedMap(current=>({...current,[profile.id]:true}));
    return profile;
  },[credentialStore,credentialProfileStore]);

  const deleteCredentialProfile=React.useCallback(async(id:string)=>{
    if(providerPresetStateRef.current.presets.some(preset=>preset.credentialProfileId===id))throw new Error("Credential is still used by a provider preset.");
    const removed=credentialProfileStateRef.current.profiles.find(profile=>profile.id===id);if(removed)await credentialStore.deleteSecret(removed.credentialReference);
    const nextState={...credentialProfileStateRef.current,profiles:credentialProfileStateRef.current.profiles.filter(profile=>profile.id!==id)};await credentialProfileStore.save(nextState);credentialProfileStateRef.current=nextState;setCredentialProfiles(nextState.profiles);setCredentialSavedMap(current=>{const next={...current};delete next[id];return next;});
  },[credentialProfileStore,credentialStore]);

  const refreshPresetModels=React.useCallback(async(preset:ProviderPreset):Promise<readonly ModelInfo[]>=>{
    const credential=credentialProfileStateRef.current.profiles.find(profile=>profile.id===preset.credentialProfileId);
    return listProviderModels(materializeProviderConfiguration(preset,credential),credentialStore);
  },[credentialStore]);

  const testPreset=React.useCallback(async(preset:ProviderPreset):Promise<ProviderConnectionTestResult>=>{
    const credential=credentialProfileStateRef.current.profiles.find(profile=>profile.id===preset.credentialProfileId);
    let config=materializeProviderConfiguration(preset,credential);
    if(!config.model){
      const models=await listProviderModels(config,credentialStore);const first=models[0]?.id;
      if(!first)return {apiVersion:"1",schemaVersion:"1",status:"configuration_error",providerId:preset.providerId,message:"Model discovery is unavailable; choose a model manually."};
      config={...config,model:first,enabled:true};
    }
    const validation=validateProviderConfiguration(config);
    if(!validation.valid)return {apiVersion:"1",schemaVersion:"1",status:"configuration_error",providerId:preset.providerId,message:validation.errors.join(" ")};
    return testProviderConfiguration(config,credentialStore);
  },[credentialStore]);

  const saveModelProfile=React.useCallback(async(profile:ModelProfile)=>{
    await modelProfileStore.save(profile);
    modelProfileLoadErrorRef.current=undefined;
    setActiveModelProfile(profile);
    setChatController(current=>{
      current?.setModelProfile(profile);
      return current;
    });
  },[modelProfileStore]);

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
        <button className={view==="characters"?"nav-button active":"nav-button"} onClick={()=>setView("characters")}>Characters</button>
        <button className={view==="core-book"?"nav-button active":"nav-button"} onClick={()=>setView("core-book")}>Core Book</button>
        <button className={view==="model-profile"?"nav-button active":"nav-button"} onClick={()=>setView("model-profile")}>Model Profile</button>
        <button className={view==="settings"?"nav-button active":"nav-button"} onClick={()=>setView("settings")}>Provider Presets</button>
      </nav>
    </header>
    {view==="model-profile"&&activeCharacter&&activeModelProfile
      ?<ModelProfileView profile={activeModelProfile} runtime={runtime} presets={providerPresets} activePresetId={activePresetId} onSave={saveModelProfile}/>
      :view==="settings"
      ?<ProviderPresetsView presets={providerPresets} activePresetId={activePresetId} credentialProfiles={credentialProfiles} credentialSaved={credentialSavedMap}
          runtime={runtime} onSavePreset={saveProviderPreset} onActivatePreset={activateProviderPreset} onDeletePreset={deleteProviderPreset}
          onCreateCredential={createCredentialProfile} onDeleteCredential={deleteCredentialProfile} onRefreshModels={refreshPresetModels} onTestPreset={testPreset}/>
      :startupStatus==="error"
        ?<section className="loading-panel" role="alert">
          <strong>Character runtime initialization failed.</strong>
          <div>{startupError}</div>
        </section>
      :view==="chat"&&activeCharacter&&chatController
      ?<ChatView controller={chatController} runtime={foundationRef.current!} character={activeCharacter}
          onPersist={()=>persistConversation(chatController!)}
          onClear={()=>clearConversation(activeCharacter.id,chatController!)}/>
      :view==="characters"&&activeCharacter
        ?<CharactersView characters={characters} activeCharacter={activeCharacter}
          onSelect={selectCharacter} onCreate={createCharacter} onRename={renameCharacter} onDelete={deleteCharacter}/>
        :view==="core-book"&&activeCharacter
          ?<CoreBookView runtime={foundationRef.current!} character={activeCharacter}/>
          :<section className="loading-panel">Initializing characters…</section>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
