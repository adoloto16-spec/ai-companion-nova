import type {
  AuditService,CharacterId,Clock,EventBus,MemoryBroker,MemoryCreateInput,MemoryItem,MemoryItemId,MemoryMutationAuthority,
  MemoryMutationPolicy,MemorySearchQuery,MemoryStore,MemoryStoreState,MemoryStatus,MemoryType,SchemaValidator
} from "../../contracts/src/index";
import {MEMORY_API_VERSION,MEMORY_SCHEMA_VERSION,STANDARD_SCHEMAS,createEvent} from "../../contracts/src/index";

const MAX_CONTENT_LENGTH=32768;
const MAX_TAGS=32;
const MAX_TAG_LENGTH=64;
const MAX_SOURCE_REFERENCE_LENGTH=500;
const MAX_METADATA_KEYS=64;
const MAX_METADATA_BYTES=16384;
const MAX_QUERY_LENGTH=256;
const MAX_LIMIT=100;

export interface MemoryUpdateInput{
  content?:string;
  tags?:readonly string[];
  importance?:number;
  confidence?:number;
  validFrom?:string|null;
  validUntil?:string|null;
  source?:MemoryItem["source"];
  sourceReference?:string|null;
  mutationPolicy?:MemoryMutationPolicy;
  metadata?:Record<string,unknown>;
}

export type MemorySupersedeInput=MemoryCreateInput;

export interface MemoryBrokerDependencies{
  store:MemoryStore;
  validator:SchemaValidator;
  audit:AuditService;
  events?:EventBus;
  clock?:Clock;
  source?:string;
  characterExists?:(characterId:CharacterId)=>Promise<boolean>;
}

function defaultClock():Clock{return {now:()=>new Date().toISOString()}}
function defaultIdFactory(prefix:string):()=>string{
  let sequence=0;
  return ()=>{sequence+=1;return prefix+"."+Date.now().toString(36)+"."+sequence.toString(36);}
}
const idFactory=defaultIdFactory("memory");

