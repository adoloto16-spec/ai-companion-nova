import React from "react";
import {createRoot} from "react-dom/client";
import {invoke} from "@tauri-apps/api/core";
import {ChatSessionController,ConversationSession,InMemoryCharacterStore} from "../../../core/src/index";

import {startFoundationRuntime,testProviderPresetConfiguration,listProviderModels} from "../../../runtime/bootstrap/src/index";
import type {FoundationRuntime} from "../../../runtime/bootstrap/src/index";
import {IpcCredentialStore,InMemoryCredentialStore} from "../../../host/credentials/src/index";
import {IpcCredentialProfileStore,InMemoryCredentialProfileStore,emptyCredentialProfileState} from "../../../host/credential-profiles/src/index";
import {IpcProviderPresetStore,InMemoryProviderPresetStore,materializeProviderConfiguration,migrateProviderConfiguration,emptyProviderPresetState} from "../../../host/provider-presets/src/index";
import {IpcProviderConfigurationStore,loadProviderConfigurationSafely} from "../../../host/config/src/index";
import {IpcCharacterStore} from "../../../host/characters/src/index";
import {IpcCoreBookStore,InMemoryCoreBookStore} from "../../../host/core-book/src/index";
import {IpcMemorySemanticIndexStore,IpcMemoryStore,InMemoryMemoryStore} from "../../../host/memory/src/index";
import {IpcConversationStore,InMemoryConversationStore} from "../../../host/conversations/src/index";
import {IpcModelProfileStore,InMemoryModelProfileStore} from "../../../host/model-profiles/src/index";
import {IpcSettingsStore,InMemorySettingsStore} from "../../../host/settings/src/index";
import {IpcFullTextRetriever} from "../../../host/retrieval/src/index";
import {
  type ProviderConfiguration, type ProviderConnectionTestResult, type Conversation,
  type ModelProfile, defaultModelProfile, type CredentialProfile, type CredentialProfileStoreState, type AppSettings, type ChatTurnTrace, type DiagnosticsLogLevel, type RuntimeDiagnostics,
  type Character, type CoreBookActivation, type CoreBookEntry, type MemoryItem, type ErrorDiagnostic,
  defaultAppSettings, validateAppSettings, StandardContractValidator,
  type ProviderPreset, type ProviderPresetStoreState, type ModelInfo
} from "../../../contracts/src/index";
import "./styles.css";

const preview:RuntimeDiagnostics={schemaVersion:"1",timestamp:new Date().toISOString(),runtimeStatus:"stopped",coreStatus:"stopped",modules:[],providers:[],recentErrors:[],capabilities:[]};


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

function slugId(value:string):string{
  const normalized=value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"")
    .slice(0,64);
  return normalized||"credential";
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

function messageStreamStatus(message:{role?:string;metadata?:Record<string,unknown>}):"complete"|"interrupted"|"streaming"|undefined{
  const value=message.metadata?.streamStatus;
  if(value==="complete"||value==="interrupted"||value==="streaming")return value;
  return message.role==="assistant"?"complete":undefined;
}

function ConversationSwitcher({conversations,activeConversationId,sending,onSelect,onCreate,onRename,onDelete}:{
  conversations:readonly Conversation[];
  activeConversationId:string;
  sending:boolean;
  onSelect:(id:string)=>Promise<void>;
  onCreate:()=>Promise<void>;
  onRename:(conversation:Conversation)=>Promise<void>;
  onDelete:(conversation:Conversation)=>Promise<void>;
}){
  return <div className="conversation-switcher">
    <div className="conversation-header">
      <strong>Conversation</strong>
      <button type="button" onClick={()=>void onCreate()} disabled={sending}>New Conversation</button>
    </div>
    <div className="conversation-list" role="listbox" aria-label="Conversations">
      {conversations.map(conversation=>
        <button
          type="button"
          key={conversation.id}
          className={conversation.id===activeConversationId?"conversation-row active":"conversation-row"}
          onClick={()=>void onSelect(conversation.id)}
          disabled={sending}
        >
          <span className="conversation-title">{conversation.title}</span>
          <span className="conversation-meta">{conversation.messages.length} messages</span>
        </button>
      )}
    </div>
    {conversations.length>0&&(()=>{
      const active=conversations.find(conversation=>conversation.id===activeConversationId);
      return active
        ?<div className="conversation-actions">
          <button type="button" onClick={()=>void onRename(active)} disabled={sending}>Rename</button>
          <button type="button" onClick={()=>void onDelete(active)} disabled={sending}>Delete</button>
        </div>
        :null;
    })()}
  </div>;
}

