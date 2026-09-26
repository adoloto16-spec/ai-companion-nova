import type {CoreBookEntry,CoreBookStore,CoreBookStoreState,CharacterId} from "../../../contracts/src/index";

export type CoreBookStoreInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;

export const CORE_BOOK_COMMANDS={get:"get_core_book_entries",save:"save_core_book_entries"} as const;

function cloneEntry(entry:CoreBookEntry):CoreBookEntry{
  return {
    ...entry,
    tags:[...entry.tags],
    activation:entry.activation.kind==="keyword"?{...entry.activation,keywords:[...entry.activation.keywords]}:{...entry.activation},
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

export class InMemoryCoreBookStore implements CoreBookStore{
  private readonly states=new Map<CharacterId,CoreBookStoreState>();
  async load(characterId:CharacterId):Promise<CoreBookStoreState|undefined>{
    const state=this.states.get(characterId);
    return state?cloneState(state):undefined;
  }
  async save(state:CoreBookStoreState):Promise<void>{
    this.states.set(state.characterId,cloneState(state));
  }
}

export class IpcCoreBookStore implements CoreBookStore{
  constructor(private readonly invoke:CoreBookStoreInvoke){}
  async load(characterId:CharacterId):Promise<CoreBookStoreState|undefined>{
    const value=await this.invoke(CORE_BOOK_COMMANDS.get,{characterId});
    return value===null||value===undefined?undefined:value as CoreBookStoreState;
  }
  async save(state:CoreBookStoreState):Promise<void>{
    await this.invoke(CORE_BOOK_COMMANDS.save,{state:cloneState(state)});
  }
}
