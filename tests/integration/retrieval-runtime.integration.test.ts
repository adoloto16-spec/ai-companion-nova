import type {RetrievalQuery,RetrievalResult,Retriever} from "../../contracts/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryCoreBookStore} from "../../host/core-book/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import {createFoundationRuntime} from "../../runtime/bootstrap/src";

function ok(value:unknown,label:string){if(!value)throw new Error(label)}
function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}

async function main(){
  const queries:RetrievalQuery[]=[];
  const calls:{rebuild:string[];rebuildAll:number}={rebuild:[],rebuildAll:0};
  const retriever:Retriever={
    search:async(query):Promise<RetrievalResult>=>{
      queries.push(query);
      return {apiVersion:"1",schemaVersion:"1",characterId:query.characterId,query:query.query,candidates:[],degraded:false};
    },
    rebuild:async(characterId)=>{calls.rebuild.push(characterId)},
    rebuildAll:async()=>{calls.rebuildAll+=1}
  };
  const runtime=await createFoundationRuntime({
    characterStore:new InMemoryCharacterStore(),
    coreBookStore:new InMemoryCoreBookStore(),
    memoryStore:new InMemoryMemoryStore(),
    retriever
  });
  await runtime.start();
  try{
    const character=await runtime.getActiveCharacter();
    equal(calls.rebuildAll,1,"runtime startup rebuilds derived retrieval index");
    await runtime.searchRetrieval({apiVersion:"1",schemaVersion:"1",characterId:character.id,query:"Berlin",limit:5});
    equal(queries[0]?.characterId,character.id,"runtime retrieval preserves character scope");
    await runtime.rebuildRetrieval(character.id);
    equal(calls.rebuild[0],character.id,"runtime rebuild delegates to Retriever");
    await runtime.rebuildAllRetrieval();
    equal(calls.rebuildAll,2,"runtime rebuildAll delegates to Retriever");
  }finally{await runtime.stop()}

  const failing:Retriever={
    search:async(query):Promise<RetrievalResult>=>({apiVersion:"1",schemaVersion:"1",characterId:query.characterId,query:query.query,candidates:[],degraded:true,error:"unavailable"}),
    rebuild:async()=>{throw new Error("index unavailable")},
    rebuildAll:async()=>{throw new Error("index unavailable")}
  };
  const degradedRuntime=await createFoundationRuntime({
    characterStore:new InMemoryCharacterStore(),
    coreBookStore:new InMemoryCoreBookStore(),
    memoryStore:new InMemoryMemoryStore(),
    retriever:failing
  });
  await degradedRuntime.start();
  try{
    const diagnostics=await degradedRuntime.diagnostics();
    equal(diagnostics.runtimeStatus,"degraded","retrieval rebuild failure degrades runtime");
    const character=await degradedRuntime.getActiveCharacter();
    equal(character.id,"character.nova.default.v1","Character initialization survives degraded retrieval");
    const entry=await degradedRuntime.createCoreBookEntry(character.id,{title:"Canonical survives",content:"Still stored",activation:{kind:"always"},source:"user"});
    equal(entry.title,"Canonical survives","canonical Core Book remains usable when retrieval is degraded");
    equal((await degradedRuntime.listCoreBookEntries(character.id)).length,1,"Core Book remains readable when retrieval is degraded");
    const response=await degradedRuntime.chat({
      apiVersion:"1",
      schemaVersion:"1",
      requestId:"retrieval-degraded",
      model:"fake-chat",
      context:{conversationId:"retrieval-degraded",messages:[{role:"user",content:"hello"}]}
    });
    equal(response.providerId,"fake.chat","Chat remains available when retrieval is degraded");
  }finally{await degradedRuntime.stop()}
  console.log("PASS Retrieval runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
