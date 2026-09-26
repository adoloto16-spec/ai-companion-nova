import type {Character,CharacterId,CharacterStore,CharacterStoreState,Clock,EventBus} from "../../contracts/src/index";
import {CHARACTER_API_VERSION,CHARACTER_SCHEMA_VERSION,createEvent} from "../../contracts/src/index";

export const DEFAULT_CHARACTER_ID:CharacterId="character.nova.default.v1";
export const DEFAULT_CHARACTER_NAME="Nova";

export interface CharacterCreateInput{name:string;description?:string;enabled?:boolean}
export interface CharacterUpdateInput{name?:string;description?:string;enabled?:boolean}
export interface CharacterManagerOptions{clock?:Clock;idFactory?:()=>CharacterId;events?:EventBus;source?:string}

let generatedIdSequence=0;
function defaultClock():Clock{return {now:()=>new Date().toISOString()}}
function defaultIdFactory():CharacterId{
  generatedIdSequence+=1;
  return "character."+Date.now().toString(36)+"."+generatedIdSequence.toString(36);
}
function cloneCharacter(character:Character):Character{return {...character}}
function cloneState(state:CharacterStoreState):CharacterStoreState{
  return {apiVersion:state.apiVersion,schemaVersion:state.schemaVersion,characters:state.characters.map(cloneCharacter),activeCharacterId:state.activeCharacterId};
}
function requireName(name:string):string{
  const value=name.trim();
  if(!value)throw new Error("Character name must not be empty.");
  if(value.length>120)throw new Error("Character name must not exceed 120 characters.");
  return value;
}
function requireCharacterId(id:string):string{
  const value=id.trim();
  if(!value)throw new Error("Character id must not be empty.");
  return value;
}
function validateCharacter(character:Character):void{
  requireCharacterId(character.id);
  requireName(character.name);
  if(typeof character.description!=="string")throw new Error("Character description must be a string.");
  if(character.description.length>4096)throw new Error("Character description must not exceed 4096 characters.");
  if(!character.createdAt||!character.updatedAt)throw new Error("Character timestamps are required.");
  if(typeof character.enabled!=="boolean")throw new Error("Character enabled must be boolean.");
}
function validateState(state:CharacterStoreState):void{
  if(state.apiVersion!==CHARACTER_API_VERSION||state.schemaVersion!==CHARACTER_SCHEMA_VERSION)throw new Error("Unsupported character storage version.");
  if(!Array.isArray(state.characters))throw new Error("Character storage characters must be an array.");
  const ids=new Set<string>();
  for(const character of state.characters){
    validateCharacter(character);
    if(ids.has(character.id))throw new Error("Character storage contains duplicate character ids.");
    ids.add(character.id);
  }
  if(state.characters.length===0)throw new Error("Character storage must contain at least one character.");
  if(!ids.has(state.activeCharacterId))throw new Error("Character storage activeCharacterId does not exist.");
}
function defaultCharacter(now:string):Character{
  return {id:DEFAULT_CHARACTER_ID,name:DEFAULT_CHARACTER_NAME,description:"",createdAt:now,updatedAt:now,enabled:true};
}
function compareCharacters(a:Character,b:Character):number{return a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)}

export class InMemoryCharacterStore implements CharacterStore{
  private state?:CharacterStoreState;
  async load():Promise<CharacterStoreState|undefined>{return this.state?cloneState(this.state):undefined}
  async save(state:CharacterStoreState):Promise<void>{this.state=cloneState(state)}
}

export class CharacterManager{
  private readonly characters=new Map<CharacterId,Character>();
  private readonly clock:Clock;
  private readonly idFactory:()=>CharacterId;
  private readonly events?:EventBus;
  private readonly source:string;
  private activeCharacterId?:CharacterId;
  private initialized=false;

  constructor(private readonly store:CharacterStore,options:CharacterManagerOptions={}){
    this.clock=options.clock??defaultClock();
    this.idFactory=options.idFactory??defaultIdFactory;
    this.events=options.events;
    this.source=options.source??"character-manager";
  }

  async initialize():Promise<void>{
    if(this.initialized)return;
    const stored=await this.store.load();
    if(!stored){
      const character=defaultCharacter(this.clock.now());
      this.characters.set(character.id,character);
      this.activeCharacterId=character.id;
      await this.persist();
      await this.publish("CharacterCreated",{characterId:character.id});
      this.initialized=true;
      return;
    }
    validateState(stored);
    for(const character of stored.characters)this.characters.set(character.id,cloneCharacter(character));

    let active=this.characters.get(stored.activeCharacterId);
    let repaired=false;
    if(!active?.enabled){
      const replacement=[...this.characters.values()].filter(character=>character.enabled).sort(compareCharacters)[0];
      if(replacement)active=replacement;
      else{
        active=defaultCharacter(this.clock.now());
        this.characters.set(active.id,active);
        await this.publish("CharacterCreated",{characterId:active.id});
      }
      repaired=true;
    }
    this.activeCharacterId=active.id;
    if(repaired){
      await this.persist();
      await this.publish("ActiveCharacterChanged",{characterId:active.id,previousCharacterId:stored.activeCharacterId});
    }
    this.initialized=true;
  }

  async listCharacters():Promise<readonly Character[]>{
    this.ensureInitialized();
    return [...this.characters.values()].sort(compareCharacters).map(cloneCharacter);
  }

  async getCharacter(id:CharacterId):Promise<Character|undefined>{
    this.ensureInitialized();
    const character=this.characters.get(requireCharacterId(id));
    return character?cloneCharacter(character):undefined;
  }