function isRecord(value:unknown):value is Record<string,unknown>{
  return !!value&&typeof value==="object"&&!Array.isArray(value);
}
function cloneMetadata(metadata:Record<string,unknown>):Record<string,unknown>{return {...metadata}}
function cloneItem(item:MemoryItem):MemoryItem{
  return {...item,tags:[...item.tags],metadata:cloneMetadata(item.metadata)};
}
function cloneState(state:MemoryStoreState):MemoryStoreState{
  return {apiVersion:state.apiVersion,schemaVersion:state.schemaVersion,characterId:state.characterId,items:state.items.map(cloneItem)};
}
function requireCharacterId(value:string):string{
  const result=value.trim();
  if(!result)throw new Error("Character id must not be empty.");
  if(result.length>200)throw new Error("Character id must not exceed 200 characters.");
  return result;
}
function requireMemoryId(value:string):string{
  const result=value.trim();
  if(!result)throw new Error("Memory id must not be empty.");
  if(result.length>200)throw new Error("Memory id must not exceed 200 characters.");
  return result;
}
function requireContent(value:string):string{
  if(typeof value!=="string"||value.trim().length===0)throw new Error("Memory content must be a non-empty string.");
  if(value.length>MAX_CONTENT_LENGTH)throw new Error("Memory content exceeds the v1 input limit.");
  return value;
}
function requireTags(tags:readonly string[]):string[]{
  if(!Array.isArray(tags)||tags.length>MAX_TAGS)throw new Error("Memory tags exceed the v1 input limit.");
  return tags.map(tag=>{
    if(typeof tag!=="string"||tag.trim().length===0)throw new Error("Memory tags must be non-empty strings.");
    if(tag.length>MAX_TAG_LENGTH)throw new Error("Memory tag exceeds the v1 input limit.");
    return tag;
  });
}
function requireScore(value:number,label:string):number{
  if(!Number.isInteger(value)||value<0||value>100)throw new Error(label+" must be an integer between 0 and 100.");
  return value;
}
function requireMetadata(metadata:Record<string,unknown>):Record<string,unknown>{
  if(!isRecord(metadata))throw new Error("Memory metadata must be an object.");
  if(Object.keys(metadata).length>MAX_METADATA_KEYS)throw new Error("Memory metadata exceeds the v1 key limit.");
  const bytes=Buffer.byteLength(JSON.stringify(metadata));
  if(bytes>MAX_METADATA_BYTES)throw new Error("Memory metadata exceeds the v1 size limit.");
  return cloneMetadata(metadata);
}
function requireTimestamp(value:string,label:string):string{
  if(typeof value!=="string"||value.trim().length===0)throw new Error(label+" is required.");
  const trimmed=value.trim();
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed))throw new Error(label+" must be an ISO-8601 timestamp.");
  if(!Number.isFinite(Date.parse(trimmed)))throw new Error(label+" must be a valid timestamp.");
  return trimmed;
}
function validateTemporalRange(validFrom:string|null,validUntil:string|null):void{
  if(validFrom!==null)requireTimestamp(validFrom,"validFrom");
  if(validUntil!==null)requireTimestamp(validUntil,"validUntil");
  if(validFrom!==null&&validUntil!==null&&Date.parse(validUntil)<Date.parse(validFrom))throw new Error("validUntil must not be earlier than validFrom.");
}
function validateProvenance(source:MemoryItem["source"],sourceReference:string|null):void{
  if(["conversation","file","tool","model"].includes(source)&&(!sourceReference||sourceReference.trim().length===0))throw new Error("Memory sourceReference is required for "+source+" provenance.");
  if(sourceReference!==null&&sourceReference.length>MAX_SOURCE_REFERENCE_LENGTH)throw new Error("Memory sourceReference exceeds the v1 input limit.");
}
function validateItemShape(item:MemoryItem,characterId:string,validator:SchemaValidator):void{
  if(item.characterId!==characterId)throw new Error("Memory item character scope mismatch.");
  validator.validate(item,STANDARD_SCHEMAS["memory-item"]!).errors.length&&validator.validate(item,STANDARD_SCHEMAS["memory-item"]!);
  const result=validator.validate(item,STANDARD_SCHEMAS["memory-item"]!);
  if(!result.valid)throw new Error("Memory item failed schema validation: "+result.errors.join("; "));
  requireMemoryId(item.id);
  requireContent(item.content);
  requireTags(item.tags);
  requireScore(item.importance,"importance");
  requireScore(item.confidence,"confidence");
  requireTimestamp(item.createdAt,"createdAt");
  requireTimestamp(item.updatedAt,"updatedAt");
  validateTemporalRange(item.validFrom,item.validUntil);
  validateProvenance(item.source,item.sourceReference);
  if(!["locked","suggest","auto"].includes(item.mutationPolicy))throw new Error("Invalid memory mutationPolicy.");
  if(!["active","superseded","archived"].includes(item.status))throw new Error("Invalid memory status.");
  requireMetadata(item.metadata);
}
function validateState(state:MemoryStoreState,characterId:string,validator:SchemaValidator):void{
  if(state.apiVersion!==MEMORY_API_VERSION||state.schemaVersion!==MEMORY_SCHEMA_VERSION)throw new Error("Unsupported memory storage version.");
  if(state.characterId!==characterId)throw new Error("Memory storage character scope mismatch.");
  const ids=new Set<string>();
  for(const item of state.items){
    validateItemShape(item,characterId,validator);
    if(ids.has(item.id))throw new Error("Memory storage contains duplicate item ids.");
    ids.add(item.id);
  }
}
function actorAllowed(item:MemoryItem,authority:MemoryMutationAuthority):void{
  if(authority.actorId.trim().length===0)throw new Error("Memory mutation actorId is required.");
  if(authority.actorType==="user")return;
  if(!authority.trusted)throw new Error("Memory mutation authority is not trusted.");
  if(item.mutationPolicy==="locked")throw new Error("Memory mutation denied by locked mutationPolicy.");
  if(item.mutationPolicy==="suggest"&&!authority.capabilities.includes("memory.write.suggest.apply"))throw new Error("Memory mutation denied by suggest mutationPolicy.");
  if(item.mutationPolicy==="auto"&&!authority.capabilities.includes("memory.write.auto"))throw new Error("Memory mutation denied by auto mutationPolicy.");
}
function creationAllowed(item:MemoryItem,authority:MemoryMutationAuthority):void{
  if(authority.actorId.trim().length===0)throw new Error("Memory mutation actorId is required.");
  if(authority.actorType==="user")return;
  if(!authority.trusted||!authority.capabilities.includes("memory.create"))throw new Error("Memory creation denied by memory authority.");
  if(item.mutationPolicy==="auto"&&!authority.capabilities.includes("memory.write.auto"))throw new Error("Automatic memory creation requires memory.write.auto authority.");
}
function compareItems(a:MemoryItem,b:MemoryItem):number{
  return b.updatedAt.localeCompare(a.updatedAt)||b.importance-a.importance||b.confidence-a.confidence||a.id.localeCompare(b.id);
}
function containsQuery(item:MemoryItem,query:string):boolean{
  if(!query)return true;
  const needle=query.toLocaleLowerCase();
  return item.content.toLocaleLowerCase().includes(needle)
    ||item.tags.some(tag=>tag.toLocaleLowerCase().includes(needle));
}

