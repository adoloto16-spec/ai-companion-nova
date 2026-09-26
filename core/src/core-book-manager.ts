import type {
  CharacterId,Clock,CoreBookActivation,CoreBookEntry,CoreBookEntryId,CoreBookEntrySource,
  CoreBookMutationPolicy,CoreBookStore,CoreBookStoreState,EventBus
} from "../../contracts/src/index";
import {CORE_BOOK_API_VERSION,CORE_BOOK_SCHEMA_VERSION,createEvent} from "../../contracts/src/index";

export interface CoreBookCreateInput{
  title:string;
  content:string;
  tags?:readonly string[];
  activation?:CoreBookActivation;
  retentionPriority?:number;
  placementWeight?:number;
  mutationPolicy?:CoreBookMutationPolicy;
  enabled?:boolean;
  source?:CoreBookEntrySource;
  metadata?:Record<string,unknown>;
}

export interface CoreBookUpdateInput{
  title?:string;
  content?:string;
  tags?:readonly string[];
  activation?:CoreBookActivation;
  retentionPriority?:number;
  placementWeight?:number;
  mutationPolicy?:CoreBookMutationPolicy;
  enabled?:boolean;
  source?:CoreBookEntrySource;
  metadata?:Record<string,unknown>;
}

export interface CoreBookManagerOptions{
  clock?:Clock;
  idFactory?:()=>CoreBookEntryId;
  events?:EventBus;
  source?:string;
  characterExists?: (characterId:CharacterId)=>Promise<boolean>;
}

const DEFAULT_RETENTION_PRIORITY=50;
const DEFAULT_PLACEMENT_WEIGHT=50;
const DEFAULT_ACTIVATION:CoreBookActivation={kind:"always"};
const DEFAULT_MUTATION_POLICY:CoreBookMutationPolicy="locked";
const DEFAULT_SOURCE:CoreBookEntrySource="user";

let generatedIdSequence=0;

function defaultClock():Clock{return {now:()=>new Date().toISOString()}}
function defaultIdFactory():CoreBookEntryId{
  generatedIdSequence+=1;
  return "core-book."+Date.now().toString(36)+"."+generatedIdSequence.toString(36);
}

function cloneActivation(activation:CoreBookActivation):CoreBookActivation{
  if(activation.kind==="keyword")return {...activation,keywords:[...activation.keywords]};
  return {...activation};
}
function cloneEntry(entry:CoreBookEntry):CoreBookEntry{
  return {
    ...entry,
    tags:[...entry.tags],
    activation:cloneActivation(entry.activation),
    metadata:{...entry.metadata}
  };
}
function cloneState(state:CoreBookStoreState):CoreBookStoreState{
  return {
    apiVersion:state.apiVersion,
    schemaVersion:state.schemaVersion,
    characterId:state.characterId,
    entries:state.entries.map(cloneEntry)
  };
}
function requireCharacterId(characterId:string):string{
  const value=characterId.trim();
  if(!value)throw new Error("Character id must not be empty.");
  return value;
}
function requireEntryId(entryId:string):string{
  const value=entryId.trim();
  if(!value)throw new Error("Core Book entry id must not be empty.");
  return value;
}
function requireTitle(title:string):string{
  const value=title.trim();
  if(!value)throw new Error("Core Book entry title must not be empty.");
  if(value.length>200)throw new Error("Core Book entry title must not exceed 200 characters.");
  return value;
}
function validatePriority(value:number,label:string):number{
  if(!Number.isInteger(value)||value<0||value>100)throw new Error(label+" must be an integer between 0 and 100.");
  return value;
}
function isRecord(value:unknown):value is Record<string,unknown>{
  return !!value&&typeof value==="object"&&!Array.isArray(value);
}
function validateActivation(activation:CoreBookActivation):void{
  if(!isRecord(activation)||typeof activation.kind!=="string")throw new Error("Core Book activation kind is required.");
  switch(activation.kind){
    case "always":
    case "semantic":
    case "model_search":
      if(Object.keys(activation).length!==1)throw new Error("Core Book activation has unexpected fields.");
      return;
    case "keyword":
      if(!Array.isArray(activation.keywords)||activation.keywords.length===0)throw new Error("Keyword activation requires at least one keyword.");
      if(activation.keywords.some(keyword=>typeof keyword!=="string"||keyword.trim().length===0))throw new Error("Keyword activation keywords must be non-empty strings.");
      if(activation.matchMode!=="any"&&activation.matchMode!=="all")throw new Error("Keyword activation matchMode must be any or all.");
      if(typeof activation.caseSensitive!=="boolean")throw new Error("Keyword activation caseSensitive must be boolean.");
      if(Object.keys(activation).length!==4)throw new Error("Keyword activation has unexpected fields.");
      return;
    case "regex":
      if(typeof activation.pattern!=="string"||typeof activation.flags!=="string")throw new Error("Regex activation pattern and flags must be strings.");
      try{new RegExp(activation.pattern,activation.flags);}
      catch{throw new Error("Regex activation contains an invalid pattern or flags.");}
      if(Object.keys(activation).length!==3)throw new Error("Regex activation has unexpected fields.");
      return;
    default:
      throw new Error("Unsupported Core Book activation kind.");
  }
}
function validateEntry(entry:CoreBookEntry,characterId:string):void{
  if(entry.characterId!==characterId)throw new Error("Core Book entry character scope mismatch.");
  requireEntryId(entry.id);
  requireTitle(entry.title);
  if(typeof entry.content!=="string")throw new Error("Core Book entry content must be a string.");
  if(!Array.isArray(entry.tags)||entry.tags.some(tag=>typeof tag!=="string"))throw new Error("Core Book entry tags must be strings.");
  validateActivation(entry.activation);
  validatePriority(entry.retentionPriority,"retentionPriority");
  validatePriority(entry.placementWeight,"placementWeight");
  if(!["locked","suggest","auto"].includes(entry.mutationPolicy))throw new Error("Invalid Core Book mutationPolicy.");
  if(typeof entry.enabled!=="boolean")throw new Error("Core Book enabled must be boolean.");
  if(!["user","import","system","other"].includes(entry.source))throw new Error("Invalid Core Book source.");
  if(!isRecord(entry.metadata))throw new Error("Core Book metadata must be an object.");
  if(!entry.createdAt.trim()||!entry.updatedAt.trim())throw new Error("Core Book timestamps are required.");
}
function validateState(state:CoreBookStoreState,characterId:string):void{
  if(state.apiVersion!==CORE_BOOK_API_VERSION||state.schemaVersion!==CORE_BOOK_SCHEMA_VERSION)throw new Error("Unsupported Core Book storage version.");
  if(state.characterId!==characterId)throw new Error("Core Book storage character scope mismatch.");
  if(!Array.isArray(state.entries))throw new Error("Core Book entries must be an array.");
  const ids=new Set<string>();
  for(const entry of state.entries){
    validateEntry(entry,characterId);
    if(ids.has(entry.id))throw new Error("Core Book storage contains duplicate entry ids.");
    ids.add(entry.id);
  }
}
function compareEntries(a:CoreBookEntry,b:CoreBookEntry):number{
  return a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id);
}

