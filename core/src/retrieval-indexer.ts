import type {CoreBookEntry,CoreBookEntryId,EventBus,EventPayloadMap,MemoryBroker,MemoryItem,RetrievalIndexDocument,RetrievalIndexWriter,RetrievalSource} from "../../contracts/src/index";

export interface CoreBookRetrievalReader{getCoreBookEntry(characterId:string,entryId:CoreBookEntryId):Promise<CoreBookEntry|undefined>}
export interface RetrievalEventIndexerOptions{events:EventBus;coreBook:CoreBookRetrievalReader;memory:Pick<MemoryBroker,"get">;writer:RetrievalIndexWriter}

function coreDocument(entry:CoreBookEntry):RetrievalIndexDocument{return{apiVersion:"1",schemaVersion:"1",characterId:entry.characterId,source:"core_book",sourceId:entry.id,title:entry.title,content:entry.content,tags:[...entry.tags],status:"enabled",updatedAt:entry.updatedAt}}
function memoryDocument(item:MemoryItem):RetrievalIndexDocument{return{apiVersion:"1",schemaVersion:"1",characterId:item.characterId,...(item.originConversationId?{conversationId:item.originConversationId}:{}),source:"memory",sourceId:item.id,title:"",content:item.content,tags:[...item.tags],status:item.status,type:item.type,updatedAt:item.updatedAt}}

export class RetrievalEventIndexer{
  private readonly unsubs:Array<()=>void>=[];
  private started=false;
  constructor(private readonly options:RetrievalEventIndexerOptions){}
  start():void{
    if(this.started)return;
    this.started=true;
    const {events}=this.options;
    this.unsubs.push(
      events.subscribe<EventPayloadMap["CoreBookEntryCreated"]>("CoreBookEntryCreated",event=>this.refreshCoreBook(event.payload.characterId,event.payload.entryId)),
      events.subscribe<EventPayloadMap["CoreBookEntryUpdated"]>("CoreBookEntryUpdated",event=>this.refreshCoreBook(event.payload.characterId,event.payload.entryId)),
      events.subscribe<EventPayloadMap["CoreBookEntryDeleted"]>("CoreBookEntryDeleted",event=>this.remove(event.payload.characterId,"core_book",event.payload.entryId)),
      events.subscribe<EventPayloadMap["CoreBookEntryEnabledChanged"]>("CoreBookEntryEnabledChanged",event=>event.payload.enabled?this.refreshCoreBook(event.payload.characterId,event.payload.entryId):this.remove(event.payload.characterId,"core_book",event.payload.entryId)),
      events.subscribe<EventPayloadMap["MemoryCreated"]>("MemoryCreated",event=>this.refreshMemory(event.payload.characterId,event.payload.memoryId,event.payload.originConversationId)),
      events.subscribe<EventPayloadMap["MemoryUpdated"]>("MemoryUpdated",event=>this.refreshMemory(event.payload.characterId,event.payload.memoryId,event.payload.originConversationId)),
      events.subscribe<EventPayloadMap["MemorySuperseded"]>("MemorySuperseded",async event=>{await this.remove(event.payload.characterId,"memory",event.payload.previousMemoryId,event.payload.originConversationId);await this.refreshMemory(event.payload.characterId,event.payload.memoryId,event.payload.originConversationId)}),
      events.subscribe<EventPayloadMap["MemoryArchived"]>("MemoryArchived",event=>this.remove(event.payload.characterId,"memory",event.payload.memoryId,event.payload.originConversationId)),
    events.subscribe<EventPayloadMap["MemoryRestored"]>("MemoryRestored",event=>this.refreshMemory(event.payload.characterId,event.payload.memoryId,event.payload.originConversationId)),
    events.subscribe<EventPayloadMap["MemoryDeleted"]>("MemoryDeleted",event=>this.remove(event.payload.characterId,"memory",event.payload.memoryId,event.payload.originConversationId)),
      events.subscribe<EventPayloadMap["CharacterDeleted"]>("CharacterDeleted",event=>this.options.writer.removeCharacter(event.payload.characterId))
    );
  }
  stop():void{for(const unsubscribe of this.unsubs.splice(0))unsubscribe();this.started=false}
  private async refreshCoreBook(characterId:string,entryId:string):Promise<void>{
    const entry=await this.options.coreBook.getCoreBookEntry(characterId,entryId);
    if(!entry||!entry.enabled){await this.remove(characterId,"core_book",entryId);return}
    await this.options.writer.upsert(coreDocument(entry));
  }
  private async refreshMemory(characterId:string,memoryId:string,originConversationId?:string):Promise<void>{
    const item=await this.options.memory.get(characterId,memoryId);
    if(!item||item.status!=="active"){await this.remove(characterId,"memory",memoryId,originConversationId);return}
    await this.options.writer.upsert(memoryDocument(item));
  }
  private async remove(characterId:string,source:RetrievalSource,sourceId:string,conversationId?:string):Promise<void>{await this.options.writer.remove(characterId,source,sourceId,conversationId)}
}