function ChatView({controller,runtime,character,conversations,activeConversation,onPersist,onClear,onSelectConversation,onCreateConversation,onRenameConversation,onDeleteConversation}:{
  controller:ChatSessionController;
  runtime:FoundationRuntime;
  character:Character;
  conversations:readonly Conversation[];
  activeConversation:Conversation;
  onPersist:()=>Promise<void>;
  onClear:()=>Promise<void>;
  onSelectConversation:(id:string)=>Promise<void>;
  onCreateConversation:()=>Promise<void>;
  onRenameConversation:(conversation:Conversation)=>Promise<void>;
  onDeleteConversation:(conversation:Conversation)=>Promise<void>;
}){
  const [snapshot,setSnapshot]=React.useState(()=>controller.getSnapshot());
  const [input,setInput]=React.useState("");
  const [editingId,setEditingId]=React.useState<string|undefined>();
  const [editingText,setEditingText]=React.useState("");
  const [persistenceError,setPersistenceError]=React.useState("");
  const bottomRef=React.useRef<HTMLDivElement|null>(null);

  React.useEffect(()=>{setSnapshot(controller.getSnapshot());return controller.subscribe(setSnapshot)},[controller]);
  React.useEffect(()=>{
    bottomRef.current?.scrollIntoView({block:"end"});
  },[snapshot.messages.map(message=>message.content).join("\u0000"),snapshot.status]);

  const persistAfterAction=React.useCallback(async(result:{status:string})=>{
    if(result.status==="rejected")return;
    try{await onPersist();}
    catch(error){setPersistenceError(error instanceof Error?error.message:"Conversation could not be saved.");}
  },[onPersist]);

  const send=React.useCallback(async()=>{
    setPersistenceError("");
    const result=await controller.submit(input,runtime.getActiveChatModel());
    if(result.status!=="rejected")setInput("");
    await persistAfterAction(result);
  },[controller,input,runtime,persistAfterAction]);

  const stop=React.useCallback(async()=>{
    setPersistenceError("");
    const result=await controller.stop();
    await persistAfterAction(result);
  },[controller,persistAfterAction]);

  const continueGeneration=React.useCallback(async()=>{
    setPersistenceError("");
    const result=await controller.continue(runtime.getActiveChatModel());
    await persistAfterAction(result);
  },[controller,runtime,persistAfterAction]);

  const regenerate=React.useCallback(async()=>{
    setPersistenceError("");
    const result=await controller.regenerate(runtime.getActiveChatModel());
    await persistAfterAction(result);
  },[controller,runtime,persistAfterAction]);

  const retry=React.useCallback(async()=>{
    setPersistenceError("");
    const result=await controller.retry(runtime.getActiveChatModel());
    await persistAfterAction(result);
  },[controller,runtime,persistAfterAction]);

  const clear=React.useCallback(async()=>{
    setPersistenceError("");
    try{await onClear();}
    catch(error){setPersistenceError(error instanceof Error?error.message:"Conversation could not be cleared.");}
  },[onClear]);
  const editMessage=React.useCallback(async(id:string)=>{
    setPersistenceError("");
    try{
      controller.editMessage(id,editingText);
      await onPersist();
      setEditingId(undefined);setEditingText("");
    }catch(error){setPersistenceError(error instanceof Error?error.message:"Message could not be edited.");}
  },[controller,editingText,onPersist]);

  const deleteMessage=React.useCallback(async(id:string)=>{
    if(!window.confirm("Delete this message?"))return;
    setPersistenceError("");
    try{controller.deleteMessage(id);await onPersist();}
    catch(error){setPersistenceError(error instanceof Error?error.message:"Message could not be deleted.");}
  },[controller,onPersist]);



  const onKeyDown=(event:React.KeyboardEvent<HTMLTextAreaElement>)=>{
    if(event.key==="Enter"&&!event.shiftKey){
      event.preventDefault();
      if(!snapshot.sending)void send();
    }
  };

  const lastAssistant=[...snapshot.messages].reverse().find(message=>message.role==="assistant");
  const lastAssistantStatus=lastAssistant?messageStreamStatus(lastAssistant):undefined;
  const showContinue=snapshot.status==="interrupted"&&lastAssistantStatus==="interrupted"&&!snapshot.sending;
  const showRegenerate=(snapshot.status==="completed"||snapshot.status==="interrupted")&&(lastAssistantStatus==="complete"||lastAssistantStatus==="interrupted")&&!snapshot.sending;
  const showRetry=snapshot.status==="error"&&!snapshot.sending;

  return <section className="chat-panel">
    <div className="chat-toolbar">
      <div>
        <h2>Chat · {character.name}</h2>
        <p className="chat-subtitle">{activeConversation.title} · persistent and scoped to {character.name}.</p>
      </div>
      <div className="chat-toolbar-actions">
        {snapshot.status==="streaming"&&<button type="button" onClick={()=>void stop()}>Stop</button>}
        {showContinue&&<button type="button" onClick={()=>void continueGeneration()}>Continue</button>}
        {showRegenerate&&<button type="button" onClick={()=>void regenerate()}>Regenerate</button>}
        {showRetry&&<button type="button" onClick={()=>void retry()}>Retry</button>}
        <button type="button" onClick={()=>void clear()} disabled={snapshot.sending||snapshot.messages.length===0}>Clear</button>
      </div>
    </div>

    <ConversationSwitcher
      conversations={conversations}
      activeConversationId={activeConversation.id}
      sending={snapshot.sending}
      onSelect={onSelectConversation}
      onCreate={onCreateConversation}
      onRename={onRenameConversation}
      onDelete={onDeleteConversation}
    />

    <div className="message-list" aria-live="polite">
      {snapshot.messages.length===0&&<div className="empty-chat">Write a message to start the conversation.</div>}
      {snapshot.messages.map((message,index)=>{
        const state=messageStreamStatus(message);
        const editable=message.role==="user"||message.role==="assistant";
        const isEditing=editingId===message.id;
        return <article className={"chat-message "+message.role} key={message.id??"message-"+index}>
          <div className="message-author">{message.role==="user"?"You":character.name}</div>
          {isEditing
            ?<div className="message-edit">
              <textarea value={editingText} onChange={event=>setEditingText(event.target.value)} rows={4} aria-label="Edit message"/>
              <div className="actions">
                <button type="button" onClick={()=>void editMessage(message.id!)} disabled={!editingText.trim()}>Save</button>
                <button type="button" onClick={()=>{setEditingId(undefined);setEditingText("")}}>Cancel</button>
              </div>
            </div>
            :<div className="message-content">{message.content}</div>}
          {state==="interrupted"&&<div className="message-status">Interrupted</div>}
          {editable&&!snapshot.sending&&!isEditing&&message.id&&
            <div className="message-actions">
              <button type="button" onClick={()=>{setEditingId(message.id);setEditingText(message.content)}}>Edit</button>
              <button type="button" onClick={()=>void deleteMessage(message.id!)}>Delete</button>
            </div>}
        </article>;
      })}
      <div ref={bottomRef}/>
    </div>
    <form className="chat-composer" onSubmit={event=>{event.preventDefault();if(!snapshot.sending)void send()}}>
      <textarea value={input} onChange={event=>setInput(event.target.value)} onKeyDown={onKeyDown} placeholder="Write a message…" aria-label="Chat message" disabled={snapshot.sending} rows={2}/>
      <button type="submit" disabled={snapshot.sending||input.trim().length===0}>{snapshot.sending?"Streaming…":"Send"}</button>
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

function CharacterMemoryView({runtime,character,originConversationId}:{
  runtime:FoundationRuntime;
  character:Character;
  originConversationId?:string;
}){
  const [items,setItems]=React.useState<readonly MemoryItem[]>([]);
  const [tab,setTab]=React.useState<"active"|"archived">("active");
  const [editingId,setEditingId]=React.useState<string|null>(null);
  const [draft,setDraft]=React.useState<{type:MemoryItem["type"];content:string;tags:string;importance:number;confidence:number;validFrom:string;validUntil:string}>({
    type:"observation",content:"",tags:"",importance:70,confidence:80,validFrom:"",validUntil:""
  });
  const [createDraft,setCreateDraft]=React.useState({type:"observation" as MemoryItem["type"],content:"",tags:"",importance:70,confidence:80,validFrom:"",validUntil:""});
  const [busy,setBusy]=React.useState(false);
  const [message,setMessage]=React.useState("");

  const refresh=React.useCallback(async()=>{
    try{setItems(await runtime.listMemory(character.id));}
    catch(error){setMessage(error instanceof Error?error.message:"Character Memory could not be loaded.")}
  },[runtime,character.id]);
  React.useEffect(()=>{void refresh()},[refresh]);

  const beginEdit=(item:MemoryItem)=>{
    setEditingId(item.id);
    setDraft({
      type:item.type,content:item.content,tags:item.tags.join(", "),importance:item.importance,confidence:item.confidence,
      validFrom:item.validFrom?item.validFrom.slice(0,19):"",validUntil:item.validUntil?item.validUntil.slice(0,19):""
    });
  };

  const saveEdit=async()=>{
    if(!editingId||!draft.content.trim())return;
    setBusy(true);setMessage("");
    try{
      await runtime.updateMemory(character.id,editingId,{
        type:draft.type,content:draft.content.trim(),
        tags:draft.tags.split(",").map(value=>value.trim()).filter(Boolean),
        importance:draft.importance,confidence:draft.confidence,
        validFrom:draft.validFrom?new Date(draft.validFrom).toISOString():null,
        validUntil:draft.validUntil?new Date(draft.validUntil).toISOString():null
      });
      setEditingId(null);setMessage("Memory updated.");await refresh();
    }catch(error){setMessage(error instanceof Error?error.message:"Memory could not be updated.")}
    finally{setBusy(false)}
  };

  const create=async()=>{
    if(!createDraft.content.trim())return;
    setBusy(true);setMessage("");
    try{
      await runtime.createMemory(character.id,{
        originConversationId:originConversationId??null,
        type:createDraft.type,content:createDraft.content.trim(),
        tags:createDraft.tags.split(",").map(value=>value.trim()).filter(Boolean),
        importance:createDraft.importance,confidence:createDraft.confidence,
        validFrom:createDraft.validFrom?new Date(createDraft.validFrom).toISOString():null,
        validUntil:createDraft.validUntil?new Date(createDraft.validUntil).toISOString():null,
        source:"user",sourceReference:null,mutationPolicy:"locked",metadata:{origin:"character-memory-ui"}
      });
      setCreateDraft({...createDraft,content:"",tags:""});
      setMessage("Memory created.");await refresh();
    }catch(error){setMessage(error instanceof Error?error.message:"Memory could not be created.")}
    finally{setBusy(false)}
  };

  const archive=async(item:MemoryItem)=>{
    setBusy(true);setMessage("");
    try{await runtime.archiveMemory(character.id,item.id);setMessage("Memory archived.");await refresh();}
    catch(error){setMessage(error instanceof Error?error.message:"Memory could not be archived.")}
    finally{setBusy(false)}
  };
  const restore=async(item:MemoryItem)=>{
    setBusy(true);setMessage("");
    try{await runtime.restoreMemory(character.id,item.id);setMessage("Memory restored.");await refresh();}
    catch(error){setMessage(error instanceof Error?error.message:"Memory could not be restored.")}
    finally{setBusy(false)}
  };
  const permanentDelete=async(item:MemoryItem)=>{
    if(!window.confirm("Delete this memory permanently? This cannot be undone."))return;
    setBusy(true);setMessage("");
    try{await runtime.deleteMemory(character.id,item.id);setMessage("Memory permanently deleted.");await refresh();}
    catch(error){setMessage(error instanceof Error?error.message:"Memory could not be deleted.")}
    finally{setBusy(false)}
  };

  const shown=items.filter(item=>tab==="active"?item.status==="active":item.status==="archived");
  const typeOptions=(
    <>
      <option value="observation">Observation</option>
      <option value="fact">Fact</option>
      <option value="preference">Preference</option>
      <option value="relationship">Relationship</option>
      <option value="event">Event</option>
      <option value="experience">Experience</option>
      <option value="goal">Goal</option>
      <option value="instruction">Instruction</option>
    </>
  );

  return <section className="characters-panel">
    <div className="characters-toolbar">
      <div><h2>Character Memory · {character.name}</h2><p className="chat-subtitle">Character-owned long-term memory. Conversation is provenance only.</p></div>
      <button type="button" onClick={()=>void refresh()} disabled={busy}>Refresh</button>
    </div>
    <div className="actions" role="tablist" aria-label="Memory lifecycle">
      <button type="button" className={tab==="active"?"active":""} onClick={()=>setTab("active")}>Active ({items.filter(item=>item.status==="active").length})</button>
      <button type="button" className={tab==="archived"?"active":""} onClick={()=>setTab("archived")}>Archived ({items.filter(item=>item.status==="archived").length})</button>
    </div>
    <div className="character-list">
      {shown.length===0&&<div className="core-book-empty">No {tab} memories.</div>}
      {shown.map(item=>editingId===item.id
        ?<div className="character-row" key={item.id}>
          <div className="settings-grid">
            <label>Type<select value={draft.type} onChange={event=>setDraft({...draft,type:event.target.value as MemoryItem["type"]})} disabled={busy}>{typeOptions}</select></label>
            <label>Content<textarea rows={4} value={draft.content} onChange={event=>setDraft({...draft,content:event.target.value})} disabled={busy}/></label>
            <label>Tags<input value={draft.tags} onChange={event=>setDraft({...draft,tags:event.target.value})} disabled={busy}/></label>
            <div className="core-book-grid">
              <label>Importance<input type="number" min={0} max={100} value={draft.importance} onChange={event=>setDraft({...draft,importance:Number(event.target.value)})} disabled={busy}/></label>
              <label>Confidence<input type="number" min={0} max={100} value={draft.confidence} onChange={event=>setDraft({...draft,confidence:Number(event.target.value)})} disabled={busy}/></label>
            </div>
            <div className="core-book-grid">
              <label>Valid from<input type="datetime-local" value={draft.validFrom} onChange={event=>setDraft({...draft,validFrom:event.target.value})} disabled={busy}/></label>
              <label>Valid until<input type="datetime-local" value={draft.validUntil} onChange={event=>setDraft({...draft,validUntil:event.target.value})} disabled={busy}/></label>
            </div>
            <div className="actions"><button type="button" onClick={()=>void saveEdit()} disabled={busy||!draft.content.trim()}>Save</button><button type="button" onClick={()=>setEditingId(null)} disabled={busy}>Cancel</button></div>
          </div>
        </div>
        :<div className="character-row" key={item.id}>
          <div><strong>{item.content}</strong><small>{item.type} · importance {item.importance} · confidence {item.confidence}</small>
            <small>Origin conversation: {item.originConversationId??"none"} · Archive reason: {item.archiveReason??"—"}</small>
          </div>
          <div className="actions">
            {tab==="active"&&<><button type="button" onClick={()=>beginEdit(item)} disabled={busy}>Edit</button><button type="button" onClick={()=>void archive(item)} disabled={busy}>Archive</button></>}
            {tab==="archived"&&<button type="button" onClick={()=>void restore(item)} disabled={busy}>Restore</button>}
            <button type="button" onClick={()=>void permanentDelete(item)} disabled={busy}>Delete permanently</button>
          </div>
        </div>
      )}
    </div>
    {tab==="active"&&<div className="character-actions">
      <h3>Add long-term memory</h3>
      <label>Type<select value={createDraft.type} onChange={event=>setCreateDraft({...createDraft,type:event.target.value as MemoryItem["type"]})} disabled={busy}>{typeOptions}</select></label>
      <label>Content<textarea value={createDraft.content} onChange={event=>setCreateDraft({...createDraft,content:event.target.value})} rows={5} disabled={busy}/></label>
      <label>Tags<input value={createDraft.tags} onChange={event=>setCreateDraft({...createDraft,tags:event.target.value})} placeholder="comma-separated" disabled={busy}/></label>
      <div className="core-book-grid">
        <label>Importance<input type="number" min={0} max={100} value={createDraft.importance} onChange={event=>setCreateDraft({...createDraft,importance:Number(event.target.value)})} disabled={busy}/></label>
        <label>Confidence<input type="number" min={0} max={100} value={createDraft.confidence} onChange={event=>setCreateDraft({...createDraft,confidence:Number(event.target.value)})} disabled={busy}/></label>
      </div>
      <div className="core-book-grid">
        <label>Valid from<input type="datetime-local" value={createDraft.validFrom} onChange={event=>setCreateDraft({...createDraft,validFrom:event.target.value})} disabled={busy}/></label>
        <label>Valid until<input type="datetime-local" value={createDraft.validUntil} onChange={event=>setCreateDraft({...createDraft,validUntil:event.target.value})} disabled={busy}/></label>
      </div>
      <div className="actions"><button type="button" onClick={()=>void create()} disabled={busy||!createDraft.content.trim()}>Create Memory</button></div>
    </div>}
    {message&&<div className="notice" role="status">{message}</div>}
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

function ProviderPresetsView({
  presets,activePresetId,credentialProfiles,credentialSaved,runtime,
  onSavePreset,onActivatePreset,onDeletePreset,onCreateCredential,onDeleteCredential,onRefreshModels,onTestPreset
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
  const [draft,setDraft]=React.useState<ProviderPreset>(()=>presets.find(p=>p.id===selectedId)??{
    id:"provider-preset:new-"+Date.now(),name:"",providerId:"openai-compatible",baseUrl:"https://api.openai.com/v1",
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  });
  const [models,setModels]=React.useState<readonly ModelInfo[]>([]);
  const [busy,setBusy]=React.useState(false);
  const [message,setMessage]=React.useState("");
  const [credentialChoice,setCredentialChoice]=React.useState(draft.credentialProfileId??"");
  const [newCredentialLabel,setNewCredentialLabel]=React.useState("");
  const [newCredentialSecret,setNewCredentialSecret]=React.useState("");

  React.useEffect(()=>{
    const next=presets.find(p=>p.id===selectedId)??presets[0];
    if(next){setSelectedId(next.id);setDraft({...next});setCredentialChoice(next.credentialProfileId??"");}
  },[selectedId,presets]);

  const save=async(activate:boolean)=>{
    setBusy(true);setMessage("");
    try{
      const next:ProviderPreset={
        ...draft,
        name:draft.name.trim(),
        baseUrl:draft.baseUrl.trim(),
        providerId:"openai-compatible",
        credentialProfileId:credentialChoice||undefined,
        model:draft.model?.trim()||undefined,
        updatedAt:new Date().toISOString()
      };
      if(!next.name)throw new Error("Provider preset name is required.");
      await onSavePreset(next,activate);setDraft(next);setSelectedId(next.id);
      setMessage(activate?"Provider preset saved and activated.":"Provider preset saved.");
    }catch(error){setMessage("Provider preset could not be saved: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const saveAsNew=async()=>{
    const now=new Date().toISOString();
    const next={...draft,id:"provider-preset:"+(draft.name.trim()||"preset").toLowerCase().replace(/[^a-z0-9]+/g,"-")+":"+Date.now(),createdAt:now,updatedAt:now};
    setDraft(next);setSelectedId(next.id);
    await (async()=>{
      setBusy(true);setMessage("");
      try{await onSavePreset(next,false);setMessage("Provider preset saved as new preset.")}
      catch(error){setMessage("Provider preset could not be saved: "+safeErrorMessage(error))}
      finally{setBusy(false)}
    })();
  };

  const activate=async()=>{
    if(!selectedId)return;
    setBusy(true);setMessage("");
    try{await onActivatePreset(selectedId);setMessage("Provider preset activated.")}
    catch(error){setMessage("Provider preset could not be activated: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const removePreset=async()=>{
    if(!selectedId)return;
    setBusy(true);setMessage("");
    try{await onDeletePreset(selectedId);setMessage("Provider preset deleted.")}
    catch(error){setMessage("Provider preset could not be deleted: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const refresh=async()=>{
    setBusy(true);setMessage("");
    try{
      const result=await onRefreshModels(draft);setModels(result);
      setMessage(result.length>0?"Models refreshed.":"Model discovery unavailable; manual model input is active.");
    }catch(error){setModels([]);setMessage("Model discovery failed: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const test=async()=>{
    setBusy(true);setMessage("");
    try{
      const result=await onTestPreset(draft);setMessage(resultLabel(result)+(result.message?" · "+result.message:""));
    }catch(error){setMessage("Provider test failed: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const createCredential=async()=>{
    setBusy(true);setMessage("");
    try{
      if(!newCredentialLabel.trim()||!newCredentialSecret)throw new Error("Credential label and API key are required.");
      const profile=await onCreateCredential(newCredentialLabel.trim(),newCredentialSecret);
      setCredentialChoice(profile.id);setNewCredentialLabel("");setNewCredentialSecret("");
      setMessage("Credential saved. The API key is no longer displayed.");
    }catch(error){setMessage("Credential could not be saved: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const deleteCredential=async(id:string)=>{
    const used=presets.filter(p=>p.credentialProfileId===id);
    if(used.length>0){setMessage("Credential is used by: "+used.map(p=>p.name||p.id).join(", ")+". Reassign the preset before deletion.");return;}
    setBusy(true);setMessage("");
    try{await onDeleteCredential(id);if(credentialChoice===id)setCredentialChoice("");setMessage("Credential removed.")}
    catch(error){setMessage("Credential could not be removed: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  const setStarter=(name:string,baseUrl:string)=>{const now=new Date().toISOString();setDraft({id:"provider-preset:"+name.toLowerCase()+":"+Date.now(),name,providerId:"openai-compatible",baseUrl,createdAt:now,updatedAt:now});setCredentialChoice("");setModels([]);};

  return <section className="settings-grid">
    <section>
      <h2>Provider Presets</h2>
      <p className="chat-subtitle">Saved connections. API secrets remain in the OS credential store.</p>
      <label>Active preset
        <select value={activePresetId??""} onChange={event=>{if(event.target.value)void onActivatePreset(event.target.value)}} disabled={busy||presets.length===0}>
          {presets.length===0?<option value="">No saved presets</option>:presets.map(p=><option key={p.id} value={p.id}>{p.name||p.id}</option>)}
        </select>
      </label>
      <label>Preset to edit
        <select value={selectedId??""} onChange={event=>setSelectedId(event.target.value)} disabled={busy||presets.length===0}>
          {presets.length===0?<option value="">Create a preset below</option>:presets.map(p=><option key={p.id} value={p.id}>{p.name||p.id}</option>)}
        </select>
      </label>
      <label>Name<input value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} disabled={busy}/></label>
      <label>Provider type<select value="openai-compatible" disabled><option value="openai-compatible">OpenAI-compatible</option></select></label>
      <label>Base URL<input value={draft.baseUrl} onChange={event=>setDraft(current=>({...current,baseUrl:event.target.value}))} disabled={busy}/></label>
      <label>API credential
        <select value={credentialChoice} onChange={event=>setCredentialChoice(event.target.value)} disabled={busy}>
          <option value="">No credential / local server</option>
          {credentialProfiles.map(profile=><option key={profile.id} value={profile.id}>{profile.label} {credentialSaved[profile.id]?"••••••••":"(not saved)"}</option>)}
          <option value="__new__">+ Add new credential</option>
        </select>
      </label>
      {credentialChoice==="__new__"&&<div className="character-actions">
        <label>Label<input value={newCredentialLabel} onChange={event=>setNewCredentialLabel(event.target.value)} disabled={busy}/></label>
        <label>API key<input type="password" autoComplete="off" value={newCredentialSecret} onChange={event=>setNewCredentialSecret(event.target.value)} disabled={busy}/></label>
        <button onClick={()=>void createCredential()} disabled={busy}>Save credential</button>
      </div>}
      <label>Model
        {models.length>0
          ?<select value={draft.model??""} onChange={event=>setDraft(current=>({...current,model:event.target.value||undefined}))} disabled={busy}>
            {models.map(model=><option key={model.id} value={model.id}>{model.displayName&&model.displayName!==model.id?model.displayName+" · "+model.id:model.id}</option>)}
          </select>
          :<input value={draft.model??""} onChange={event=>setDraft(current=>({...current,model:event.target.value||undefined}))} placeholder="model-id" disabled={busy}/>}
      </label>
      <label>Timeout (ms)<input type="number" min="1" value={draft.timeoutMs??30000} onChange={event=>setDraft(current=>({...current,timeoutMs:Number(event.target.value)}))} disabled={busy}/></label>
      <div className="actions">
        <button onClick={()=>void refresh()} disabled={busy}>Refresh models</button>
        <button onClick={()=>void test()} disabled={busy||!draft.name.trim()}>Test provider</button>
        <button onClick={()=>void save(false)} disabled={busy||!draft.name.trim()}>Save</button>
        <button onClick={()=>void save(true)} disabled={busy||!draft.name.trim()}>Save &amp; activate</button>
        <button onClick={()=>void saveAsNew()} disabled={busy||!draft.name.trim()}>Save as new preset</button>
        {selectedId&&<button onClick={()=>void activate()} disabled={busy||activePresetId===selectedId}>Activate preset</button>}
        {selectedId&&<button onClick={()=>void removePreset()} disabled={busy}>Delete preset</button>}
      </div>
      <div className="actions">
        <button onClick={()=>setStarter("Mistral","https://api.mistral.ai/v1")} disabled={busy}>Starter: Mistral</button>
        <button onClick={()=>setStarter("Groq","https://api.groq.com/openai/v1")} disabled={busy}>Starter: Groq</button>
        <button onClick={()=>setStarter("OpenAI","https://api.openai.com/v1")} disabled={busy}>Starter: OpenAI</button>
      </div>
      {message&&<div className="notice" role="status">{message}</div>}
      <p className="hint">API keys are never loaded back into this UI.</p>
    </section>
    <section>
      <h2>Saved API credentials</h2>
      {credentialProfiles.length===0?<div>No saved credential metadata.</div>:credentialProfiles.map(profile=>
        <div className="row" key={profile.id}><span>{profile.label} {credentialSaved[profile.id]?"••••••••":"(not saved)"}</span><button onClick={()=>void deleteCredential(profile.id)} disabled={busy}>Delete</button></div>
      )}
      <h2>Runtime</h2>
      <div className="status-grid"><span>Runtime</span><strong>{runtime.runtimeStatus}</strong><span>Active</span><strong>{activePresetId??"none"}</strong></div>
    </section>
  </section>;
}

function ModelProfileView({
  profile,runtime,presets,activePresetId,onSave
}:{
  profile:ModelProfile;
  runtime:RuntimeDiagnostics;
  presets:readonly ProviderPreset[];
  activePresetId:string|null;
  onSave:(profile:ModelProfile)=>Promise<void>
}){
  const [draft,setDraft]=React.useState<ModelProfile>(()=>profile);
  const [busy,setBusy]=React.useState(false);
  const [message,setMessage]=React.useState("");
  React.useEffect(()=>setDraft(profile),[profile.id,profile.characterId,profile.updatedAt]);

  const selectedPresetAvailable=!draft.providerPresetId||presets.some(preset=>preset.id===draft.providerPresetId);

  const updateGeneration=(key:"temperature"|"topP"|"maxTokens",value:string)=>{
    const numeric=value.trim()===""?undefined:Number(value);
    setDraft(current=>({...current,generation:{...current.generation,...(numeric===undefined?{}:{[key]:numeric})}}));
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
        ...(draft.providerPresetId?.trim()?{providerPresetId:draft.providerPresetId}:{}),
        ...(draft.providerPresetId?{providerId:undefined}:{providerId:undefined}),
        ...(draft.model?.trim()?{model:draft.model.trim()}:{model:undefined}),
        generation,
        updatedAt:new Date().toISOString()
      };
      if(!selectedPresetAvailable)throw new Error("Selected provider preset is no longer available.");
      await onSave(next);
      setMessage("Model Profile saved.");
    }catch(error){setMessage("Model Profile could not be saved: "+safeErrorMessage(error))}
    finally{setBusy(false)}
  };

  return <section className="settings-grid">
    <section>
      <h2>Model Profile</h2>
      <p className="chat-subtitle">Character-scoped request preferences. Provider presets control the connection; this profile can pin one preset.</p>
      <label>Provider preset
        <select
          value={draft.providerPresetId??""}
          onChange={event=>setDraft(current=>({...current,providerPresetId:event.target.value||undefined,providerId:undefined}))}
          disabled={busy}>
          <option value="">Use active preset{activePresetId?" ("+(presets.find(preset=>preset.id===activePresetId)?.name??"active")+")":""}</option>
          {!selectedPresetAvailable&&draft.providerPresetId&&<option value={draft.providerPresetId} disabled>Unavailable: {draft.providerPresetId}</option>}
          {presets.map(preset=><option key={preset.id} value={preset.id}>{preset.name||preset.id}</option>)}
        </select>
      </label>
      <label>Model
        <input
          value={draft.model??""}
          onChange={event=>setDraft(current=>({...current,model:event.target.value||undefined}))}
          placeholder={draft.providerPresetId?"Preset default / discovered model":"Active preset model"}
          disabled={busy}/>
      </label>
      <div className="core-book-grid">
        <label>Temperature
          <input type="number" min="0" max="2" step="0.01" value={draft.generation.temperature??""}
            onChange={event=>updateGeneration("temperature",event.target.value)} placeholder="Runtime default" disabled={busy}/>
        </label>
        <label>Top P
          <input type="number" min="0" max="1" step="0.01" value={draft.generation.topP??""}
            onChange={event=>updateGeneration("topP",event.target.value)} placeholder="Runtime default" disabled={busy}/>
        </label>
      </div>
      <label>Max Tokens
        <input type="number" min="1" step="1" value={draft.generation.maxTokens??""}
          onChange={event=>updateGeneration("maxTokens",event.target.value)} placeholder="Runtime default" disabled={busy}/>
      </label>
      <div className="actions"><button onClick={()=>void save()} disabled={busy}>{busy?"Saving…":"Save Model Profile"}</button></div>
      {message&&<div className="notice" role="status">{message}</div>}
      <p className="hint">No API keys, credentials or base URLs are stored in a Model Profile.</p>
    </section>
    <section>
      <h2>Provider presets</h2>
      {presets.length===0?<div>No provider presets saved; this profile follows the fake/default provider until a preset is activated.</div>:presets.map(preset=>
        <div className="row" key={preset.id}><span>{preset.name||preset.id}</span><span>{preset.id===activePresetId?"active":"saved"}</span></div>
      )}
      <small>Legacy Model Profiles without providerPresetId continue to follow the active provider preset after migration.</small>
      <div className="row"><span>Registered chat providers</span><span>{runtime.providers.filter(provider=>provider.roles.includes("chat")).length}</span></div>
    </section>
  </section>;
}


function AppSettingsView({
  settings,onChange,onSave,onReset,saving,message,providerPresets,activePresetId
}:{
  settings:AppSettings;
  onChange:(settings:AppSettings)=>void;
  onSave:()=>Promise<void>;
  onReset:()=>Promise<void>;
  saving:boolean;
  message:string;
  providerPresets:readonly ProviderPreset[];
  activePresetId:string|null;
}){
  const setNumber=(section:"context"|"memory"|"retrieval"|"diagnostics",key:string,value:number)=>{
    onChange({
      ...settings,
      [section]:{...(settings[section] as Record<string,unknown>),[key]:value}
    } as AppSettings);
  };
  const defaults=defaultAppSettings();
  return <div className="settings-grid">
    <section>
      <div className="section-header"><div><h2>Settings</h2><p className="chat-subtitle">Runtime behavior settings. Security limits remain fixed in code.</p></div>
        <button type="button" onClick={()=>void onReset()} disabled={saving}>Reset to Defaults</button>
      </div>
      <h3>Context</h3>
      <label>Context size
        <input type="number" min={256} max={32768} value={settings.context.availableContextTokens}
          onChange={event=>setNumber("context","availableContextTokens",Number(event.target.value))} disabled={saving}/>
        <small>Default: {defaults.context.availableContextTokens}</small>
      </label>
      <label>Reserved response tokens
        <input type="number" min={0} max={16384} value={settings.context.reservedOutputTokens}
          onChange={event=>setNumber("context","reservedOutputTokens",Number(event.target.value))} disabled={saving}/>
        <small>Default: {defaults.context.reservedOutputTokens}</small>
      </label>
      <label>Safety margin
        <input type="number" min={0} max={4096} value={settings.context.safetyMarginTokens}
          onChange={event=>setNumber("context","safetyMarginTokens",Number(event.target.value))} disabled={saving}/>
        <small>Default: {defaults.context.safetyMarginTokens}</small>
      </label>
      <label>Recent messages
        <input type="number" min={1} max={100} value={settings.context.recentConversationMessages}
          onChange={event=>setNumber("context","recentConversationMessages",Number(event.target.value))} disabled={saving}/>
        <small>Default: {defaults.context.recentConversationMessages}</small>
      </label>
      <p className="hint">These values change Context Engine inputs without changing its deterministic selection algorithm.</p>
    </section>

    <section>
      <h3>Memory</h3>
      <label className="checkbox">Automatic long-term memory extraction
        <input type="checkbox" checked={settings.chat.automaticLongTermMemory}
          onChange={event=>onChange({...settings,chat:{...settings.chat,automaticLongTermMemory:event.target.checked}})} disabled={saving}/>
      </label>
      <label className="checkbox">Automatic Memory Agent
        <input type="checkbox" checked={settings.memoryAgent.enabled}
          onChange={event=>onChange({...settings,memoryAgent:{...settings.memoryAgent,enabled:event.target.checked}})} disabled={saving}/>
      </label>
      <label>Memory Agent provider preset
        <select value={settings.memoryAgent.providerPresetId??""}
          onChange={event=>onChange({...settings,memoryAgent:{...settings.memoryAgent,providerPresetId:event.target.value||null}})} disabled={saving}>
          <option value="">Not configured</option>
          {settings.memoryAgent.providerPresetId&&settings.memoryAgent.providerPresetId!==null&&!providerPresets.some(p=>p.id===settings.memoryAgent.providerPresetId)&&
            <option value={settings.memoryAgent.providerPresetId} disabled>Unavailable: {settings.memoryAgent.providerPresetId}</option>}
          {providerPresets.map(preset=><option key={preset.id} value={preset.id}>{preset.name||preset.id}{preset.id===activePresetId?" · active":""}</option>)}
        </select>
      </label>
      <label>Memory Agent model override
        <input value={settings.memoryAgent.model} onChange={event=>onChange({...settings,memoryAgent:{...settings.memoryAgent,model:event.target.value}})} placeholder="Preset model / discovered model" disabled={saving}/>
      </label>
      <label>Output Format
        <select value={settings.memoryAgent.outputMode} onChange={event=>onChange({...settings,memoryAgent:{...settings.memoryAgent,outputMode:event.target.value as AppSettings["memoryAgent"]["outputMode"]}})} disabled={saving}>
          <option value="auto">Auto</option>
          <option value="structured">Structured</option>
          <option value="plain">Plain</option>
        </select>
        <small>{settings.memoryAgent.outputMode==="auto"?"Structured first; Plain only on explicit capability/unsupported failure.":settings.memoryAgent.outputMode==="structured"?"Structured is explicit; unsupported is terminal.":"Plain text only; no response format is sent."}</small>
      </label>
      <label>Agent Prompt
        <textarea value={settings.memoryAgent.prompt} onChange={event=>onChange({...settings,memoryAgent:{...settings.memoryAgent,prompt:event.target.value}})} rows={10} maxLength={12000} disabled={saving}/>
        <small>{settings.memoryAgent.prompt===defaults.memoryAgent.prompt?"Default prompt":"Custom prompt"} · default version {settings.memoryAgent.defaultPromptVersion}</small>
      </label>
      <div className="actions">
        <button type="button" onClick={()=>{
          const previous=settings.memoryAgent.prompt===defaults.memoryAgent.prompt?settings.memoryAgent.promptBackup:settings.memoryAgent.prompt;
          onChange({...settings,memoryAgent:{...settings.memoryAgent,prompt:defaults.memoryAgent.prompt,promptBackup:previous||settings.memoryAgent.promptBackup}});
        }} disabled={saving}>Reset to Default</button>
        <button type="button" onClick={()=>{
          if(settings.memoryAgent.promptBackup){
            onChange({...settings,memoryAgent:{...settings.memoryAgent,prompt:settings.memoryAgent.promptBackup,promptBackup:settings.memoryAgent.prompt}});
          }
        }} disabled={saving||!settings.memoryAgent.promptBackup}>Restore Previous</button>
        <button type="button" onClick={()=>void onSave()} disabled={saving}>{saving?"Saving…":"Save"}</button>
      </div>
      <label>Memory items
        <input type="number" min={1} max={100} value={settings.memory.candidateLimit}
          onChange={event=>setNumber("memory","candidateLimit",Number(event.target.value))} disabled={saving}/>
        <small>Default: {defaults.memory.candidateLimit}</small>
      </label>
      <label>Retrieval candidates
        <input type="number" min={1} max={100} value={settings.retrieval.candidateLimit}
          onChange={event=>setNumber("retrieval","candidateLimit",Number(event.target.value))} disabled={saving}/>
        <small>Default: {defaults.retrieval.candidateLimit}</small>
      </label>
      <p className="hint">Memory storage, character/conversation isolation, deduplication, and extraction safety rules are not configurable here.</p>
    </section>

    <section>
      <h3>Semantic Memory Deduplication</h3>
      <label className="checkbox">Enabled
        <input type="checkbox" checked={settings.semanticDedup.enabled}
          onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,enabled:event.target.checked}})} disabled={saving}/>
      </label>
      <label>Embedding Provider Preset
        <select value={settings.semanticDedup.embeddingProviderPresetId??""}
          onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,embeddingProviderPresetId:event.target.value||null}})} disabled={saving}>
          <option value="">Not configured</option>
          {settings.semanticDedup.embeddingProviderPresetId&&!providerPresets.some(p=>p.id===settings.semanticDedup.embeddingProviderPresetId)&&
            <option value={settings.semanticDedup.embeddingProviderPresetId} disabled>Unavailable: {settings.semanticDedup.embeddingProviderPresetId}</option>}
          {providerPresets.map(preset=><option key={preset.id} value={preset.id}>{preset.name||preset.id}</option>)}
        </select>
      </label>
      <label>Embedding Model
        <input value={settings.semanticDedup.embeddingModel}
          onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,embeddingModel:event.target.value}})}
          placeholder="Explicit embedding model, e.g. mistral-embed" disabled={saving}/>
      </label>
      <div className="core-book-grid">
        <label>Candidate Similarity Threshold
          <input type="number" min="0" max="1" step="0.01" value={settings.semanticDedup.candidateSimilarityThreshold}
            onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,candidateSimilarityThreshold:Number(event.target.value)}})} disabled={saving}/>
          <small>Default: {defaults.semanticDedup.candidateSimilarityThreshold}. Heuristic candidate filter only; it is not a duplicate decision.</small>
        </label>
        <label>Candidate Limit
          <input type="number" min="1" max="100" step="1" value={settings.semanticDedup.candidateLimit}
            onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,candidateLimit:Number(event.target.value)}})} disabled={saving}/>
          <small>Default: {defaults.semanticDedup.candidateLimit}. Only the top candidates are sent to the Judge.</small>
        </label>
      </div>
      <p className="hint">Embeddings detect potentially similar active memories for the same character. They are not used for normal Chat memory retrieval.</p>
    </section>

    <section>
      <h3>Memory Judge</h3>
      <label className="checkbox">Enabled
        <input type="checkbox" checked={settings.semanticDedup.judge.enabled}
          onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge,enabled:event.target.checked}}})} disabled={saving}/>
      </label>
      <label>Judge Provider Preset
        <select value={settings.semanticDedup.judge.providerPresetId??""}
          onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge,providerPresetId:event.target.value||null}}})} disabled={saving}>
          <option value="">Not configured</option>
          {settings.semanticDedup.judge.providerPresetId&&!providerPresets.some(p=>p.id===settings.semanticDedup.judge.providerPresetId)&&
            <option value={settings.semanticDedup.judge.providerPresetId} disabled>Unavailable: {settings.semanticDedup.judge.providerPresetId}</option>}
          {providerPresets.map(preset=><option key={preset.id} value={preset.id}>{preset.name||preset.id}</option>)}
        </select>
      </label>
      <label>Judge Model
        <input value={settings.semanticDedup.judge.model}
          onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge,model:event.target.value}}})}
          placeholder="Explicit judge model" disabled={saving}/>
      </label>
      <label>Judge Output Mode
        <select value={settings.semanticDedup.judge.outputMode}
          onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge,outputMode:event.target.value as AppSettings["semanticDedup"]["judge"]["outputMode"]}}})} disabled={saving}>
          <option value="auto">Auto</option>
          <option value="structured">Structured</option>
          <option value="plain">Plain</option>
        </select>
        <small>{settings.semanticDedup.judge.outputMode==="auto"?"Structured first; Plain only on explicit capability/unsupported failure.":settings.semanticDedup.judge.outputMode==="structured"?"Structured is explicit; unsupported is terminal.":"Plain text only; no response format is sent."}</small>
      </label>
      <label>Judge Prompt
        <textarea value={settings.semanticDedup.judge.prompt}
          onChange={event=>onChange({...settings,semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge,prompt:event.target.value}}})}
          rows={10} maxLength={12000} disabled={saving}/>
        <small>{settings.semanticDedup.judge.prompt===defaults.semanticDedup.judge.prompt?"Default prompt":"Custom prompt"} · default version {settings.semanticDedup.judge.defaultPromptVersion}</small>
      </label>
      <div className="actions">
        <button type="button" onClick={()=>{
          const previous=settings.semanticDedup.judge.prompt===defaults.semanticDedup.judge.prompt?settings.semanticDedup.judge.promptBackup:settings.semanticDedup.judge.prompt;
          onChange({...settings,semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge,prompt:defaults.semanticDedup.judge.prompt,promptBackup:previous||settings.semanticDedup.judge.promptBackup}}});
        }} disabled={saving}>Reset to Default</button>
        <button type="button" onClick={()=>{
          if(settings.semanticDedup.judge.promptBackup){
            onChange({...settings,semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge,prompt:settings.semanticDedup.judge.promptBackup,promptBackup:settings.semanticDedup.judge.prompt}}});
          }
        }} disabled={saving||!settings.semanticDedup.judge.promptBackup}>Restore Previous</button>
        <button type="button" onClick={()=>void onSave()} disabled={saving}>{saving?"Saving…":"Save"}</button>
      </div>
      <p className="hint">The Judge receives only the real candidate IDs and their canonical text. The Judge never archives or edits Memory; deterministic Core validation does.</p>
    </section>

    <section>
      <h3>Diagnostics</h3>
      <label>Log level
        <select value={settings.diagnostics.logLevel as DiagnosticsLogLevel}
          onChange={event=>onChange({...settings,diagnostics:{...settings.diagnostics,logLevel:event.target.value as DiagnosticsLogLevel}})} disabled={saving}>
          <option value="off">Off</option>
          <option value="errors">Errors</option>
          <option value="normal">Normal</option>
          <option value="verbose">Verbose</option>
          <option value="debug">Debug</option>
        </select>
        <small>Default: {defaults.diagnostics.logLevel}</small>
      </label>
      <label>Recent diagnostic entries
        <input type="number" min={1} max={500} value={settings.diagnostics.keepRecentEntries}
          onChange={event=>setNumber("diagnostics","keepRecentEntries",Number(event.target.value))} disabled={saving}/>
        <small>Default: {defaults.diagnostics.keepRecentEntries}</small>
      </label>
      <p className="hint">Logs are redacted for credentials, Authorization/Bearer tokens, passwords, API keys, and secrets.</p>
    </section>

    <section>
      <h3>UI</h3>
      <label className="checkbox">Show diagnostics in the application
        <input type="checkbox" checked={settings.ui.showDiagnosticsInChat}
          onChange={event=>onChange({...settings,ui:{...settings.ui,showDiagnosticsInChat:event.target.checked}})} disabled={saving}/>
      </label>
      <p className="hint">Model, temperature, topP, and maxTokens remain in Model Profile and are intentionally not duplicated here.</p>
      <div className="actions">
        <button type="button" onClick={()=>void onSave()} disabled={saving}>{saving?"Saving…":"Save Settings"}</button>
      </div>
      {message&&<div className="notice" role="status">{message}</div>}
    </section>
  </div>;
}

