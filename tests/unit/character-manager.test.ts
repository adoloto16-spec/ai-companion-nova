import {CharacterManager,DEFAULT_CHARACTER_ID,DEFAULT_CHARACTER_NAME,InMemoryCharacterStore} from "../../core/src";
import {InMemoryEventBus} from "../../core/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  let now=0;
  let ids=0;
  const clock={now:()=>`2026-09-26T12:00:${String(now++).padStart(2,"0")}.000Z`};
  const store=new InMemoryCharacterStore();
  const events=new InMemoryEventBus();
  const observed:string[]=[];
  for(const type of ["CharacterCreated","CharacterUpdated","CharacterDeleted","ActiveCharacterChanged"]){
    events.subscribe(type,event=>{observed.push(`${event.type}:${(event.payload as {characterId:string}).characterId}`)});
  }

  const manager=new CharacterManager(store,{clock,idFactory:()=>`character.test.${++ids}`,events});
  await manager.initialize();

  const first=await manager.getActiveCharacter();
  ok(first,"default character exists");
  equal(first.id,DEFAULT_CHARACTER_ID,"default Nova stable id");
  equal(first.name,DEFAULT_CHARACTER_NAME,"default Nova name");
  equal((await manager.listCharacters()).length,1,"first initialization creates one character");

  const gm=await manager.createCharacter({name:"Game Master",description:""});
  const renamed=await manager.updateCharacter(gm.id,{name:"GM"});
  equal(renamed.id,gm.id,"rename keeps stable id");
  equal(renamed.name,"GM","rename changes name");
  equal(renamed.id!==renamed.name,true,"id is independent from name");

  await manager.setActiveCharacter(gm.id);
  equal((await manager.getActiveCharacter()).id,gm.id,"active character switched");

  const reloaded=new CharacterManager(store,{clock,idFactory:()=>`character.unused.${++ids}`});
  await reloaded.initialize();
  equal((await reloaded.listCharacters()).length,2,"characters survive manager re-instantiation");
  equal((await reloaded.getCharacter(gm.id))?.name,"GM","updated metadata survives reload");
  equal((await reloaded.getActiveCharacter()).id,gm.id,"active character survives reload");

  await reloaded.deleteCharacter(gm.id);
  equal((await reloaded.getActiveCharacter()).id,DEFAULT_CHARACTER_ID,"deleting active switches to remaining character");
  equal((await reloaded.listCharacters()).length,1,"deleted character removed");

  await reloaded.deleteCharacter(DEFAULT_CHARACTER_ID);
  equal((await reloaded.listCharacters()).length,1,"deleting last recreates deterministic Nova");
  equal((await reloaded.getActiveCharacter()).id,DEFAULT_CHARACTER_ID,"recreated Nova becomes active");

  let failed=false;
  try{await reloaded.createCharacter({name:"   "});}catch{failed=true}
  ok(failed,"empty character name rejected");

  const a=await reloaded.createCharacter({name:"A"});
  const b=await reloaded.createCharacter({name:"B"});
  ok(a.id!==b.id,"different characters have different ids");
  ok(a.id!==b.name&&b.id!==a.name,"ids do not use names");

  ok(observed.some(value=>value.startsWith("CharacterCreated:")),"created event emitted");
  ok(observed.some(value=>value.startsWith("CharacterUpdated:")),"updated event emitted");
  ok(observed.some(value=>value.startsWith("CharacterDeleted:")),"deleted event emitted");
  ok(observed.some(value=>value.startsWith("ActiveCharacterChanged:")),"active changed event emitted");

  console.log("PASS Character manager unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
