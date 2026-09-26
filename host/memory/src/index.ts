import type {CharacterId,MemoryItem,MemoryStore,MemoryStoreState} from "../../../contracts/src/index";

export type MemoryStoreInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;

export const MEMORY_COMMANDS={
  get:"get_memory_state",
  save:"save_memory_state",
  supersede:"supersede_memory"
} as const;

function cloneItem(item:MemoryItem):MemoryItem{return {...item,tags:[...item.tags],metadata:{...item.metadata}}}
function cloneState(state:MemoryStoreState):MemoryStoreState{
  return {apiVersion:state.apiVersion,schemaVersion:state.schemaVersion,characterId:state.characterId,items:state.items.map(cloneItem)};
}

export class InMemoryMemoryStore implements MemoryStore{
  private readonly states=new Map<CharacterId,MemoryStoreState>();
  async load(characterId:CharacterId):Promise<MemoryStoreState|undefined>{
    const state=this.states.get(characterId);
    return state?cloneState(state):undefined;
  }
  async save(state:MemoryStoreState):Promise<void>{
    const current=this.states.get(state.characterId);
    if(current&&current.characterId!==state.characterId)throw new Error("Memory storage character scope mismatch.");
    this.states.set(state.characterId,cloneState(state));
  }
  async supersede(characterId:CharacterId,previousMemoryId:string,replacement:MemoryItem):Promise<MemoryItem>{
    const current=this.states.get(characterId);
    const state={apiVersion:current?.apiVersion??"1",schemaVersion:current?.schemaVersion??"1",characterId,items:current?current.items.map(cloneItem):[]};
    if(state.characterId!==characterId||replacement.characterId!==characterId)throw new Error("Memory storage character scope mismatch.");
    const index=state.items.findIndex(item=>item.id===previousMemoryId);
    if(index<0)throw new Error("Memory item was not found.");
    if(state.items[index]!.status!=="active")throw new Error("Only active memory items can be superseded.");
    if(state.items.some(item=>item.id===replacement.id))throw new Error("Memory id already exists.");
    const now=replacement.updatedAt;
    state.items[index]={...state.items[index]!,status:"superseded",updatedAt:now,metadata:{...state.items[index]!.metadata}};
    state.items.push(cloneItem(replacement));
    this.states.set(characterId,cloneState(state));
    return cloneItem(replacement);
  }
}

export class IpcMemoryStore implements MemoryStore{
  constructor(private readonly invoke:MemoryStoreInvoke){}
  async load(characterId:CharacterId):Promise<MemoryStoreState|undefined>{
    const value=await this.invoke(MEMORY_COMMANDS.get,{characterId});
    return value===null||value===undefined?undefined:value as MemoryStoreState;
  }
  async save(state:MemoryStoreState):Promise<void>{
    await this.invoke(MEMORY_COMMANDS.save,{state:cloneState(state)});
  }
  async supersede(characterId:CharacterId,previousMemoryId:string,replacement:MemoryItem):Promise<MemoryItem>{
    const value=await this.invoke(MEMORY_COMMANDS.supersede,{characterId,previousMemoryId,replacement:cloneItem(replacement)});
    return value as MemoryItem;
  }
}
