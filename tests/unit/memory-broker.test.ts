import {InMemoryAuditService,InMemoryEventBus,MemoryBrokerImpl} from "../../core/src";
import {StandardContractValidator} from "../../contracts/src";
import {InMemoryMemoryStore} from "../../host/memory/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  let now=0;
  let ids=0;
  const clock={now:()=>`2026-09-26T12:00:${String(now++).padStart(2,"0")}.000Z`};
  const store=new InMemoryMemoryStore();
  const audit=new InMemoryAuditService();
  const events=new InMemoryEventBus();
  const observed:string[]=[];
  for(const type of ["MemoryCreated","MemoryUpdated","MemorySuperseded","MemoryArchived"]){
    events.subscribe(type,event=>{observed.push(event.type);});
  }
  const characters=new Set(["character.a","character.b"]);
  const broker=new MemoryBrokerImpl({
    store,validator:new StandardContractValidator(),audit,events,clock,
    characterExists:async id=>characters.has(id)
  });
  const user={actorId:"test-user",actorType:"user" as const,trusted:true,capabilities:[]};

  const locked=await broker.create("character.a",{
    id:"memory.a.1",type:"fact",content:"Nova lives in Berlin",tags:["home"],importance:90,confidence:80,
    source:"conversation",sourceReference:"conversation/message-1",mutationPolicy:"locked",metadata:{origin:"test"}
  },user);
  const found=await broker.search({characterId:"character.a",query:"Berlin"});
  equal(found.map(item=>item.id),["memory.a.1"],"substring search finds memory");

  const b=await broker.create("character.b",{id:"memory.b.1",type:"preference",content:"Likes tea",tags:["drink","tea"],importance:50,confidence:60,source:"user"},user);
  equal(await broker.get("character.a",b.id),undefined,"character isolation prevents cross-scope get");
  let crossScope=false;
  try{await broker.update("character.a",b.id,{content:"leak"},user);}catch{crossScope=true}
  ok(crossScope,"character isolation rejects cross-scope mutation");

  let lockedDenied=false;
  try{await broker.update("character.a",locked.id,{content:"Nova lives in Munich"},{actorId:"model",actorType:"model",trusted:true,capabilities:["memory.write.auto"]});}catch{lockedDenied=true}
  ok(lockedDenied,"locked mutation policy blocks model mutation");

  const suggested=await broker.create("character.a",{id:"memory.a.2",type:"preference",content:"Likes black tea",tags:["tea"],importance:60,confidence:70,source:"user",mutationPolicy:"suggest"},user);
  let suggestDenied=false;
  try{await broker.update("character.a",suggested.id,{content:"Likes green tea"},{actorId:"model",actorType:"model",trusted:true,capabilities:["memory.write.auto"]});}catch{suggestDenied=true}
  ok(suggestDenied,"suggest mutation policy blocks direct model mutation");
  const applied=await broker.update("character.a",suggested.id,{content:"Likes green tea"},{actorId:"moderator",actorType:"model",trusted:true,capabilities:["memory.write.suggest.apply"]});
  equal(applied.content,"Likes green tea","explicit suggest authority applies model mutation");

  const autoMemory=await broker.create("character.a",{id:"memory.a.4",type:"observation",content:"Auto-write enabled memory",tags:["auto"],importance:40,confidence:40,source:"system",mutationPolicy:"auto"},user);
  let autoDenied=false;
  try{await broker.update("character.a",autoMemory.id,{content:"still denied"},{actorId:"model",actorType:"model",trusted:true,capabilities:[]});}catch{autoDenied=true}
  ok(autoDenied,"auto mutation policy requires explicit authority");
  const autoApplied=await broker.update("character.a",autoMemory.id,{content:"Auto-write applied"},{actorId:"memory-worker",actorType:"model",trusted:true,capabilities:["memory.write.auto"]});
  equal(autoApplied.content,"Auto-write applied","auto mutation policy permits explicit authority");

  const superseded=await broker.supersede("character.a",locked.id,{
    id:"memory.a.3",type:"fact",content:"Nova lives in Munich",tags:["home"],importance:95,confidence:85,
    source:"user",mutationPolicy:"locked"
  },user);
  equal(superseded.status,"active","replacement stays active");
  equal((await broker.get("character.a","memory.a.1"))?.status,"superseded","old memory is retained and superseded");
  equal((await broker.get("character.a","memory.a.1"))?.sourceReference,"conversation/message-1","old provenance remains preserved");
  equal((await broker.search({characterId:"character.a",query:"",status:"active"})).filter(item=>item.type==="fact").length,1,"supersede leaves one active fact version");
  equal((await broker.search({characterId:"character.a",query:"Berlin"})).length,0,"active search excludes superseded memory");
  equal((await broker.search({characterId:"character.a",query:"Berlin",status:"superseded"})).length,1,"status filter finds superseded history");

  const archived=await broker.archive("character.b",b.id,user);
  equal(archived.status,"archived","archive preserves memory data");
  equal((await broker.search({characterId:"character.b",query:"tea"})).length,0,"ordinary search excludes archived memory");

  let invalidTransition=false;
  try{await broker.update("character.a",locked.id,{content:"cannot edit superseded" },user);}catch{invalidTransition=true}
  ok(invalidTransition,"superseded memory cannot be updated");
  let secondArchiveDenied=false;
  try{await broker.archive("character.b",b.id,user);}catch{secondArchiveDenied=true}
  ok(secondArchiveDenied,"archived memory cannot be archived twice");

  const filtered=await broker.search({characterId:"character.a",query:"",types:["preference"],tags:["tea"],limit:1});
  equal(filtered.length,1,"search applies type and tag filters");
  equal(filtered[0]?.id,"memory.a.2","search applies deterministic limit");

  let invalid=false;
  try{await broker.create("character.a",{id:"invalid",type:"fact",content:"x",source:"conversation",sourceReference:"",mutationPolicy:"locked"},user);}catch{invalid=true}
  ok(invalid,"conversation provenance requires sourceReference");

  let badTime=false;
  try{await broker.create("character.a",{id:"bad-time",type:"fact",content:"x",source:"user",validFrom:"not-a-time"},user);}catch{badTime=true}
  ok(badTime,"invalid temporal value rejected");

  let badType=false;
  const invalidType=new StandardContractValidator().validateMemoryItem({...locked,type:"not-a-memory-type"} as unknown);
  badType=!invalidType.valid;
  ok(badType,"memory schema rejects invalid type");

  const invalidStatus=new StandardContractValidator().validateMemoryItem({...locked,status:"invalid"} as unknown);
  ok(!invalidStatus.valid,"memory schema rejects invalid status");

  const invalidPolicy=new StandardContractValidator().validateMemoryItem({...locked,mutationPolicy:"invalid"} as unknown);
  ok(!invalidPolicy.valid,"memory schema rejects invalid mutationPolicy");

  let badScore=false;
  try{await broker.create("character.a",{id:"bad-score",type:"fact",content:"x",source:"user",confidence:101},user);}catch{badScore=true}
  ok(badScore,"invalid confidence rejected");

  let unknownFieldSchema=false;
  try{
    const validator=new StandardContractValidator();
    const result=validator.validateMemoryItem({...locked,unexpected:true});
    unknownFieldSchema=!result.valid;
  }catch{unknownFieldSchema=false}
  ok(unknownFieldSchema,"memory schema rejects unknown fields");

  equal(observed.sort(),["MemoryArchived","MemoryCreated","MemoryCreated","MemoryCreated","MemoryCreated","MemorySuperseded","MemoryUpdated","MemoryUpdated"].sort(),"lifecycle events emitted");
  ok(audit.entries.some(entry=>entry.action==="memory.supersede"&&entry.actorId==="test-user"),"memory mutation audit is recorded");
  console.log("PASS Dynamic Memory broker unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
