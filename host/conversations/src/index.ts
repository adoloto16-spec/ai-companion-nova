import type {
  CharacterId,ChatMessage,Conversation,ConversationCreateInput,ConversationId,ConversationStore,
  ConversationStoreState,ConversationUpdateInput
} from "../../../contracts/src/index";
import {CONVERSATION_API_VERSION,CONVERSATION_SCHEMA_VERSION,defaultConversationId} from "../../../contracts/src/index";

export type ConversationStoreInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;

export const CONVERSATION_COMMANDS={
  list:"list_conversations",
  get:"get_conversation",
  save:"save_conversation",
  delete:"delete_conversation",
  setActive:"set_active_conversation",
  getActive:"get_active_conversation",
  clear:"clear_conversation"
} as const;

const DEFAULT_TITLE="Main";

function cloneMessage(message:ChatMessage):ChatMessage{
  return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})};
}
function cloneConversation(conversation:Conversation):Conversation{
  return {...conversation,messages:conversation.messages.map(cloneMessage)};
}
function cloneState(state:ConversationStoreState):ConversationStoreState{
  return {
    apiVersion:state.apiVersion,
    schemaVersion:state.schemaVersion,
    conversations:state.conversations.map(cloneConversation),
    activeConversationIds:{...state.activeConversationIds}
  };
}
function requireCharacterId(characterId:string):string{
  const value=characterId.trim();
  if(!value)throw new Error("Character id must not be empty.");
  return value;
}
function requireConversationId(conversationId:string):string{
  const value=conversationId.trim();
  if(!value)throw new Error("Conversation id must not be empty.");
  return value;
}
function requireTitle(title:string):string{
  const value=title.trim();
  if(!value)throw new Error("Conversation title must not be empty.");
  if(value.length>200)throw new Error("Conversation title must not exceed 200 characters.");
  return value;
}
function validateConversation(conversation:Conversation):void{
  requireConversationId(conversation.id);
  requireCharacterId(conversation.characterId);
  requireTitle(conversation.title);
  if(conversation.apiVersion!==CONVERSATION_API_VERSION||conversation.schemaVersion!==CONVERSATION_SCHEMA_VERSION)throw new Error("Unsupported conversation version.");
  if(!Array.isArray(conversation.messages))throw new Error("Conversation messages must be an array.");
  if(!conversation.createdAt.trim()||!conversation.updatedAt.trim())throw new Error("Conversation timestamps are required.");
}
function validateState(state:ConversationStoreState):void{
  if(state.apiVersion!==CONVERSATION_API_VERSION||state.schemaVersion!==CONVERSATION_SCHEMA_VERSION)throw new Error("Unsupported conversation storage version.");
  const ids=new Set<string>();
  for(const conversation of state.conversations){
    validateConversation(conversation);
    if(ids.has(conversation.id))throw new Error("Conversation storage contains duplicate conversation ids.");
    ids.add(conversation.id);
  }
  for(const [characterId,conversationId] of Object.entries(state.activeConversationIds)){
    requireCharacterId(characterId);
    requireConversationId(conversationId);
    const conversation=state.conversations.find(item=>item.id===conversationId);
    if(!conversation||conversation.characterId!==characterId)throw new Error("Conversation active scope mismatch.");
  }
}
function compareConversations(a:Conversation,b:Conversation):number{
  return b.updatedAt.localeCompare(a.updatedAt)||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id);
}
function normalizeList(value:unknown,characterId:CharacterId):readonly Conversation[]{
  if(!Array.isArray(value))throw new Error("Conversation list response must be an array.");
  const scope=requireCharacterId(characterId);
  return value.map(item=>{
    const conversation=cloneConversation(item as Conversation);
    if(conversation.characterId!==scope)throw new Error("Conversation character scope mismatch.");
    return conversation;
  });
}
function normalizeOptionalConversation(value:unknown,characterId:CharacterId):Conversation|undefined{
  if(value===null||value===undefined)return undefined;
  const scope=requireCharacterId(characterId);
  const conversation=cloneConversation(value as Conversation);
  if(conversation.characterId!==scope)throw new Error("Conversation character scope mismatch.");
  return conversation;
}

export class InMemoryConversationStore implements ConversationStore{
  private state:ConversationStoreState={
    apiVersion:CONVERSATION_API_VERSION,
    schemaVersion:CONVERSATION_SCHEMA_VERSION,
    conversations:[],
    activeConversationIds:{}
  };

  async list(characterId:CharacterId):Promise<readonly Conversation[]>{
    const scope=requireCharacterId(characterId);
    return this.state.conversations.filter(item=>item.characterId===scope).sort(compareConversations).map(cloneConversation);
  }

