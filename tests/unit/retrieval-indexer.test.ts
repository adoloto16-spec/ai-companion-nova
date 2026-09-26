import {CoreBookManager,InMemoryAuditService,InMemoryEventBus,MemoryBrokerImpl,RetrievalEventIndexer} from "../../core/src";
import {StandardContractValidator} from "../../contracts/src";
import {InMemoryCoreBookStore} from "../../host/core-book/src";
import {InMemoryMemoryStore} from "../../host/memory/src";

function ok(value:unknown,label:string){if(!value)throw new Error(label)}
function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}

async function main(){
  const events=new InMemoryEventBus();
  const characters=new Set(["character.a"]);
  const coreBook=new CoreBookManager(new InMemoryCoreBookStore(),{events,characterExists:async id=>characters.has(id)});
  const memory=new MemoryBrokerImpl({store:new InMemoryMemoryStore(),validator:new StandardContractValidator(),audit:new InMemoryAuditService(),events,characterExists:async id=>characters.has(id)});
  const upserts:unknown[]=[];const removals:Array<{characterId:string;source:string;sourceId:string}>=[];const writer={upsert:async(document:unknown)=>{upserts.push(document)},remove:async(characterId:string,source:string,sourceId:string)=>{removals.push({characterId,source,sourceId})},removeCharacter:async(characterId:string)=>{removals.push({characterId,source:"*",sourceId:"*"})}};
  const indexer=new RetrievalEventIndexer({events,coreBook,memory,writer});indexer.start();
  const user={actorId:"user",actorType:"user" as const,trusted:true,capabilities:[]};
  const entry=await coreBook.createCoreBookEntry("character.a",{title:"Berlin canon",content:"Nova lives in Berlin",tags:["berlin"],source:"user"});
  ok((upserts as Array<{sourceId:string;source:string}>).some(x=>x.sourceId===entry.id&&x.source==="core_book"),"Core Book create indexes enabled entry");
  await coreBook.updateCoreBookEntry("character.a",entry.id,{content:"Nova lives in Munich"});
  ok((upserts as Array<{sourceId:string;content:string}>).some(x=>x.sourceId===entry.id&&x.content==="Nova lives in Munich"),"Core Book update refreshes index");
  await coreBook.setCoreBookEntryEnabled("character.a",entry.id,false);
  ok(removals.some(x=>x.sourceId===entry.id&&x.source==="core_book"),"Core Book disable removes index");
  await coreBook.deleteCoreBookEntry("character.a",entry.id);
  const memoryOne=await memory.create("character.a",{id:"memory.a.1",type:"fact",content:"Nova visited Berlin",tags:["berlin"],source:"user"},user);
  ok((upserts as Array<{sourceId:string;source:string}>).some(x=>x.sourceId===memoryOne.id&&x.source==="memory"),"Memory create indexes active item");
  await memory.update("character.a",memoryOne.id,{content:"Nova visited Munich"},user);
  ok((upserts as Array<{sourceId:string;content:string}>).some(x=>x.sourceId===memoryOne.id&&x.content==="Nova visited Munich"),"Memory update refreshes index");
  const replacement=await memory.supersede("character.a",memoryOne.id,{id:"memory.a.2",type:"fact",content:"Nova visited Hamburg",tags:["hamburg"],source:"user"},user);
  ok(removals.some(x=>x.sourceId===memoryOne.id&&x.source==="memory"),"Memory supersede removes old index");
  ok((upserts as Array<{sourceId:string}>).some(x=>x.sourceId===replacement.id),"Memory supersede indexes replacement");
  await memory.archive("character.a",replacement.id,user);
  ok(removals.some(x=>x.sourceId===replacement.id&&x.source==="memory"),"Memory archive removes index");
  const failingWriter={upsert:async()=>{throw new Error("index unavailable")},remove:async()=>{throw new Error("index unavailable")},removeCharacter:async()=>{throw new Error("index unavailable")}};
  const isolated=new RetrievalEventIndexer({events,coreBook,memory,writer:failingWriter});isolated.start();
  const canonical=await coreBook.createCoreBookEntry("character.a",{title:"Canonical",content:"Canonical survives",source:"user"});
  equal(canonical.content,"Canonical survives","canonical mutation succeeds despite index failure");
  isolated.stop();indexer.stop();
  console.log("PASS Retrieval event indexer tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
