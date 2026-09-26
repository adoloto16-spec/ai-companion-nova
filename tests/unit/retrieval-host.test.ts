import {IpcFullTextRetriever,RETRIEVAL_COMMANDS} from "../../host/retrieval/src";
import type {RetrievalQuery} from "../../contracts/src";
function ok(value:unknown,label:string){if(!value)throw new Error(label)}
async function main(){
  const calls:Array<{command:string;args?:Record<string,unknown>}>=[];  
  const valid=(query:RetrievalQuery)=>({apiVersion:"1",schemaVersion:"1",characterId:query.characterId,query:query.query,candidates:[],degraded:false});
  const invoke=async(command:string,args?:Record<string,unknown>)=>{calls.push({command,args});return command===RETRIEVAL_COMMANDS.search?valid(args?.query as RetrievalQuery):undefined};
  const retriever=new IpcFullTextRetriever(invoke);
  const query={apiVersion:"1" as const,schemaVersion:"1",characterId:"character.a",query:"Berlin",sources:["memory" as const],limit:5};
  const result=await retriever.search(query);ok(result.characterId==="character.a","search preserves character scope");
  ok(calls[0]?.command===RETRIEVAL_COMMANDS.search,"search uses retrieval command boundary");
  await retriever.rebuild("character.a");await retriever.rebuildAll();
  ok(calls.some(x=>x.command===RETRIEVAL_COMMANDS.rebuild),"rebuild uses host boundary");
  ok(calls.some(x=>x.command===RETRIEVAL_COMMANDS.rebuildAll),"rebuildAll uses host boundary");
  console.log("PASS Retrieval host adapter tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
