import type {CharacterStore,CharacterStoreState} from "../../../contracts/src/index";

export type CharacterStoreInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;

export const CHARACTER_COMMANDS={get:"get_characters",save:"save_characters"} as const;

function cloneState(state:CharacterStoreState):CharacterStoreState{
  return {
    apiVersion:state.apiVersion,
    schemaVersion:state.schemaVersion,
    characters:state.characters.map(character=>({...character})),
    activeCharacterId:state.activeCharacterId
  };
}

export class InMemoryCharacterStore implements CharacterStore{
  private state?:CharacterStoreState;
  async load():Promise<CharacterStoreState|undefined>{return this.state?cloneState(this.state):undefined}
  async save(state:CharacterStoreState):Promise<void>{this.state=cloneState(state)}
}

export class IpcCharacterStore implements CharacterStore{
  constructor(private readonly invoke:CharacterStoreInvoke){}
  async load():Promise<CharacterStoreState|undefined>{
    const value=await this.invoke(CHARACTER_COMMANDS.get);
    return value===null||value===undefined?undefined:value as CharacterStoreState;
  }
  async save(state:CharacterStoreState):Promise<void>{
    await this.invoke(CHARACTER_COMMANDS.save,{state:cloneState(state)});
  }
}
