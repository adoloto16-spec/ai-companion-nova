import type {CharacterId,RetrievalIndexDocument,RetrievalIndexWriter,RetrievalQuery,RetrievalResult,RetrievalSource,Retriever} from "../../../contracts/src/index";
import {STANDARD_SCHEMAS,StandardContractValidator} from "../../../contracts/src/index";
export type RetrievalStoreInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;
export const RETRIEVAL_COMMANDS={search:"search_retrieval_index",rebuild:"rebuild_retrieval_index",rebuildAll:"rebuild_all_retrieval_index",upsert:"upsert_retrieval_document",remove:"remove_retrieval_document",removeCharacter:"remove_retrieval_character"} as const;
const validator=new StandardContractValidator();
function validateOrThrow(value:unknown,schemaName:string){const schema=STANDARD_SCHEMAS[schemaName];if(!schema)throw new Error("Missing retrieval contract schema: "+schemaName);const result=validator.validate(value,schema);if(!result.valid)throw new Error(schemaName+" validation failed: "+result.errors.join("; "));}
export class IpcFullTextRetriever implements Retriever,RetrievalIndexWriter{
  constructor(private readonly invoke:RetrievalStoreInvoke){}
  async search(query:RetrievalQuery):Promise<RetrievalResult>{validateOrThrow(query,"retrieval-query");const value=await this.invoke(RETRIEVAL_COMMANDS.search,{query});validateOrThrow(value,"retrieval-result");return value as RetrievalResult;}
  async rebuild(characterId:CharacterId):Promise<void>{const scope=characterId.trim();if(!scope)throw new Error("Retrieval rebuild characterId must not be empty.");await this.invoke(RETRIEVAL_COMMANDS.rebuild,{characterId:scope});}
  async rebuildAll():Promise<void>{await this.invoke(RETRIEVAL_COMMANDS.rebuildAll);}
  async upsert(document:RetrievalIndexDocument):Promise<void>{validateOrThrow(document,"retrieval-index-document");await this.invoke(RETRIEVAL_COMMANDS.upsert,{document});}
  async remove(characterId:CharacterId,source:RetrievalSource,sourceId:string):Promise<void>{if(!characterId.trim()||!sourceId.trim())throw new Error("Retrieval remove scope is invalid.");await this.invoke(RETRIEVAL_COMMANDS.remove,{characterId:characterId.trim(),source,sourceId:sourceId.trim()});}
  async removeCharacter(characterId:CharacterId):Promise<void>{if(!characterId.trim())throw new Error("Retrieval remove characterId must not be empty.");await this.invoke(RETRIEVAL_COMMANDS.removeCharacter,{characterId:characterId.trim()});}
}