  async getActiveCharacter():Promise<Character>{
    this.ensureInitialized();
    const active=this.activeCharacterId?this.characters.get(this.activeCharacterId):undefined;
    if(!active)throw new Error("Active character is not available.");
    return cloneCharacter(active);
  }

  async createCharacter(input:CharacterCreateInput):Promise<Character>{
    this.ensureInitialized();
    const id=requireCharacterId(this.idFactory());
    if(this.characters.has(id))throw new Error("Character id already exists.");
    const now=this.clock.now();
    const character:Character={
      id,name:requireName(input.name),description:input.description??"",
      createdAt:now,updatedAt:now,enabled:input.enabled??true
    };
    validateCharacter(character);
    this.characters.set(id,character);
    await this.persist();
    await this.publish("CharacterCreated",{characterId:id});
    return cloneCharacter(character);
  }

  async updateCharacter(id:CharacterId,input:CharacterUpdateInput):Promise<Character>{
    this.ensureInitialized();
    const character=this.requireCharacter(id);
    const enabled=input.enabled??character.enabled;
    if(character.id===this.activeCharacterId&&!enabled)throw new Error("Active character cannot be disabled.");
    const next:Character={
      ...character,
      name:input.name===undefined?character.name:requireName(input.name),
      description:input.description===undefined?character.description:input.description,
      enabled,
      updatedAt:this.clock.now()
    };
    validateCharacter(next);
    this.characters.set(id,next);
    await this.persist();
    await this.publish("CharacterUpdated",{characterId:id});
    return cloneCharacter(next);
  }

  async deleteCharacter(id:CharacterId):Promise<void>{
    this.ensureInitialized();
    const characterId=requireCharacterId(id);
    this.requireCharacter(characterId);
    const wasActive=this.activeCharacterId===characterId;
    this.characters.delete(characterId);

    if(this.characters.size===0){
      const replacement=defaultCharacter(this.clock.now());
      this.characters.set(replacement.id,replacement);
      this.activeCharacterId=replacement.id;
      await this.persist();
      await this.publish("CharacterDeleted",{characterId:characterId});
      await this.publish("CharacterCreated",{characterId:replacement.id});
      return;
    }

    if(wasActive){
      const replacement=[...this.characters.values()].filter(character=>character.enabled).sort(compareCharacters)[0];
      if(!replacement){
        const fallback=defaultCharacter(this.clock.now());
        this.characters.set(fallback.id,fallback);
        this.activeCharacterId=fallback.id;
        await this.persist();
        await this.publish("CharacterDeleted",{characterId:characterId});
        await this.publish("CharacterCreated",{characterId:fallback.id});
        await this.publish("ActiveCharacterChanged",{characterId:fallback.id,previousCharacterId:characterId});
        return;
      }
      this.activeCharacterId=replacement.id;
      await this.persist();
      await this.publish("CharacterDeleted",{characterId:characterId});
      await this.publish("ActiveCharacterChanged",{characterId:replacement.id,previousCharacterId:characterId});
      return;
    }

    await this.persist();
    await this.publish("CharacterDeleted",{characterId:characterId});
  }

  async setActiveCharacter(id:CharacterId):Promise<Character>{
    this.ensureInitialized();
    const character=this.requireCharacter(id);
    if(!character.enabled)throw new Error("Disabled characters cannot become active.");
    if(this.activeCharacterId===character.id)return cloneCharacter(character);
    const previousCharacterId=this.activeCharacterId;
    this.activeCharacterId=character.id;
    await this.persist();
    await this.publish("ActiveCharacterChanged",{characterId:character.id,...(previousCharacterId?{previousCharacterId}:{})});
    return cloneCharacter(character);
  }

  private requireCharacter(id:CharacterId):Character{
    const character=this.characters.get(requireCharacterId(id));
    if(!character)throw new Error("Character was not found.");
    return character;
  }
  private ensureInitialized():void{
    if(!this.initialized)throw new Error("CharacterManager has not been initialized.");
  }
  private async persist():Promise<void>{
    if(!this.activeCharacterId)throw new Error("Active character is not set.");
    await this.store.save({
      apiVersion:CHARACTER_API_VERSION,
      schemaVersion:CHARACTER_SCHEMA_VERSION,
      characters:[...this.characters.values()].map(cloneCharacter),
      activeCharacterId:this.activeCharacterId
    });
  }
  private async publish(type:"CharacterCreated",payload:{characterId:string}):Promise<void>;
  private async publish(type:"CharacterUpdated",payload:{characterId:string}):Promise<void>;
  private async publish(type:"CharacterDeleted",payload:{characterId:string}):Promise<void>;
  private async publish(type:"ActiveCharacterChanged",payload:{characterId:string;previousCharacterId?:string}):Promise<void>;
  private async publish(
    type:"CharacterCreated"|"CharacterUpdated"|"CharacterDeleted"|"ActiveCharacterChanged",
    payload:{characterId:string;previousCharacterId?:string}
  ):Promise<void>{
    if(!this.events)return;
    switch(type){
      case "CharacterCreated":await this.events.publish(createEvent(type,{characterId:payload.characterId},this.source,()=>this.clock.now()));break;
      case "CharacterUpdated":await this.events.publish(createEvent(type,{characterId:payload.characterId},this.source,()=>this.clock.now()));break;
      case "CharacterDeleted":await this.events.publish(createEvent(type,{characterId:payload.characterId},this.source,()=>this.clock.now()));break;
      case "ActiveCharacterChanged":await this.events.publish(createEvent(type,payload,this.source,()=>this.clock.now()));break;
    }
  }
}