export class MemoryBrokerImpl implements MemoryBroker{
  private readonly clock:Clock;
  private readonly source:string;
  private readonly characterExists?: (characterId:CharacterId)=>Promise<boolean>;

  constructor(private readonly deps:MemoryBrokerDependencies){
    this.clock=deps.clock??defaultClock();
    this.source=deps.source??"memory-broker";
    this.characterExists=deps.characterExists;
  }

  async get(characterId:CharacterId,memoryId:MemoryItemId):Promise<MemoryItem|undefined>{
    const scope=await this.ensureCharacter(characterId);
    const state=await this.loadState(scope);
    const item=state.items.find(candidate=>candidate.id===requireMemoryId(memoryId));
    return item?cloneItem(item):undefined;
  }

  async search(query:MemorySearchQuery):Promise<readonly MemoryItem[]>{
    const scope=await this.ensureCharacter(query.characterId);
    const queryResult=this.deps.validator.validate(query,STANDARD_SCHEMAS["memory-search-query"]!);
    if(!queryResult.valid)throw new Error("Memory search query failed schema validation: "+queryResult.errors.join("; "));
    if(query.query.length>MAX_QUERY_LENGTH)throw new Error("Memory search query exceeds the v1 input limit.");
    const limit=Math.min(query.limit??50,MAX_LIMIT);
    const states=await this.loadState(scope);
    const types=new Set<MemoryType>(query.types??[]);
    const requiredTags=(query.tags??[]).map(tag=>tag.toLocaleLowerCase());
    const status=query.status??"active";
    const results=states.items
      .filter(item=>item.status===status)
      .filter(item=>types.size===0||types.has(item.type))
      .filter(item=>requiredTags.every(tag=>item.tags.some(itemTag=>itemTag.toLocaleLowerCase()===tag)))
      .filter(item=>containsQuery(item,query.query.trim()))
      .sort(compareItems)
      .slice(0,limit)
      .map(cloneItem);
    return results;
  }

