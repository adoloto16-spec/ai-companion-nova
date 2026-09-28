import type {CharacterId,Conversation,ConversationStore,ChatMessage} from "../../../contracts/src/index";

export type ConversationStoreInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;

export const CONVERSATION_COMMANDS={
  get:"get_conversation",
  save:"save_conversation",
  clear:"clear_conversation"
} as const;

function cloneMessage(message:ChatMessage):ChatMessage{
  return {...message,...(message.metadata?{metadata:{...message.metadata}}:{})};
}
function cloneConversation(conversation:Conversation):Conversation{
  return {
    apiVersion:conversation.apiVersion,
    schemaVersion:conversation.schemaVersion,
    id:conversation.id,
    characterId:conversation.characterId,
    messages:conversation.messages.map(cloneMessage),
    createdAt:conversation.createdAt,
    updatedAt:conversation.updatedAt
  };
}


export class InMemoryConversationStore implements ConversationStore{
  private readonly conversations=new Map<CharacterId,Conversation>();
  async load(characterId:CharacterId):Promise<Conversation|undefined>{
    const conversation=this.conversations.get(characterId);
    return conversation?cloneConversation(conversation):undefined;
  }
  async save(conversation:Conversation):Promise<void>{
    if(conversation.characterId.trim().length===0)throw new Error("Conversation character scope must not be empty.");
    this.conversations.set(conversation.characterId,cloneConversation(conversation));
  }
  async clear(characterId:CharacterId):Promise<void>{
    this.conversations.delete(characterId);
  }
}

export class IpcConversationStore implements ConversationStore{
  constructor(private readonly invoke:ConversationStoreInvoke){}
  async load(characterId:CharacterId):Promise<Conversation|undefined>{
    const value=await this.invoke(CONVERSATION_COMMANDS.get,{characterId});
    return value===null||value===undefined?undefined:cloneConversation(value as Conversation);
  }
  async save(conversation:Conversation):Promise<void>{
    await this.invoke(CONVERSATION_COMMANDS.save,{conversation:cloneConversation(conversation)});
  }
  async clear(characterId:CharacterId):Promise<void>{
    await this.invoke(CONVERSATION_COMMANDS.clear,{characterId});
  }
}