function TraceCandidate({candidate}:{candidate:any}){
  return <div className="diagnostic-candidate">
    <div className="diagnostic-candidate-header">
      <strong>{candidate.source}</strong>
      <span>{candidate.zone}</span>
      <span>score {candidate.selectionScore}</span>
    </div>
    <div className="diagnostic-candidate-content">{candidate.content}</div>
    <div className="diagnostic-candidate-meta">
      relevance {candidate.relevance} · retention {candidate.retentionPriority} · recency {candidate.recency} · tokens {candidate.estimatedTokens}
    </div>
    <div className="diagnostic-reason">{candidate.reason}</div>
  </div>;
}

function DiagnosticsView({runtime,settings}:{runtime:FoundationRuntime;settings:AppSettings}){
  const [traces,setTraces]=React.useState<readonly ChatTurnTrace[]>([]);
  const [semanticDiagnostics,setSemanticDiagnostics]=React.useState<readonly ErrorDiagnostic[]>([]);
  const [selectedId,setSelectedId]=React.useState<string|undefined>();
  const [message,setMessage]=React.useState("");
  const [showRaw,setShowRaw]=React.useState(false);

  // Bridge the runtime DiagnosticsStore into the existing Diagnostics screen so semantic-memory events are visible with turn traces.
  const refresh=React.useCallback(()=>{
    try{
      const next=runtime.listChatTraces(50);
      setTraces(next);
      setSelectedId(current=>current&&next.some(trace=>trace.turnId===current)?current:next[0]?.turnId);
      setMessage("");
    }catch(error){setMessage(error instanceof Error?error.message:"Diagnostics could not be loaded.");}
    void runtime.diagnostics().then(snapshot=>{
      setSemanticDiagnostics(snapshot.recentErrors.filter(entry=>entry.source==="memory-semantic-deduplication"));
    }).catch(error=>{
      setMessage(error instanceof Error?error.message:"Semantic diagnostics could not be loaded.");
    });
  },[runtime]);

  React.useEffect(()=>{
    refresh();
    const timer=setInterval(refresh,750);
    return ()=>clearInterval(timer);
  },[refresh]);

  const selected=traces.find(trace=>trace.turnId===selectedId);

  return <div className="settings-grid">
    <section>
      <div className="section-header">
        <div><h2>Diagnostics</h2><p className="chat-subtitle">Technical turn traces and semantic-memory diagnostics; no model chain-of-thought is recorded.</p></div>
        <button type="button" onClick={()=>{runtime.clearChatTraces();refresh()}}>Clear Logs</button>
      </div>
      <div className="status-grid">
        <span>Log level</span><strong>{settings.diagnostics.logLevel}</strong>
        <span>Retained turn traces</span><strong>{traces.length}</strong>
      </div>
      {traces.length===0
        ?<div>No chat traces yet.</div>
        :traces.map(trace=>
          <button type="button" className={trace.turnId===selectedId?"diagnostic-trace-row active":"diagnostic-trace-row"} key={trace.turnId} onClick={()=>setSelectedId(trace.turnId)}>
            <span>{trace.status}</span><span>{trace.requestId}</span><small>{trace.conversationId}</small>
          </button>
        )}
      {message&&<div className="error">{message}</div>}
    </section>

    <section>
      <h2>Memory Deduplication</h2>
      {(()=>{
        const configEntry=semanticDiagnostics.find(entry=>entry.code==="SEMANTIC_DEDUP_SETTINGS_APPLIED"||entry.code==="SEMANTIC_DEDUP_RUNTIME_READY");
        const metadata=configEntry?.metadata??{};
        return configEntry&&<div className="status-grid">
          <span>Semantic Dedup enabled</span><strong>{metadata.semanticDedupEnabled===true?"true":metadata.semanticDedupEnabled===false?"false":"—"}</strong>
          <span>Judge enabled</span><strong>{metadata.judgeEnabled===true?"true":metadata.judgeEnabled===false?"false":"—"}</strong>
          <span>Judge preset</span><strong>{String(metadata.judgeProviderPresetId??"—")}</strong>
          <span>Judge model</span><strong>{String(metadata.judgeModel??"—")||"—"}</strong>
          <span>Judge output mode</span><strong>{String(metadata.judgeOutputMode??"—")}</strong>
          <span>MemoryCreated subscribers</span><strong>{String(metadata.memoryCreatedSubscribers??"—")}</strong>
        </div>;
      })()}
      <div className="status-grid">
        <span>Status</span><strong>{semanticDiagnostics[0]?.code??"No events yet"}</strong>
        <span>Events</span><strong>{semanticDiagnostics.length}</strong>
        <span>Last message</span><strong>{semanticDiagnostics[0]?.message??"Create a Memory to observe the production deduplication path."}</strong>
      </div>
      {semanticDiagnostics.length===0
        ?<div>No semantic-memory diagnostics yet.</div>
        :semanticDiagnostics.map((entry,index)=>{
          const metadata=entry.metadata??{};
          const candidates=Array.isArray(metadata.candidateDiagnostics)?metadata.candidateDiagnostics as Array<Record<string,unknown>>:[];
          const selections=Array.isArray(metadata.judgeSelections)?metadata.judgeSelections as string[]:[];
          const mapping=Array.isArray(metadata.archiveMapping)?metadata.archiveMapping as Array<Record<string,unknown>>:[];
          return <div className="diagnostic-block" key={entry.timestamp+"-"+entry.code+"-"+index}>
            <div className="section-header">
              <strong>{entry.code}</strong>
              <small>{entry.timestamp}</small>
            </div>
            <div>{entry.message}</div>
            {candidates.length>0&&<div>
              <h4>Candidates</h4>
              {candidates.map((candidate,candidateIndex)=>
                <div className="diagnostic-candidate" key={String(candidate.memoryId??candidateIndex)}>
                  <div className="diagnostic-candidate-header">
                    <strong>#{String(candidate.number??candidateIndex+1)}</strong>
                    <span>{candidate.containmentMatch===true?"containment match":"semantic match"}</span>
                    <span>similarity {typeof candidate.similarity==="number"?candidate.similarity.toFixed(3):"—"}</span>
                  </div>
                  <div className="diagnostic-candidate-content">{String(candidate.content??"")}</div>
                  <div className="diagnostic-candidate-meta">memory {String(candidate.memoryId??"—")}</div>
                </div>
              )}
            </div>}
            {selections.length>0&&<div className="diagnostic-reason">Judge output: {selections.join(", ")}</div>}
            {mapping.length>0&&<div className="diagnostic-reason">Mapped archive IDs: {mapping.map(item=>String(item.selection)+" → "+String(item.memoryId)).join(", ")}</div>}
            {typeof metadata.mutationResult==="string"&&<div className="diagnostic-reason">Mutation result: {metadata.mutationResult}</div>}
            {typeof metadata.reason==="string"&&<div className="diagnostic-reason">Reason: {metadata.reason}</div>}
            {typeof metadata.fallbackReason==="string"&&<div className="diagnostic-reason">Fallback: {metadata.fallbackReason}</div>}
          </div>;
        })}
    </section>

    {selected&&<section>
      <h2>Turn</h2>
      <div className="status-grid">
        <span>Request</span><strong>{selected.requestId}</strong>
        <span>Character</span><strong>{selected.characterId}</strong>
        <span>Conversation</span><strong>{selected.conversationId}</strong>
        <span>Status</span><strong>{selected.status}</strong>
        <span>Timestamp</span><strong>{selected.timestamp}</strong>
        <span>Duration</span><strong>{selected.durationMs===undefined?"—":selected.durationMs+" ms"}</strong>
      </div>

      {selected.contextBuild&&<div className="diagnostic-block">
        <h3>Context Build</h3>
        <p>Context size {selected.contextBuild.budget.availableContextTokens} · Reserved {selected.contextBuild.budget.reservedOutputTokens} · Safety margin {selected.contextBuild.budget.safetyMarginTokens} · Estimated {selected.contextBuild.estimatedTokens} tokens</p>
        <h4>Included</h4>
        {selected.contextBuild.includedCandidates.length===0?<div>None</div>:selected.contextBuild.includedCandidates.map(candidate=><TraceCandidate key={candidate.id} candidate={candidate}/>)}
        <h4>Omitted</h4>
        {selected.contextBuild.omittedCandidates.length===0?<div>None</div>:selected.contextBuild.omittedCandidates.map(candidate=><TraceCandidate key={candidate.id} candidate={candidate}/>)}
      </div>}

      {selected.finalRequest&&<div className="diagnostic-block">
        <h3>Final Request</h3>
        <div className="status-grid">
          <span>Provider</span><strong>{selected.finalRequest.providerId??"default"}</strong>
          <span>Model</span><strong>{selected.finalRequest.model}</strong>
          <span>Generation</span><strong>{JSON.stringify(selected.finalRequest.generation??{})}</strong>
        </div>
        <pre className="diagnostic-json">{JSON.stringify(selected.finalRequest.context.messages,null,2)}</pre>
      </div>}

      {selected.provider&&<div className="diagnostic-block">
        <h3>Effective Chat Provider</h3>
        <div className="status-grid">
          <span>Preset</span><strong>{selected.provider.chatProviderPresetId??"—"}</strong>
          <span>Provider</span><strong>{selected.provider.chatProviderId}</strong>
          <span>Model</span><strong>{selected.provider.chatModel}</strong>
          <span>Base URL host</span><strong>{selected.provider.chatProviderBaseUrlHost??"—"}</strong>
          <span>Timeout</span><strong>{selected.provider.chatProviderTimeoutMs===undefined?"—":selected.provider.chatProviderTimeoutMs+" ms"}</strong>
          <span>Transport</span><strong>{selected.provider.chatTransport}</strong>
        </div>
      </div>}

      {selected.providerError&&<div className="diagnostic-block">
        <h3>Provider Failure Details</h3>
        <div className="status-grid">
          <span>Preset</span><strong>{selected.providerError.providerPresetId??"—"}</strong>
          <span>Provider</span><strong>{selected.providerError.providerId??"—"}</strong>
          <span>Category</span><strong>{selected.providerError.category??"—"}</strong>
          <span>HTTP status</span><strong>{selected.providerError.httpStatus??"—"}</strong>
          <span>Timeout</span><strong>{selected.providerError.timeoutMs===undefined?"—":selected.providerError.timeoutMs+" ms"}</strong>
          <span>Provider duration</span><strong>{selected.providerError.durationMs===undefined?"—":selected.providerError.durationMs+" ms"}</strong>
        </div>
        {selected.providerError.providerResponse!==undefined&&<pre className="diagnostic-json">{JSON.stringify(selected.providerError.providerResponse,null,2)}</pre>}
      </div>}

      {selected.providerResponse&&<div className="diagnostic-block">
        <h3>Provider Response</h3>
        <div className="status-grid">
          <span>Provider</span><strong>{selected.providerResponse.providerId}</strong>
          <span>Model</span><strong>{selected.providerResponse.model}</strong>
          <span>Finish</span><strong>{selected.providerResponse.finishReason}</strong>
          <span>Usage</span><strong>{JSON.stringify(selected.providerResponse.usage??{})}</strong>
          <span>Duration</span><strong>{selected.providerResponse.durationMs===undefined?"—":selected.providerResponse.durationMs+" ms"}</strong>
        </div>
      </div>}

      {selected.automaticMemory&&<div className="diagnostic-block">
        <h3>Automatic Memory Agent</h3>
        <div className="status-grid">
          <span>Started</span><strong>{selected.automaticMemory.started?"yes":"no"}</strong>
          <span>Status</span><strong>{selected.automaticMemory.status??"—"}</strong>
          <span>Preset</span><strong>{selected.automaticMemory.providerPresetId??"—"}</strong>
          <span>Provider</span><strong>{selected.automaticMemory.providerId??"—"}</strong>
          <span>Model</span><strong>{selected.automaticMemory.model??"—"}</strong>
          <span>Origin conversation</span><strong>{selected.automaticMemory.conversationId??"—"}</strong>
          <span>Context messages</span><strong>{selected.automaticMemory.contextMessageCount??"—"}</strong>
          <span>Persistence</span><strong>{selected.automaticMemory.persistence?.status??"—"}</strong>
          <span>Memory id</span><strong>{selected.automaticMemory.persistence?.memoryId??"—"}</strong>
        </div>
        {selected.automaticMemory.result&&<pre className="diagnostic-json">{selected.automaticMemory.result}</pre>}
        {selected.automaticMemory.failed&&<div className="error">{selected.automaticMemory.failed}</div>}
        {selected.automaticMemory.persistence?.reason&&<div className="diagnostic-reason">{selected.automaticMemory.persistence.reason}</div>}
      </div>}

      {selected.memoryExtraction&&<div className="diagnostic-block">
        <h3>Automatic Memory Extraction</h3>
        <p>Started: {selected.memoryExtraction.started?"yes":"no"}</p>
         <div className="status-grid">
           <span>Status</span><strong>{selected.memoryExtraction.status??"—"}</strong>
           <span>Provider</span><strong>{selected.memoryExtraction.providerId??"—"}</strong>
           <span>Model</span><strong>{selected.memoryExtraction.model??"—"}</strong>
           <span>Request</span><strong>{selected.memoryExtraction.requestId??"—"}</strong>
           <span>Conversation</span><strong>{selected.memoryExtraction.conversationId??"—"}</strong>
           <span>Context messages</span><strong>{selected.memoryExtraction.contextMessageCount===undefined?"—":selected.memoryExtraction.contextMessageCount}</strong>
         </div>
        <h4>Candidates</h4>{selected.memoryExtraction.candidates.length===0?<div>None</div>:selected.memoryExtraction.candidates.map((candidate,index)=><TraceCandidate key={candidate.content+index} candidate={candidate}/>)}
        <h4>Accepted</h4>{selected.memoryExtraction.accepted.length===0?<div>None</div>:selected.memoryExtraction.accepted.map((candidate,index)=><TraceCandidate key={candidate.content+index} candidate={candidate}/>)}
        <h4>Rejected</h4>{selected.memoryExtraction.rejected.length===0?<div>None</div>:selected.memoryExtraction.rejected.map((item,index)=><div className="diagnostic-candidate" key={item.candidate.content+index}><div className="diagnostic-reason">{item.reason}</div><TraceCandidate candidate={item.candidate}/></div>)}
        <h4>Duplicates</h4>{selected.memoryExtraction.duplicate.length===0?<div>None</div>:selected.memoryExtraction.duplicate.map((candidate,index)=><TraceCandidate key={candidate.content+index} candidate={candidate}/>)}
        <h4>Superseded</h4>{selected.memoryExtraction.superseded.length===0?<div>None</div>:selected.memoryExtraction.superseded.map(item=><div className="row" key={item.memoryId}><span>{item.candidate.content}</span><span>{item.memoryId}</span></div>)}
        <h4>Created</h4>{selected.memoryExtraction.created.length===0?<div>None</div>:selected.memoryExtraction.created.map(item=><div className="row" key={item.memoryId}><span>{item.candidate.content}</span><span>{item.memoryId}</span></div>)}
        {selected.memoryExtraction.failed&&<div className="error">{selected.memoryExtraction.failed}</div>}
      </div>}

      {selected.error&&<div className="error">{selected.error.code}: {selected.error.message}</div>}
      <div className="diagnostic-block">
        <button type="button" onClick={()=>setShowRaw(current=>!current)}>{showRaw?"Hide raw trace":"Show raw trace"}</button>
        {showRaw&&<pre className="diagnostic-json">{JSON.stringify(selected,null,2)}</pre>}
      </div>
    </section>}
  </div>;
}


