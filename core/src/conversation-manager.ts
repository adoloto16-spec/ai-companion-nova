import type {
  CharacterId,Clock,Conversation,ConversationCreateInput,ConversationId,ConversationStore,ConversationUpdateInput,
  EventBus,ChatMessage
} from "../../contracts/src/index";
import {CONVERSATION_API_VERSION,CONVERSATION_SCHEMA_VERSION,createEvent,defaultConversationId} from "../../contracts/src/index";

export interface ConversationManagerOptions{
  clock?:Clock;
  idFactory?:(characterId:CharacterId)=>ConversationId;
  events?:EventBus;
  source?:string;
  characterExists?:(characterId:CharacterId)=>Promise<boolean>;
}

const DEFAULT_TITLE="Main";
const NEW_TITLE="New Conversation";
let generatedIdSequence=0;

function defaultClock():Clock{return {now:()=>new Date().toISOString()}}
function defaultIdFactory(characterId:CharacterId):ConversationId{
  generatedIdSequence+=1;
  return "conversation:"+characterId+":"+Date.now().toString(36)+"."+generatedIdSequence.toString(36);
}
function cloneMessage(message:ChatMessage):ChatMessage{return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})}}
function cloneConversation(conversation:Conversation):Conversation{return {...conversation,messages:conversation.messages.map(cloneMessage)}}
function requireCharacterId(id:string):string{
  const value=id.trim();
  if(!value)throw new Error("Character id must not be empty.");
  return value;
}
function requireConversationId(id:string):string{
  const value=id.trim();
  if(!value)throw new Error("Conversation id must not be empty.");
  return value;
}
function requireTitle(title:string):string{
  const value=title.trim();
  if(!value)throw new Error("Conversation title must not be empty.");
  if(value.length>200)throw new Error("Conversation title must not exceed 200 characters.");
  return value;
}
function validateConversation(conversation:Conversation,characterId:CharacterId):void{
  if(conversation.apiVersion!==CONVERSATION_API_VERSION||conversation.schemaVersion!==CONVERSATION_SCHEMA_VERSION)throw new Error("Unsupported conversation version.");
  if(conversation.characterId!==characterId)throw new Error("Conversation character scope mismatch.");
  requireConversationId(conversation.id);
  requireTitle(conversation.title);
  if(!Array.isArray(conversation.messages))throw new Error("Conversation messages must be an array.");
  if(!conversation.createdAt.trim()||!conversation.updatedAt.trim())throw new Error("Conversation timestamps are required.");
}

export class ConversationManager{
  private readonly clock:Clock;
  private readonly idFactory:(characterId:CharacterId)=>ConversationId;
  private readonly events?:EventBus;
  private readonly source:string;
  private readonly characterExists?: (characterId:CharacterId)=>Promise<boolean>;

  constructor(private readonly store:ConversationStore,options:ConversationManagerOptions={}){
    this.clock=options.clock??defaultClock();
    this.idFactory=options.idFactory??defaultIdFactory;
    this.events=options.events;
    this.source=options.source??"conversation-manager";
    this.characterExists=options.characterExists;
  }

  async createConversation(characterId:CharacterId,input:ConversationCreateInput={}):Promise<Conversation>{
    const scope=await this.requireCharacter(characterId);
    const id=requireConversationId(input.id??this.idFactory(scope));
    const existing=await this.store.get(scope,id);
    if(existing)throw new Error("Conversation id already exists.");
    const now=this.clock.now();
    const title=requireTitle(input.title??NEW_TITLE);
    const conversation:Conversation={
      apiVersion:CONVERSATION_API_VERSION,
      schemaVersion:CONVERSATION_SCHEMA_VERSION,
      id,characterId:scope,title,messages:[],createdAt:now,updatedAt:now
    };
    await this.store.save(conversation);
    await this.store.setActive(scope,id);
    await this.publish("ConversationCreated",{characterId:scope,conversationId:id});
    await this.publish("ActiveConversationChanged",{characterId:scope,conversationId:id});
    return cloneConversation(conversation);
  }

  async listConversations(characterId:CharacterId):Promise<readonly Conversation[]>{
    const scope=await this.requireCharacter(characterId);
    return (await this.store.list(scope)).filter(conversation=>conversation.characterId===scope).map(cloneConversation);
  }