  async create(characterId:CharacterId,input:MemoryCreateInput,authority:MemoryMutationAuthority):Promise<MemoryItem>{
    const scope=await this.ensureCharacter(characterId);
    const now=this.clock.now();
    const item:MemoryItem={
      id:requireMemoryId(input.id??idFactory()),
      characterId:scope,
      type:input.type,
      content:requireContent(input.content),
      tags:requireTags(input.tags??[]),
      importance:requireScore(input.importance??50,"importance"),
      confidence:requireScore(input.confidence??50,"confidence"),
      createdAt:now,
      updatedAt:now,
      validFrom:input.validFrom===undefined?null:input.validFrom,
      validUntil:input.validUntil===undefined?null:input.validUntil,
      source:input.source,
      sourceReference:input.sourceReference===undefined?null:input.sourceReference,
      mutationPolicy:input.mutationPolicy??"locked",
      status:"active",
      metadata:requireMetadata(input.metadata??{})
    };
    validateItemShape(item,scope,this.deps.validator);
    creationAllowed(item,authority);
    const state=await this.loadState(scope);
    if(state.items.some(candidate=>candidate.id===item.id))throw new Error("Memory id already exists.");
    state.items.push(item);
    await this.persist(scope,state);
    await this.audit("create",scope,item.id,authority,"success");
    await this.publish("MemoryCreated",{characterId:scope,memoryId:item.id,status:item.status,updatedAt:item.updatedAt});
    return cloneItem(item);
  }

  async update(characterId:CharacterId,memoryId:MemoryItemId,input:MemoryUpdateInput,authority:MemoryMutationAuthority):Promise<MemoryItem>{
    const scope=await this.ensureCharacter(characterId);
    const state=await this.loadState(scope);
    const id=requireMemoryId(memoryId);
    const index=state.items.findIndex(candidate=>candidate.id===id);
    if(index<0)throw new Error("Memory item was not found.");
    const current=state.items[index]!;
    if(current.status!=="active")throw new Error("Only active memory items can be updated.");
    actorAllowed(current,authority);
    const next:MemoryItem={
      ...current,
      content:input.content===undefined?current.content:requireContent(input.content),
      tags:input.tags===undefined?[...current.tags]:requireTags(input.tags),
      importance:input.importance===undefined?current.importance:requireScore(input.importance,"importance"),
      confidence:input.confidence===undefined?current.confidence:requireScore(input.confidence,"confidence"),
      validFrom:input.validFrom===undefined?current.validFrom:input.validFrom,
      validUntil:input.validUntil===undefined?current.validUntil:input.validUntil,
      source:input.source===undefined?current.source:input.source,
      sourceReference:input.sourceReference===undefined?current.sourceReference:input.sourceReference,
      mutationPolicy:input.mutationPolicy===undefined?current.mutationPolicy:input.mutationPolicy,
      metadata:input.metadata===undefined?cloneMetadata(current.metadata):requireMetadata(input.metadata),
      updatedAt:this.clock.now()
    };
    validateItemShape(next,scope,this.deps.validator);
    state.items[index]=next;
    await this.persist(scope,state);
    await this.audit("update",scope,id,authority,"success");
    await this.publish("MemoryUpdated",{characterId:scope,memoryId:id,status:next.status,updatedAt:next.updatedAt});
    return cloneItem(next);
  }

  async supersede(characterId:CharacterId,memoryId:MemoryItemId,input:MemorySupersedeInput,authority:MemoryMutationAuthority):Promise<MemoryItem>{
    const scope=await this.ensureCharacter(characterId);
    const state=await this.loadState(scope);
    const previousId=requireMemoryId(memoryId);
    const previous=state.items.find(item=>item.id===previousId);
    if(!previous)throw new Error("Memory item was not found.");
    if(previous.status!=="active")throw new Error("Only active memory items can be superseded.");
    actorAllowed(previous,authority);
    const now=this.clock.now();
    const replacement:MemoryItem={
      id:requireMemoryId(input.id??idFactory()),
      characterId:scope,
      type:input.type,
      content:requireContent(input.content),
      tags:requireTags(input.tags??[]),
      importance:requireScore(input.importance??previous.importance,"importance"),
      confidence:requireScore(input.confidence??previous.confidence,"confidence"),
      createdAt:now,
      updatedAt:now,
      validFrom:input.validFrom===undefined?previous.validFrom:input.validFrom,
      validUntil:input.validUntil===undefined?previous.validUntil:input.validUntil,
      source:input.source,
      sourceReference:input.sourceReference===undefined?null:input.sourceReference,
      mutationPolicy:input.mutationPolicy??previous.mutationPolicy,
      status:"active",
      metadata:requireMetadata(input.metadata??previous.metadata)
    };
    validateItemShape(replacement,scope,this.deps.validator);
    if(replacement.id===previous.id)throw new Error("Superseding memory must use a new memory id.");
    creationAllowed(replacement,authority);
    const updatedPrevious={...previous,status:"superseded" as const,updatedAt:now};
    validateItemShape(updatedPrevious,scope,this.deps.validator);
    await this.deps.store.supersede(scope,previous.id,replacement);
    await this.audit("supersede",scope,replacement.id,authority,"success");
    await this.publish("MemorySuperseded",{characterId:scope,memoryId:replacement.id,previousMemoryId:previous.id,status:replacement.status,updatedAt:replacement.updatedAt});
    return cloneItem(replacement);
  }

