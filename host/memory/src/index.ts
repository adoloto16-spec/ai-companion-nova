import type {CharacterId,ConversationId,MemoryItem,MemoryStore,MemoryStoreState,MemoryType,MemoryStatus,MemorySource,MemoryMutationPolicy} from "../../../contracts/src/index";
import {MEMORY_API_VERSION,MEMORY_SCHEMA_VERSION,defaultConversationId} from "../../../contracts/src/index";

export type MemoryStoreInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;

export const MEMORY_COMMANDS={
  get:"get_memory_state",
  save:"save_memory_state",
  supersede:"supersede_memory"
} as const;

export interface LegacyMemoryItemV1{
  id:string;
  characterId:CharacterId;
  type:MemoryType;
  content:string;
  tags:readonly string[];
  importance:number;
  confidence:number;
  createdAt:string;
  updatedAt:string;
  validFrom:string|null;
  validUntil:string|null;
  source:MemorySource;
  sourceReference:string|null;
  mutationPolicy:MemoryMutationPolicy;
  status:MemoryStatus;
  metadata:Record<string,unknown>;
}
export interface LegacyMemoryStoreStateV1{
  apiVersion:"1";
  schemaVersion:"1";
  characterId:CharacterId;
  items:readonly LegacyMemoryItemV1[];
}

function cloneItem(item:MemoryItem):MemoryItem{
  return {...item,tags:[...item.tags],metadata:{...item.metadata}};
}
function cloneState(state:MemoryStoreState):MemoryStoreState{
  return {apiVersion:state.apiVersion,schemaVersion:state.schemaVersion,characterId:state.characterId,items:state.items.map(cloneItem)};
}
function migrateLegacyState(state:LegacyMemoryStoreStateV1,conversationId:ConversationId):MemoryStoreState{
  const target=conversationId.trim()||defaultConversationId(state.characterId);
  return {
    apiVersion:MEMORY_API_VERSION,
    schemaVersion:MEMORY_SCHEMA_VERSION,
    characterId:state.characterId,
    items:state.items.map(item=>({...item,conversationId:target}))
  };
}

export class InMemoryMemoryStore implements MemoryStore{
  private readonly states=new Map<CharacterId,MemoryStoreState|LegacyMemoryStoreStateV1>();

  async load(characterId:CharacterId,migrationConversationId?:ConversationId):Promise<MemoryStoreState|undefined>{
    const state=this.states.get(characterId);
    if(!state)return undefined;
    if(state.schemaVersion==="1"){
      const migrated=migrateLegacyState(state,migrationConversationId??defaultConversationId(characterId));
      this.states.set(characterId,migrated);
      return cloneState(migrated);
    }
    return cloneState(state);
  }

  async save(state:MemoryStoreState):Promise<void>{
    if(state.apiVersion!==MEMORY_API_VERSION||state.schemaVersion!==MEMORY_SCHEMA_VERSION)throw new Error("Unsupported memory storage version.");
    if(state.characterId.trim().length===0)throw new Error("Memory storage character scope mismatch.");
    if(state.items.some(item=>item.characterId!==state.characterId))throw new Error("Memory storage character scope mismatch.");
    this.states.set(state.characterId,cloneState(state));
  }

  async supersede(characterId:CharacterId,conversationId:ConversationId,previousMemoryId:string,replacement:MemoryItem):Promise<MemoryItem>{
    const current=await this.load(characterId,conversationId);
    const state=current??{apiVersion:MEMORY_API_VERSION,schemaVersion:MEMORY_SCHEMA_VERSION,characterId,items:[]};
    if(replacement.characterId!==characterId||replacement.conversationId!==conversationId)throw new Error("Memory storage scope mismatch.");
    const index=state.items.findIndex(item=>item.id===previousMemoryId&&item.conversationId===conversationId);
    if(index<0)throw new Error("Memory item was not found.");
    if(state.items[index]!.status!=="active")throw new Error("Only active memory items can be superseded.");
    if(state.items.some(item=>item.id===replacement.id))throw new Error("Memory id already exists.");
    state.items[index]={...state.items[index]!,status:"superseded",updatedAt:replacement.updatedAt,metadata:{...state.items[index]!.metadata}};
    state.items.push(cloneItem(replacement));
    await this.save(state);
    return cloneItem(replacement);
  }

  seedLegacyState(state:LegacyMemoryStoreStateV1):void{
    this.states.set(state.characterId,{...state,items:state.items.map(item=>({...item,tags:[...item.tags],metadata:{...item.metadata}}))});
  }
}

export class IpcMemoryStore implements MemoryStore{
  constructor(private readonly invoke:MemoryStoreInvoke){}
  async load(characterId:CharacterId,migrationConversationId?:ConversationId):Promise<MemoryStoreState|undefined>{
    const args={characterId,...(migrationConversationId?{migrationConversationId}:{})};
    const value=await this.invoke(MEMORY_COMMANDS.get,args);
    return value===null||value===undefined?undefined:value as MemoryStoreState;
  }
  async save(state:MemoryStoreState):Promise<void>{
    await this.invoke(MEMORY_COMMANDS.save,{state:cloneState(state)});
  }
  async supersede(characterId:CharacterId,conversationId:ConversationId,previousMemoryId:string,replacement:MemoryItem):Promise<MemoryItem>{
    const value=await this.invoke(MEMORY_COMMANDS.supersede,{characterId,conversationId,previousMemoryId,replacement:cloneItem(replacement)});
    return value as MemoryItem;
  }
}