export class CoreBookManager{
  private readonly clock:Clock;
  private readonly idFactory:()=>CoreBookEntryId;
  private readonly events?:EventBus;
  private readonly source:string;
  private readonly characterExists?: (characterId:CharacterId)=>Promise<boolean>;
  private readonly cache=new Map<CharacterId,CoreBookEntry[]>();

  constructor(private readonly store:CoreBookStore,options:CoreBookManagerOptions={}){
    this.clock=options.clock??defaultClock();
    this.idFactory=options.idFactory??defaultIdFactory;
    this.events=options.events;
    this.source=options.source??"core-book-manager";
    this.characterExists=options.characterExists;
  }

  async listCoreBookEntries(characterId:CharacterId):Promise<readonly CoreBookEntry[]>{
    const entries=await this.loadEntries(characterId);
    return entries.sort(compareEntries).map(cloneEntry);
  }

  async getCoreBookEntry(characterId:CharacterId,entryId:CoreBookEntryId):Promise<CoreBookEntry|undefined>{
    const entries=await this.loadEntries(characterId);
    const entry=entries.find(item=>item.id===requireEntryId(entryId));
    return entry?cloneEntry(entry):undefined;
  }

  async createCoreBookEntry(characterId:CharacterId,input:CoreBookCreateInput):Promise<CoreBookEntry>{
    const scope=await this.ensureCharacter(characterId);
    const entries=await this.loadEntries(scope);
    const id=requireEntryId(this.idFactory());
    if(entries.some(entry=>entry.id===id))throw new Error("Core Book entry id already exists.");
    const now=this.clock.now();
    const entry:CoreBookEntry={
      id,
      characterId:scope,
      title:requireTitle(input.title),
      content:input.content,
      tags:[...(input.tags??[])],
      activation:cloneActivation(input.activation??DEFAULT_ACTIVATION),
      retentionPriority:input.retentionPriority??DEFAULT_RETENTION_PRIORITY,
      placementWeight:input.placementWeight??DEFAULT_PLACEMENT_WEIGHT,
      mutationPolicy:input.mutationPolicy??DEFAULT_MUTATION_POLICY,
      enabled:input.enabled??true,
      source:input.source??DEFAULT_SOURCE,
      metadata:{...(input.metadata??{})},
      createdAt:now,
      updatedAt:now
    };
    validateEntry(entry,scope);
    entries.push(entry);
    await this.persist(scope,entries);
    await this.publish("CoreBookEntryCreated",{characterId:scope,entryId:id});
    return cloneEntry(entry);
  }

