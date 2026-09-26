import {CoreBookManager} from "../../core/src";
import {InMemoryCoreBookStore} from "../../host/core-book/src";
import {InMemoryEventBus} from "../../core/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  let now=0;
  let ids=0;
  const clock={now:()=>`2026-09-26T12:00:${String(now++).padStart(2,"0")}.000Z`};
  const store=new InMemoryCoreBookStore();
  const events=new InMemoryEventBus();
  const observed:string[]=[];
  for(const type of ["CoreBookEntryCreated","CoreBookEntryUpdated","CoreBookEntryDeleted","CoreBookEntryEnabledChanged"]){
    events.subscribe(type,event=>{observed.push(event.type);});
  }
  const characters=new Set(["character.a","character.b"]);
  const manager=new CoreBookManager(store,{clock,idFactory:()=>`core-book.test.${++ids}`,events,characterExists:async id=>characters.has(id)});

  const a=await manager.createCoreBookEntry("character.a",{
    title:"A identity",content:"Alpha",tags:["identity"],activation:{kind:"keyword",keywords:["Nova","alpha"],matchMode:"any",caseSensitive:false},
    retentionPriority:90,placementWeight:10,mutationPolicy:"locked",enabled:true,source:"user",metadata:{origin:"test"}
  });
  equal(a.characterId,"character.a","entry scoped to character A");
  equal((await manager.listCoreBookEntries("character.a")).length,1,"A has one entry");

  const b=await manager.createCoreBookEntry("character.b",{title:"B lore",content:"Bravo",activation:{kind:"regex",pattern:"\\bBravo\\b",flags:"i"},source:"import"});
  equal((await manager.listCoreBookEntries("character.b")).length,1,"B has one entry");

  ok((await manager.getCoreBookEntry("character.a",a.id))?.id===a.id,"A entry readable in A scope");
  ok((await manager.getCoreBookEntry("character.a",b.id))===undefined,"B entry hidden from A scope");
  let crossScopeUpdate=false;
  try{await manager.updateCoreBookEntry("character.a",b.id,{title:"leak"});}catch{crossScopeUpdate=true}
  ok(crossScopeUpdate,"cross-character update rejected");

  const updated=await manager.updateCoreBookEntry("character.a",a.id,{title:"A identity renamed"});
  equal(updated.id,a.id,"rename preserves Core Book entry identity");
  equal(updated.title,"A identity renamed","entry updated");

  const disabled=await manager.setCoreBookEntryEnabled("character.a",a.id,false);
  equal(disabled.enabled,false,"entry disables without deletion");
  equal((await manager.getCoreBookEntry("character.a",a.id))?.title,"A identity renamed","disabled entry remains stored");

  const reloaded=new CoreBookManager(store,{clock,idFactory:()=>`core-book.unused.${++ids}`,events,characterExists:async id=>characters.has(id)});
  equal((await reloaded.listCoreBookEntries("character.a")).length,1,"A entries survive manager reload");
  equal((await reloaded.listCoreBookEntries("character.a"))[0]?.enabled,false,"enabled state survives reload");
  equal((await reloaded.listCoreBookEntries("character.b"))[0]?.content,"Bravo","B data remains isolated");

  const semantic=await reloaded.createCoreBookEntry("character.a",{title:"Reserved semantic",content:"future",activation:{kind:"semantic"},source:"system"});
  const modelSearch=await reloaded.createCoreBookEntry("character.a",{title:"Reserved model search",content:"future",activation:{kind:"model_search"},source:"system"});
  ok(semantic.activation.kind==="semantic"&&modelSearch.activation.kind==="model_search","reserved activation modes are stored without retrieval");

  let invalidRegex=false;
  try{await reloaded.createCoreBookEntry("character.a",{title:"Bad regex",content:"x",activation:{kind:"regex",pattern:"[",flags:""}});}catch{invalidRegex=true}
  ok(invalidRegex,"invalid regex activation rejected deterministically");

  let unknownCharacter=false;
  try{await reloaded.listCoreBookEntries("character.unknown");}catch{unknownCharacter=true}
  ok(unknownCharacter,"unknown character scope rejected");

  await reloaded.deleteCoreBookEntry("character.a",a.id);
  equal((await reloaded.listCoreBookEntries("character.a")).some(entry=>entry.id===a.id),false,"entry deleted from A");
  equal((await reloaded.listCoreBookEntries("character.b")).length,1,"B remains after A deletion");

  ok(observed.includes("CoreBookEntryCreated"),"created event emitted");
  ok(observed.includes("CoreBookEntryUpdated"),"updated event emitted");
  ok(observed.includes("CoreBookEntryDeleted"),"deleted event emitted");
  ok(observed.includes("CoreBookEntryEnabledChanged"),"enabled event emitted");

  console.log("PASS Core Book manager unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
