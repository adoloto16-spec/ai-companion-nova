import {InMemoryAuditService,InMemoryEventBus,MemoryBrokerImpl} from "../../core/src";
import {StandardContractValidator} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}
const authority={actorId:"local-user",actorType:"user" as const,trusted:true,capabilities:[]};

async function main(){
  const store=new InMemoryMemoryStore();
  const broker=new MemoryBrokerImpl({store,validator:new StandardContractValidator(),audit:new InMemoryAuditService(),events:new InMemoryEventBus(),clock:{now:()=> "2026-10-04T19:00:00.000Z"}});
  const created=await broker.create("character.lifecycle",{
    id:"memory.lifecycle",type:"fact",content:"User prefers blue.",tags:["blue"],importance:60,confidence:70,
    validFrom:null,validUntil:null,source:"user",sourceReference:null,mutationPolicy:"locked",metadata:{test:true}
  },authority);
  equal(created.id,"memory.lifecycle","create uses code-owned explicit id");
  const edited=await broker.update("character.lifecycle","memory.lifecycle",{type:"preference",content:"User prefers cobalt blue.",tags:["blue","cobalt"],importance:80,confidence:90},authority);
  equal(edited.id,created.id,"edit preserves memory id");
  equal(edited.characterId,"character.lifecycle","edit preserves character scope");
  equal(edited.originConversationId,null,"edit cannot mutate provenance");
  ok((await broker.search({characterId:"character.lifecycle",query:"cobalt"}))[0]?.id===created.id,"edited content is current retrieval content");
  const archived=await broker.archive("character.lifecycle",created.id,authority,"manual");
  equal(archived.status,"archived","archive changes lifecycle state");
  equal(archived.archiveReason,"manual","archive stores typed reason");
  equal((await broker.search({characterId:"character.lifecycle",query:"cobalt"})).length,0,"archived memory is excluded");
  const restored=await broker.restore("character.lifecycle",created.id,authority);
  equal(restored.status,"active","restore reactivates record");
  equal(restored.id,created.id,"restore preserves id");
  equal(restored.createdAt,created.createdAt,"restore preserves createdAt");
  equal(restored.archiveReason,null,"restore clears archive reason");
  const archivedAgain=await broker.archive("character.lifecycle",created.id,authority,"duplicate");
  equal(archivedAgain.archiveReason,"duplicate","archive reason is typed");
  await broker.delete("character.lifecycle",created.id,authority);
  equal(await broker.get("character.lifecycle",created.id),undefined,"permanent delete removes canonical record");
  await broker.delete("character.lifecycle","memory.lifecycle",authority).catch(()=>{});
  console.log("PASS Memory lifecycle tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