class ViewErrorBoundary extends React.Component<{
  view:string;
  onError:(error:Error,info:React.ErrorInfo)=>void;
  children:React.ReactNode;
},{hasError:boolean;message:string}>{
  state={hasError:false,message:""};
  static getDerivedStateFromError(error:Error):{hasError:boolean;message:string}{
    return {hasError:true,message:safeErrorMessage(error,"Unknown view error")};
  }
  componentDidCatch(error:Error,info:React.ErrorInfo):void{
    this.props.onError(error,info);
  }
  componentDidUpdate(previousProps:Readonly<{view:string}>):void{
    if(previousProps.view!==this.props.view&&this.state.hasError)this.setState({hasError:false,message:""});
  }
  private retry=()=>this.setState({hasError:false,message:""});
  render(){
    if(this.state.hasError){
      return <section className="loading-panel" role="alert">
        <strong>This view failed to load.</strong>
        <div>{this.state.message}</div>
        <button type="button" onClick={this.retry}>Retry view</button>
      </section>;
    }
    return this.props.children;
  }
}

function SettingsContainerView({
  appSettings,onAppSettingsChange,settingsLoadMessage,settingsSaving,onSaveSettings,onResetSettings,
  runtime,providerPresets,activePresetId,credentialProfiles,credentialSavedMap,
  onSavePreset,onActivatePreset,onDeletePreset,onCreateCredential,onDeleteCredential,onRefreshModels,onTestPreset,onError
}:{
  appSettings:AppSettings;
  onAppSettingsChange:(settings:AppSettings)=>void;
  settingsLoadMessage:string;
  settingsSaving:boolean;
  onSaveSettings:()=>Promise<void>;
  onResetSettings:()=>Promise<void>;
  runtime:RuntimeDiagnostics;
  providerPresets:readonly ProviderPreset[];
  activePresetId:string|null;
  credentialProfiles:readonly CredentialProfile[];
  credentialSavedMap:Record<string,boolean>;
  onSavePreset:(preset:ProviderPreset,activate:boolean)=>Promise<void>;
  onActivatePreset:(id:string)=>Promise<void>;
  onDeletePreset:(id:string)=>Promise<void>;
  onCreateCredential:(label:string,secret:string)=>Promise<CredentialProfile>;
  onDeleteCredential:(id:string)=>Promise<void>;
  onRefreshModels:(preset:ProviderPreset)=>Promise<readonly ModelInfo[]>;
  onTestPreset:(preset:ProviderPreset)=>Promise<ProviderConnectionTestResult>;
  onError:(error:Error,info:React.ErrorInfo)=>void;
}){
  const [tab,setTab]=React.useState<"general"|"provider-presets">("general");
  return <section className="settings-container" aria-label="Settings">
    <div className="settings-subnav" role="tablist" aria-label="Settings sections">
      <button type="button" role="tab" aria-selected={tab==="general"} className={tab==="general"?"nav-button active":"nav-button"} onClick={()=>setTab("general")}>General</button>
      <button type="button" role="tab" aria-selected={tab==="provider-presets"} className={tab==="provider-presets"?"nav-button active":"nav-button"} onClick={()=>setTab("provider-presets")}>Provider Presets</button>
    </div>
    {tab==="general"
      ?<ViewErrorBoundary key="settings-general" view="settings-general" onError={onError}>
        <AppSettingsView settings={appSettings} onChange={onAppSettingsChange} onSave={onSaveSettings} onReset={onResetSettings} saving={settingsSaving} message={settingsLoadMessage} providerPresets={providerPresets} activePresetId={activePresetId}/>
      </ViewErrorBoundary>
      :<ViewErrorBoundary key="settings-provider-presets" view="settings-provider-presets" onError={onError}>
        <ProviderPresetsView presets={providerPresets} activePresetId={activePresetId} credentialProfiles={credentialProfiles} credentialSaved={credentialSavedMap}
          runtime={runtime} onSavePreset={onSavePreset} onActivatePreset={onActivatePreset} onDeletePreset={onDeletePreset}
          onCreateCredential={onCreateCredential} onDeleteCredential={onDeleteCredential} onRefreshModels={onRefreshModels} onTestPreset={onTestPreset}/>
      </ViewErrorBoundary>}
  </section>;
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
  const [view,setView]=React.useState<"chat"|"characters"|"memory"|"core-book"|"model-profile"|"settings"|"diagnostics">("chat");
  const [runtime,setRuntime]=React.useState<RuntimeDiagnostics>(preview);
  const [saving,setSaving]=React.useState(false);
  const [startupStatus,setStartupStatus]=React.useState<"initializing"|"ready"|"error">("initializing");
  const [startupError,setStartupError]=React.useState("");
  const [characters,setCharacters]=React.useState<readonly Character[]>([]);
  const [activeCharacter,setActiveCharacter]=React.useState<Character|undefined>();
  const [activeModelProfile,setActiveModelProfile]=React.useState<ModelProfile|undefined>();
  const [chatController,setChatController]=React.useState<ChatSessionController|null>(null);
  const [conversations,setConversations]=React.useState<readonly Conversation[]>([]);
  const [activeConversation,setActiveConversation]=React.useState<Conversation|undefined>();
  const foundationRef=React.useRef<FoundationRuntime|undefined>(undefined);
  const providerConfigurationErrorRef=React.useRef<string|undefined>(undefined);
  const conversationLoadErrorRef=React.useRef<string|undefined>(undefined);
  const modelProfileLoadErrorRef=React.useRef<string|undefined>(undefined);
  const credentialStore=React.useMemo(()=>new IpcCredentialStore(invoke),[]);
  const configurationStore=React.useMemo(()=>new IpcProviderConfigurationStore(invoke),[]);
  const characterStore=React.useMemo(()=>isTauriRuntime()?new IpcCharacterStore(invoke):new InMemoryCharacterStore(),[]);
  const coreBookStore=React.useMemo(()=>isTauriRuntime()?new IpcCoreBookStore(invoke):new InMemoryCoreBookStore(),[]);
  const memoryStore=React.useMemo(()=>isTauriRuntime()?new IpcMemoryStore(invoke):new InMemoryMemoryStore(),[]);
  const conversationStore=React.useMemo(()=>isTauriRuntime()?new IpcConversationStore(invoke):new InMemoryConversationStore(),[]);
  const modelProfileStore=React.useMemo(()=>isTauriRuntime()?new IpcModelProfileStore(invoke):new InMemoryModelProfileStore(),[]);
  const credentialProfileStore=React.useMemo(()=>isTauriRuntime()?new IpcCredentialProfileStore(invoke):new InMemoryCredentialProfileStore(),[]);
  const providerPresetStore=React.useMemo(()=>isTauriRuntime()?new IpcProviderPresetStore(invoke):new InMemoryProviderPresetStore(),[]);
  const settingsValidator=React.useMemo(()=>new StandardContractValidator(),[]);
  const settingsStore=React.useMemo(()=>isTauriRuntime()?new IpcSettingsStore(invoke,settingsValidator):new InMemorySettingsStore(settingsValidator),[settingsValidator]);
  const [credentialProfiles,setCredentialProfiles]=React.useState<readonly CredentialProfile[]>([]);
  const [credentialSavedMap,setCredentialSavedMap]=React.useState<Record<string,boolean>>({});
  const [providerPresets,setProviderPresets]=React.useState<readonly ProviderPreset[]>([]);
  const [activePresetId,setActivePresetId]=React.useState<string|null>(null);
  const [appSettings,setAppSettings]=React.useState<AppSettings>(()=>defaultAppSettings());
  const semanticIndexStore=React.useMemo(()=>isTauriRuntime()?new IpcMemorySemanticIndexStore(invoke):undefined,[]);
  const [settingsLoadMessage,setSettingsLoadMessage]=React.useState("");
  const credentialProfileStateRef=React.useRef<CredentialProfileStoreState>(emptyCredentialProfileState());
  const providerPresetStateRef=React.useRef<ProviderPresetStoreState>(emptyProviderPresetState());
  const retriever=React.useMemo(()=>isTauriRuntime()?new IpcFullTextRetriever(invoke):undefined,[]);

  const reportViewError=React.useCallback((error:Error,info:React.ErrorInfo)=>{
    foundationRef.current?.recordDiagnosticError(
      "ui-view",
      "VIEW_RENDER_FAILED",
      safeErrorMessage(error,"Unknown view error"),
      {view,componentStack:info.componentStack??""}
    );
  },[view]);

  const controllerForSession=React.useCallback((session:ConversationSession)=>new ChatSessionController(
    session,
    {
      chat:(request,providerPresetId)=>{
        const foundation=foundationRef.current;
        if(!foundation)return Promise.reject(new Error("Chat runtime is not available."));
        return foundation.chat(request,providerPresetId);
      },
      stream:(request,handlers,options,providerPresetId)=>{
        const foundation=foundationRef.current;
        if(!foundation)return Promise.reject(new Error("Chat runtime is not available."));
        return foundation.stream(request,handlers,options,providerPresetId);
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
      },
      contextBudgetProvider:()=>{
        const foundation=foundationRef.current;
        const settings=foundation?.getSettings()??defaultAppSettings();
        return {
          availableContextTokens:settings.context.availableContextTokens,
          reservedOutputTokens:settings.context.reservedOutputTokens,
          systemOverheadTokens:0,
          safetyMarginTokens:settings.context.safetyMarginTokens
        };
      },
      recentConversationMessagesProvider:()=>foundationRef.current?.getSettings().context.recentConversationMessages??defaultAppSettings().context.recentConversationMessages,
      memoryExtractor:{
        extract:request=>{
          const foundation=foundationRef.current;
          return foundation?foundation.extractMemory(request):Promise.resolve([]);
        }
      },
      memoryExtractionEnabled:()=>{
        return foundationRef.current?.getSettings().chat.automaticLongTermMemory??true;
      },
      traceStore:foundationRef.current?.getChatTraceStore()
    }
  ),[]);

  const controllerForConversation=React.useCallback((conversation:Conversation,profile:ModelProfile)=> {
    const session=new ConversationSession(conversation.id,conversation.characterId);
    for(const message of conversation.messages)session.addMessage(message);
    const controller=controllerForSession(session);
    controller.setModelProfile(profile);
    return controller;
  },[controllerForSession]);

  const loadModelProfile=React.useCallback(async(characterId:string):Promise<ModelProfile>=>{
    try{
      const stored=await modelProfileStore.load(characterId);
      if(stored){
        if(stored.characterId!==characterId)throw new Error("Model profile character scope mismatch.");
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

  const loadActiveConversation=React.useCallback(async(characterId:string):Promise<{conversation:Conversation;controller:ChatSessionController}>=>{
    const foundation=foundationRef.current;
    if(!foundation)throw new Error("Conversation runtime is not available.");
    const [conversation,profile]=await Promise.all([
      foundation.getActiveConversation(characterId),
      loadModelProfile(characterId)
    ]);
    return {conversation,controller:controllerForConversation(conversation,profile)};
  },[controllerForConversation,loadModelProfile]);

  const persistConversation=React.useCallback(async(controller:ChatSessionController)=>{
    const snapshot=controller.getSnapshot();
    const foundation=foundationRef.current;
    if(!foundation)throw new Error("Conversation runtime is not available.");
    const updated=await foundation.updateConversation(
      snapshot.characterId,
      snapshot.conversationId,
      {messages:snapshot.messages}
    );
    if(snapshot.characterId===activeCharacter?.id){
      const listed=await foundation.listConversations(snapshot.characterId);
      setConversations(listed);
      setActiveConversation(updated);
    }
    conversationLoadErrorRef.current=undefined;
  },[activeCharacter]);

  const clearConversation=React.useCallback(async(controller:ChatSessionController)=>{
    const foundation=foundationRef.current;
    if(!foundation)throw new Error("Conversation runtime is not available.");
    const snapshot=controller.getSnapshot();
    controller.clear();
    setActiveConversation(current=>current?{...current,messages:[]}:current);
    setChatController(controller);
    try{
      await foundation.clearConversation(snapshot.characterId,snapshot.conversationId);
      const active=await foundation.getActiveConversation(snapshot.characterId);
      setActiveConversation(active);
      setConversations(await foundation.listConversations(snapshot.characterId));
      conversationLoadErrorRef.current=undefined;
    }catch(error){
      await persistConversation(controller);
      throw error;
    }
  },[controllerForConversation,loadModelProfile,persistConversation]);

  const syncCharacters=React.useCallback(async(runtimeInstance:FoundationRuntime)=>{
    const list=await runtimeInstance.listCharacters();
    const active=await runtimeInstance.getActiveCharacter();
    const loaded=await (async()=>{
      const conversation=await runtimeInstance.getActiveConversation(active.id);
      const profile=await loadModelProfile(active.id);
      return {conversation,profile,controller:controllerForConversation(conversation,profile)};
    })();
    setCharacters(list);
    setActiveCharacter(active);
    setConversations(await runtimeInstance.listConversations(active.id));
    setActiveConversation(loaded.conversation);
    setActiveModelProfile(loaded.profile);
    setChatController(loaded.controller);
  },[controllerForConversation,loadModelProfile]);

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
    setChatController(null);
    await foundationRef.current?.stop();
    const next=await startFoundationRuntime({
      providerConfiguration:config,credentialStore,characterStore,coreBookStore,memoryStore,semanticIndexStore,conversationStore,retriever,retrievalIndexWriter:retriever,
      providerPresetConfigurations:materializePresetConfigurations(presetState.presets,credentialState.profiles),
      settingsStore,
      activeProviderPresetId:presetState.activePresetId??undefined
    });
    foundationRef.current=next;
    setRuntime(await publishAndReadRuntimeDiagnostics(addConfigurationLoadError(await next.diagnostics())));
    await syncCharacters(next);
    setRuntime(await publishAndReadRuntimeDiagnostics(addConfigurationLoadError(await next.diagnostics())));
    setStartupStatus("ready");
    setStartupError("");
  },[addConfigurationLoadError,characterStore,coreBookStore,memoryStore,semanticIndexStore,credentialStore,retriever,conversationStore,syncCharacters]);

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
          const migrationBase=migrateProviderConfiguration(legacy);
          const existing=migrationBase.credentialProfile?credentialState.profiles.find(profile=>profile.credentialReference.id===migrationBase.credentialProfile!.credentialReference.id):undefined;
          const migration=migrateProviderConfiguration(legacy,new Date().toISOString(),existing?.id);
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
        await refreshRuntime(activeConfiguration,loaded.error,presetState,credentialState);
        const loadedSettings=foundationRef.current?.getSettings()??defaultAppSettings();
        setAppSettings(loadedSettings);
        if(!active)return;
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
    if(!foundation||chatController?.getSnapshot().sending)return;
    const selected=await foundation.setActiveCharacter(id);
    const loaded=await loadActiveConversation(selected.id);
    setActiveCharacter(selected);
    setActiveConversation(loaded.conversation);
    setConversations(await foundation.listConversations(selected.id));
    setActiveModelProfile(loaded.controller.getModelProfile()??defaultModelProfile(selected.id));
    setChatController(loaded.controller);
    setView("chat");
  },[chatController,loadActiveConversation]);

  const selectConversation=React.useCallback(async(id:string)=>{
    const foundation=foundationRef.current;
    const character=activeCharacter;
    if(!foundation||!character||chatController?.getSnapshot().sending)return;
    const previousConversation=activeConversation;
    const local=conversations.find(item=>item.id===id);
    const profile=activeModelProfile??await loadModelProfile(character.id);
    if(local){
      const optimistic=controllerForConversation(local,profile);
      setActiveConversation(local);setChatController(optimistic);setView("chat");
    }
    try{
      const conversation=await foundation.setActiveConversation(character.id,id);
      const controller=controllerForConversation(conversation,profile);
      setActiveConversation(conversation);
      setConversations(await foundation.listConversations(character.id));
      setChatController(controller);
    }catch(error){
      if(previousConversation){
        setActiveConversation(previousConversation);
        setChatController(controllerForConversation(previousConversation,profile));
      }
      throw error;
    }
  },[activeCharacter,activeConversation,activeModelProfile,chatController,controllerForConversation,conversations,loadModelProfile]);

  const createConversation=React.useCallback(async()=>{
    const foundation=foundationRef.current;
    const character=activeCharacter;
    if(!foundation||!character||chatController?.getSnapshot().sending)return;
    const conversation=await foundation.createConversation(character.id);
    const profile=activeModelProfile??await loadModelProfile(character.id);
    const controller=controllerForConversation(conversation,profile);
    setActiveConversation(conversation);
    setConversations(await foundation.listConversations(character.id));
    setChatController(controller);
    setView("chat");
  },[activeCharacter,activeModelProfile,chatController,controllerForConversation,loadModelProfile]);

  const renameConversation=React.useCallback(async(conversation:Conversation)=>{
    const foundation=foundationRef.current;
    const character=activeCharacter;
    if(!foundation||!character||chatController?.getSnapshot().sending)return;
    const value=window.prompt("Conversation name",conversation.title);
    if(value===null||!value.trim()||value.trim()===conversation.title)return;
    const updated=await foundation.updateConversation(character.id,conversation.id,{title:value});
    setConversations(await foundation.listConversations(character.id));
    if(activeConversation?.id===updated.id)setActiveConversation(updated);
  },[activeCharacter,activeConversation,chatController]);

  const deleteConversation=React.useCallback(async(conversation:Conversation)=>{
    const foundation=foundationRef.current;
    const character=activeCharacter;
    if(!foundation||!character||chatController?.getSnapshot().sending)return;
    const replacement=await foundation.deleteConversation(character.id,conversation.id);
    const profile=activeModelProfile??await loadModelProfile(character.id);
    const controller=controllerForConversation(replacement,profile);
    setActiveConversation(replacement);
    setConversations(await foundation.listConversations(character.id));
    setChatController(controller);
    setActiveModelProfile(profile);
  },[activeCharacter,activeModelProfile,chatController,controllerForConversation,loadModelProfile]);

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
    if(chatController?.getSnapshot().sending)throw new Error("Stop the current response before changing Character.");
    const before=activeCharacter;
    await foundation.deleteCharacter(id);
    try{await modelProfileStore.delete(id)}catch(error){modelProfileLoadErrorRef.current=safeStartupError(error)}
    const nextActive=await foundation.getActiveCharacter();
    const loaded=await loadActiveConversation(nextActive.id);
    setCharacters(await foundation.listCharacters());
    setActiveCharacter(nextActive);
    setConversations(await foundation.listConversations(nextActive.id));
    setActiveConversation(loaded.conversation);
    setActiveModelProfile(loaded.controller.getModelProfile()??defaultModelProfile(nextActive.id));
    if(before?.id===id||before?.id!==nextActive.id)setChatController(loaded.controller);
  },[activeCharacter,chatController,loadActiveConversation,modelProfileStore]);

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

  const createCredentialProfile=React.useCallback(async(label:string,secret:string):Promise<CredentialProfile>=>{
    const now=new Date().toISOString();const reference={id:"credential."+slugId(label)+"."+Date.now(),kind:"api-key",provider:"openai-compatible",version:"1"} as const;
    await credentialStore.setSecret(reference,secret);
    const saved=await credentialStore.exists(reference);
    if(!saved){
      throw new Error("Credential could not be verified after saving.");
    }
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
    return testProviderPresetConfiguration(config,credentialStore);
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

  const saveAppSettings=React.useCallback(async()=>{
    const errors=validateAppSettings(appSettings);
    if(errors.length){setSettingsLoadMessage(errors.join(" "));return;}
    const foundation=foundationRef.current;
    if(!foundation){setSettingsLoadMessage("Settings runtime is not available.");return;}
    setSaving(true);setSettingsLoadMessage("");
    try{
      const next=await foundation.updateSettings(appSettings);
      setAppSettings(next);
      setSettingsLoadMessage("Settings saved.");
    }catch(error){setSettingsLoadMessage(error instanceof Error?error.message:"Settings could not be saved.");}
    finally{setSaving(false);}
  },[appSettings]);

  const resetAppSettings=React.useCallback(async()=>{
    const foundation=foundationRef.current;
    if(!foundation){setSettingsLoadMessage("Settings runtime is not available.");return;}
    setSaving(true);setSettingsLoadMessage("");
    try{
      const next=await foundation.resetSettings();
      setAppSettings(next);
      setSettingsLoadMessage("Settings restored to defaults.");
    }catch(error){setSettingsLoadMessage(error instanceof Error?error.message:"Settings could not be reset.");}
    finally{setSaving(false);}
  },[]);

  return <main className="app-shell">
    <header className="app-header">
      <div><h1>Nova</h1><p>AI Companion</p></div>
      <nav className="app-nav" aria-label="Primary">
        <button className={view==="chat"?"nav-button active":"nav-button"} onClick={()=>setView("chat")}>Chat</button>
        <button className={view==="characters"?"nav-button active":"nav-button"} onClick={()=>setView("characters")}>Characters</button>
        <button className={view==="memory"?"nav-button active":"nav-button"} onClick={()=>setView("memory")}>Character Memory</button>
        <button className={view==="core-book"?"nav-button active":"nav-button"} onClick={()=>setView("core-book")}>Core Book</button>
        <button className={view==="model-profile"?"nav-button active":"nav-button"} onClick={()=>setView("model-profile")}>Model Profile</button>
        <button className={view==="settings"?"nav-button active":"nav-button"} onClick={()=>setView("settings")}>Settings</button>
        {appSettings.ui.showDiagnosticsInChat&&<button className={view==="diagnostics"?"nav-button active":"nav-button"} onClick={()=>setView("diagnostics")}>Diagnostics</button>}
      </nav>
    </header>
    <ViewErrorBoundary key={view} view={view} onError={reportViewError}>
    {view==="model-profile"&&activeCharacter&&activeModelProfile
      ?<ModelProfileView profile={activeModelProfile} runtime={runtime} presets={providerPresets} activePresetId={activePresetId} onSave={saveModelProfile}/>
      :view==="settings"
      ?<SettingsContainerView
          appSettings={appSettings}
          onAppSettingsChange={setAppSettings}
          settingsLoadMessage={settingsLoadMessage}
          settingsSaving={saving}
          onSaveSettings={saveAppSettings}
          onResetSettings={resetAppSettings}
          runtime={runtime}
          providerPresets={providerPresets}
          activePresetId={activePresetId}
          credentialProfiles={credentialProfiles}
          credentialSavedMap={credentialSavedMap}
          onSavePreset={saveProviderPreset}
          onActivatePreset={activateProviderPreset}
          onDeletePreset={deleteProviderPreset}
          onCreateCredential={createCredentialProfile}
          onDeleteCredential={deleteCredentialProfile}
          onRefreshModels={refreshPresetModels}
          onTestPreset={testPreset}
          onError={reportViewError}/>
      :view==="diagnostics"&&foundationRef.current
      ?<DiagnosticsView runtime={foundationRef.current} settings={appSettings}/>
      :startupStatus==="error"
        ?<section className="loading-panel" role="alert">
          <strong>Character runtime initialization failed.</strong>
          <div>{startupError}</div>
        </section>
      :view==="chat"&&activeCharacter&&chatController&&activeConversation
      ?<ChatView controller={chatController} runtime={foundationRef.current!} character={activeCharacter}
          conversations={conversations} activeConversation={activeConversation}
          onPersist={()=>persistConversation(chatController!)}
          onClear={()=>clearConversation(chatController!)}
          onSelectConversation={selectConversation}
          onCreateConversation={createConversation}
          onRenameConversation={renameConversation}
          onDeleteConversation={deleteConversation}/>
      :view==="characters"&&activeCharacter
        ?<CharactersView characters={characters} activeCharacter={activeCharacter}
          onSelect={selectCharacter} onCreate={createCharacter} onRename={renameCharacter} onDelete={deleteCharacter}/>
        :view==="memory"&&activeCharacter
          ?<CharacterMemoryView runtime={foundationRef.current!} character={activeCharacter} originConversationId={activeConversation?.id}/>
        :view==="core-book"&&activeCharacter
          ?<CoreBookView runtime={foundationRef.current!} character={activeCharacter}/>
          :<section className="loading-panel">Initializing characters…</section>}
    </ViewErrorBoundary>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