  async archive(characterId:CharacterId,memoryId:MemoryItemId,authority:MemoryMutationAuthority):Promise<MemoryItem>{
    const scope=await this.ensureCharacter(characterId);
    const state=await this.loadState(scope);
    const id=requireMemoryId(memoryId);
    const index=state.items.findIndex(candidate=>candidate.id===id);
    if(index<0)throw new Error("Memory item was not found.");
    const current=state.items[index]!;
    if(current.status!=="active")throw new Error("Only active memory items can be archived.");
    actorAllowed(current,authority);
    const archived:MemoryItem={...current,status:"archived",updatedAt:this.clock.now(),metadata:cloneMetadata(current.metadata)};
    validateItemShape(archived,scope,this.deps.validator);
    state.items[index]=archived;
    await this.persist(scope,state);
    await this.audit("archive",scope,id,authority,"success");
    await this.publish("MemoryArchived",{characterId:scope,memoryId:id,status:archived.status,updatedAt:archived.updatedAt});
    return cloneItem(archived);
  }

  private async ensureCharacter(characterId:CharacterId):Promise<string>{
    const scope=requireCharacterId(characterId);
    if(this.characterExists&&!(await this.characterExists(scope)))throw new Error("Character was not found.");
    return scope;
  }

  private async loadState(characterId:string):Promise<MemoryStoreState>{
    const stored=await this.deps.store.load(characterId);
    if(!stored){
      const empty={apiVersion:MEMORY_API_VERSION,schemaVersion:MEMORY_SCHEMA_VERSION,characterId,items:[]};
      validateState(empty,characterId,this.deps.validator);
      return empty;
    }
    validateState(stored,characterId,this.deps.validator);
    return cloneState(stored);
  }
  private async persist(characterId:string,state:MemoryStoreState):Promise<void>{
    validateState(state,characterId,this.deps.validator);
    await this.deps.store.save(cloneState(state));
  }
  private async audit(operation:string,characterId:string,memoryId:string,authority:MemoryMutationAuthority,status:"success"|"denied"|"error",reason?:string):Promise<void>{
    await this.deps.audit.record({
      timestamp:this.clock.now(),
      actorId:authority.actorId,
      actorType:authority.actorType,
      module:authority.moduleId,
      action:"memory."+operation,
      resourceType:"resource",
      targetSummary:"character:"+characterId+"/memory:"+memoryId,
      argumentKeys:[],
      status,
      durationMs:0,
      allowed:status==="success",
      reason
    });
  }
  private async publish<K extends "MemoryCreated"|"MemoryUpdated"|"MemorySuperseded"|"MemoryArchived">(type:K,payload:EventPayloadFor<K>):Promise<void>{
    if(!this.deps.events)return;
    await this.deps.events.publish(createEvent(type,payload,this.source,()=>this.clock.now()));
  }
}

type EventPayloadFor<K extends "MemoryCreated"|"MemoryUpdated"|"MemorySuperseded"|"MemoryArchived">=
  K extends "MemorySuperseded"
    ? {characterId:string;memoryId:string;previousMemoryId:string;status:MemoryStatus;updatedAt:string}
    : {characterId:string;memoryId:string;status:MemoryStatus;updatedAt:string};
