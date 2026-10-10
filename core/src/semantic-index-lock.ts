import type {CharacterId,MemorySemanticIndexStore,MemorySemanticVectorRecord} from "../../contracts/src/index";

export const SEMANTIC_SEARCH_RECORD_PREFIX="semantic-search:";
const locks=new WeakMap<object,Promise<void>>();

/** Serialize read/modify/write operations shared by the memory deduplicator and semantic retrieval. */
export async function withMemorySemanticIndexLock<T>(store:MemorySemanticIndexStore,operation:()=>Promise<T>):Promise<T>{
  const key=store as object,previous=locks.get(key)??Promise.resolve();
  let release!:()=>void;
  const current=new Promise<void>(resolve=>{release=resolve});
  locks.set(key,current);
  await previous.catch(()=>{});
  try{return await operation()}
  finally{release();if(locks.get(key)===current)locks.delete(key)}
}

/** Replace the caller's records while retaining the other index user's partition. */
export async function replaceMemorySemanticIndexPartition(
  store:MemorySemanticIndexStore,
  characterId:CharacterId,
  isOwned:(memoryId:string)=>boolean,
  records:readonly MemorySemanticVectorRecord[]
):Promise<void>{
  await withMemorySemanticIndexLock(store,async()=>{
    const existing=await store.load(characterId);
    const retained=(existing?.records??[]).filter(record=>!isOwned(record.memoryId));
    await store.save({apiVersion:existing?.apiVersion??"1",schemaVersion:existing?.schemaVersion??"1",characterId,
      records:[...retained,...records].sort((a,b)=>a.memoryId.localeCompare(b.memoryId))});
  });
}