  async getConversation(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation|undefined>{
    const scope=await this.requireCharacter(characterId);
    const id=requireConversationId(conversationId);
    const conversation=await this.store.get(scope,id);
    if(!conversation)return undefined;
    validateConversation(conversation,scope);
    return cloneConversation(conversation);
  }

  async updateConversation(characterId:CharacterId,conversationId:ConversationId,input:ConversationUpdateInput):Promise<Conversation>{
    const scope=await this.requireCharacter(characterId);
    const current=await this.store.get(scope,requireConversationId(conversationId));
    if(!current)throw new Error("Conversation was not found.");
    validateConversation(current,scope);
    const next:Conversation={
      ...cloneConversation(current),
      ...(input.title===undefined?{}:{title:requireTitle(input.title)}),
      ...(input.messages===undefined?{}:{messages:input.messages.map(cloneMessage)}),
      updatedAt:this.clock.now()
    };
    await this.store.save(next);
    await this.publish("ConversationUpdated",{characterId:scope,conversationId:next.id});
    return cloneConversation(next);
  }

  async deleteConversation(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation>{
    const scope=await this.requireCharacter(characterId);
    const id=requireConversationId(conversationId);
    const current=await this.store.get(scope,id);
    if(!current)throw new Error("Conversation was not found.");
    validateConversation(current,scope);
    const active=await this.store.getActive(scope);
    await this.store.delete(scope,id);
    await this.publish("ConversationDeleted",{characterId:scope,conversationId:id});

    let nextActive=active?.id===id?undefined:active;
    const remaining=await this.store.list(scope);
    if(!nextActive||!remaining.some(item=>item.id===nextActive!.id)){
      const next=remaining[0];
      if(next){
        await this.store.setActive(scope,next.id);
        nextActive=next;
        await this.publish("ActiveConversationChanged",{characterId:scope,conversationId:next.id});
      }else{
        const created=await this.ensureDefaultConversation(scope);
        nextActive=created;
      }
    }
    return cloneConversation(nextActive);
  }

  async setActiveConversation(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation>{
    const scope=await this.requireCharacter(characterId);
    const id=requireConversationId(conversationId);
    const conversation=await this.store.get(scope,id);
    if(!conversation)throw new Error("Conversation was not found.");
    validateConversation(conversation,scope);
    const active=await this.store.getActive(scope);
    if(active?.id!==id){
      await this.store.setActive(scope,id);
      await this.publish("ActiveConversationChanged",{characterId:scope,conversationId:id});
    }
    return cloneConversation(conversation);
  }

  async getActiveConversation(characterId:CharacterId):Promise<Conversation>{
    const scope=await this.requireCharacter(characterId);
    const active=await this.store.getActive(scope);
    if(active&&active.characterId===scope){
      validateConversation(active,scope);
      return cloneConversation(active);
    }
    const list=await this.store.list(scope);
    if(list[0]){
      await this.store.setActive(scope,list[0].id);
      return cloneConversation(list[0]);
    }
    return this.ensureDefaultConversation(scope);
  }

  async clearConversation(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation>{
    return this.updateConversation(characterId,conversationId,{messages:[]});
  }

  private async ensureDefaultConversation(characterId:CharacterId):Promise<Conversation>{
    const id=defaultConversationId(characterId);
    const existing=await this.store.get(characterId,id);
    if(existing){
      await this.store.setActive(characterId,id);
      return cloneConversation(existing);
    }
    const now=this.clock.now();
    const conversation:Conversation={
      apiVersion:CONVERSATION_API_VERSION,
      schemaVersion:CONVERSATION_SCHEMA_VERSION,
      id,characterId,title:DEFAULT_TITLE,messages:[],createdAt:now,updatedAt:now
    };
    await this.store.save(conversation);
    await this.store.setActive(characterId,id);
    await this.publish("ConversationCreated",{characterId,conversationId:id});
    await this.publish("ActiveConversationChanged",{characterId,conversationId:id});
    return cloneConversation(conversation);
  }

  private async requireCharacter(characterId:CharacterId):Promise<CharacterId>{
    const scope=requireCharacterId(characterId);
    if(this.characterExists&&!(await this.characterExists(scope)))throw new Error("Character was not found.");
    return scope;
  }

  private async publish(type:"ConversationCreated"|"ConversationUpdated"|"ConversationDeleted"|"ActiveConversationChanged",payload:{characterId:string;conversationId:string}):Promise<void>{
    if(!this.events)return;
    await this.events.publish(createEvent(type,payload,this.source,()=>this.clock.now()));
  }
}