  async get(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation|undefined>{
    const scope=requireCharacterId(characterId);
    const id=requireConversationId(conversationId);
    const conversation=this.state.conversations.find(item=>item.id===id);
    if(conversation&&conversation.characterId!==scope)throw new Error("Conversation character scope mismatch.");
    return conversation?cloneConversation(conversation):undefined;
  }

  async save(conversation:Conversation):Promise<void>{
    validateConversation(conversation);
    const scope=conversation.characterId;
    const existingById=this.state.conversations.find(item=>item.id===conversation.id);
    if(existingById&&existingById.characterId!==scope)throw new Error("Conversation id is owned by another Character.");
    this.state.conversations=this.state.conversations.filter(item=>item.id!==conversation.id);
    this.state.conversations=[...this.state.conversations,cloneConversation(conversation)];
    if(!this.state.activeConversationIds[scope])this.state.activeConversationIds={...this.state.activeConversationIds,[scope]:conversation.id};
  }

  async delete(characterId:CharacterId,conversationId:ConversationId):Promise<void>{
    const scope=requireCharacterId(characterId),id=requireConversationId(conversationId);
    const conversation=this.state.conversations.find(item=>item.id===id);
    if(!conversation)return;
    if(conversation.characterId!==scope)throw new Error("Conversation character scope mismatch.");
    this.state.conversations=this.state.conversations.filter(item=>item.id!==id);
    if(this.state.activeConversationIds[scope]===id){
      const remaining=this.state.conversations.filter(item=>item.characterId===scope).sort(compareConversations);
      if(remaining[0])this.state.activeConversationIds={...this.state.activeConversationIds,[scope]:remaining[0]!.id};
      else{
        const now=new Date().toISOString();
        const replacement:Conversation={
          apiVersion:CONVERSATION_API_VERSION,
          schemaVersion:CONVERSATION_SCHEMA_VERSION,
          id:defaultConversationId(scope),
          characterId:scope,
          title:DEFAULT_TITLE,
          messages:[],
          createdAt:now,
          updatedAt:now
        };
        this.state.conversations=[...this.state.conversations,replacement];
        this.state.activeConversationIds={...this.state.activeConversationIds,[scope]:replacement.id};
      }
    }
  }

  async setActive(characterId:CharacterId,conversationId:ConversationId):Promise<void>{
    const scope=requireCharacterId(characterId),id=requireConversationId(conversationId);
    const conversation=this.state.conversations.find(item=>item.id===id);
    if(!conversation)throw new Error("Conversation was not found.");
    if(conversation.characterId!==scope)throw new Error("Conversation character scope mismatch.");
    this.state.activeConversationIds={...this.state.activeConversationIds,[scope]:id};
  }

  async getActive(characterId:CharacterId):Promise<Conversation|undefined>{
    const scope=requireCharacterId(characterId);
    const activeId=this.state.activeConversationIds[scope];
    if(activeId){
      const active=await this.get(scope,activeId);
      if(active)return active;
    }
    const first=(await this.list(scope))[0];
    return first;
  }

  async load(characterId:CharacterId):Promise<Conversation|undefined>{return this.getActive(characterId)}

  async clear(characterId:CharacterId,conversationId?:ConversationId):Promise<void>{
    const current=conversationId?await this.get(characterId,conversationId):await this.getActive(characterId);
    if(!current)return;
    const now=new Date().toISOString();
    await this.save({...current,messages:[],updatedAt:now});
  }

  getState():ConversationStoreState{return cloneState(this.state)}
}

export class IpcConversationStore implements ConversationStore{
  constructor(private readonly invoke:ConversationStoreInvoke){}

  async list(characterId:CharacterId):Promise<readonly Conversation[]>{
    const value=await this.invoke(CONVERSATION_COMMANDS.list,{characterId});
    return normalizeList(value,characterId);
  }

  async get(characterId:CharacterId,conversationId:ConversationId):Promise<Conversation|undefined>{
    const value=await this.invoke(CONVERSATION_COMMANDS.get,{characterId,conversationId});
    return normalizeOptionalConversation(value,characterId);
  }

  async save(conversation:Conversation):Promise<void>{
    await this.invoke(CONVERSATION_COMMANDS.save,{conversation:cloneConversation(conversation)});
  }

  async delete(characterId:CharacterId,conversationId:ConversationId):Promise<void>{
    await this.invoke(CONVERSATION_COMMANDS.delete,{characterId,conversationId});
  }

  async setActive(characterId:CharacterId,conversationId:ConversationId):Promise<void>{
    await this.invoke(CONVERSATION_COMMANDS.setActive,{characterId,conversationId});
  }

  async getActive(characterId:CharacterId):Promise<Conversation|undefined>{
    const value=await this.invoke(CONVERSATION_COMMANDS.getActive,{characterId});
    return normalizeOptionalConversation(value,characterId);
  }

  async load(characterId:CharacterId):Promise<Conversation|undefined>{return this.getActive(characterId)}

  async clear(characterId:CharacterId,conversationId?:ConversationId):Promise<void>{
    const resolved=conversationId??(await this.getActive(characterId))?.id;
    if(!resolved)return;
    await this.invoke(CONVERSATION_COMMANDS.clear,{characterId,conversationId:resolved});
  }
}

export function createConversationTemplate(characterId:CharacterId,input:ConversationCreateInput={},now=new Date().toISOString()):Conversation{
  const scope=requireCharacterId(characterId);
  const title=requireTitle(input.title??DEFAULT_TITLE);
  const id=requireConversationId(input.id??defaultConversationId(scope));
  return {
    apiVersion:CONVERSATION_API_VERSION,
    schemaVersion:CONVERSATION_SCHEMA_VERSION,
    id,characterId:scope,title,messages:[],createdAt:now,updatedAt:now
  };
}

export function updateConversationValue(conversation:Conversation,input:ConversationUpdateInput,now=new Date().toISOString()):Conversation{
  return {
    ...cloneConversation(conversation),
    ...(input.title===undefined?{}:{title:requireTitle(input.title)}),
    ...(input.messages===undefined?{}:{messages:input.messages.map(cloneMessage)}),
    updatedAt:now
  };
}