  async updateCoreBookEntry(characterId:CharacterId,entryId:CoreBookEntryId,input:CoreBookUpdateInput):Promise<CoreBookEntry>{
    const scope=await this.ensureCharacter(characterId);
    const entries=await this.loadEntries(scope);
    const index=entries.findIndex(entry=>entry.id===requireEntryId(entryId));
    if(index<0)throw new Error("Core Book entry was not found.");
    const current=entries[index]!;
    const next:CoreBookEntry={
      ...current,
      title:input.title===undefined?current.title:requireTitle(input.title),
      content:input.content===undefined?current.content:input.content,
      tags:input.tags===undefined?[...current.tags]:[...input.tags],
      activation:input.activation===undefined?cloneActivation(current.activation):cloneActivation(input.activation),
      retentionPriority:input.retentionPriority===undefined?current.retentionPriority:input.retentionPriority,
      placementWeight:input.placementWeight===undefined?current.placementWeight:input.placementWeight,
      mutationPolicy:input.mutationPolicy===undefined?current.mutationPolicy:input.mutationPolicy,
      enabled:input.enabled===undefined?current.enabled:input.enabled,
      source:input.source===undefined?current.source:input.source,
      metadata:input.metadata===undefined?{...current.metadata}:{...input.metadata},
      updatedAt:this.clock.now()
    };
    validateEntry(next,scope);
    entries[index]=next;
    await this.persist(scope,entries);
    await this.publish("CoreBookEntryUpdated",{characterId:scope,entryId:next.id});
    return cloneEntry(next);
  }

  async deleteCoreBookEntry(characterId:CharacterId,entryId:CoreBookEntryId):Promise<void>{
    const scope=await this.ensureCharacter(characterId);
    const entries=await this.loadEntries(scope);
    const id=requireEntryId(entryId);
    const index=entries.findIndex(entry=>entry.id===id);
    if(index<0)throw new Error("Core Book entry was not found.");
    entries.splice(index,1);
    await this.persist(scope,entries);
    await this.publish("CoreBookEntryDeleted",{characterId:scope,entryId:id});
  }

  async setCoreBookEntryEnabled(characterId:CharacterId,entryId:CoreBookEntryId,enabled:boolean):Promise<CoreBookEntry>{
    const scope=await this.ensureCharacter(characterId);
    const entries=await this.loadEntries(scope);
    const id=requireEntryId(entryId);
    const index=entries.findIndex(entry=>entry.id===id);
    if(index<0)throw new Error("Core Book entry was not found.");
    const current=entries[index]!;
    if(current.enabled===enabled)return cloneEntry(current);
    const next={...current,enabled,updatedAt:this.clock.now()};
    validateEntry(next,scope);
    entries[index]=next;
    await this.persist(scope,entries);
    await this.publish("CoreBookEntryEnabledChanged",{characterId:scope,entryId:id,enabled});
    return cloneEntry(next);
  }

  private async ensureCharacter(characterId:CharacterId):Promise<string>{
    const scope=requireCharacterId(characterId);
    if(this.characterExists&&!(await this.characterExists(scope)))throw new Error("Character was not found.");
    return scope;
  }

  private async loadEntries(characterId:CharacterId):Promise<CoreBookEntry[]>{
    const scope=await this.ensureCharacter(characterId);
    const cached=this.cache.get(scope);
    if(cached)return cached;
    const stored=await this.store.load(scope);
    if(!stored){
      const empty:CoreBookEntry[]=[];
      this.cache.set(scope,empty);
      return empty;
    }
    validateState(stored,scope);
    const entries=stored.entries.map(cloneEntry);
    this.cache.set(scope,entries);
    return entries;
  }

  private async persist(characterId:string,entries:CoreBookEntry[]):Promise<void>{
    validateState({apiVersion:CORE_BOOK_API_VERSION,schemaVersion:CORE_BOOK_SCHEMA_VERSION,characterId,entries},characterId);
    this.cache.set(characterId,entries);
    await this.store.save({apiVersion:CORE_BOOK_API_VERSION,schemaVersion:CORE_BOOK_SCHEMA_VERSION,characterId,entries:entries.map(cloneEntry)});
  }

  private async publish(type:"CoreBookEntryCreated",payload:{characterId:string;entryId:string}):Promise<void>;
  private async publish(type:"CoreBookEntryUpdated",payload:{characterId:string;entryId:string}):Promise<void>;
  private async publish(type:"CoreBookEntryDeleted",payload:{characterId:string;entryId:string}):Promise<void>;
  private async publish(type:"CoreBookEntryEnabledChanged",payload:{characterId:string;entryId:string;enabled:boolean}):Promise<void>;
  private async publish(
    type:"CoreBookEntryCreated"|"CoreBookEntryUpdated"|"CoreBookEntryDeleted"|"CoreBookEntryEnabledChanged",
    payload:{characterId:string;entryId:string;enabled?:boolean}
  ):Promise<void>{
    if(!this.events)return;
    switch(type){
      case "CoreBookEntryCreated":await this.events.publish(createEvent(type,payload,this.source,()=>this.clock.now()));break;
      case "CoreBookEntryUpdated":await this.events.publish(createEvent(type,payload,this.source,()=>this.clock.now()));break;
      case "CoreBookEntryDeleted":await this.events.publish(createEvent(type,payload,this.source,()=>this.clock.now()));break;
      case "CoreBookEntryEnabledChanged":await this.events.publish(createEvent(type,{characterId:payload.characterId,entryId:payload.entryId,enabled:Boolean(payload.enabled)},this.source,()=>this.clock.now()));break;
    }
  }
}
