import {InMemoryCoreBookStore} from "../../host/core-book/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {createFoundationRuntime as startRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const coreBookStore=new InMemoryCoreBookStore();
  const runtime=await startRuntime({characterStore,coreBookStore});
  try{
    const nova=await runtime.getActiveCharacter();
    const gm=await runtime.createCharacter({name:"GM"});
    const novaEntry=await runtime.createCoreBookEntry(nova.id,{title:"Nova canon",content:"Nova is the default companion.",source:"user"});
    const gmEntry=await runtime.createCoreBookEntry(gm.id,{title:"GM canon",content:"GM owns separate lore.",source:"user"});

    equal((await runtime.listCoreBookEntries(nova.id)).length,1,"runtime lists Nova Core Book");
    equal((await runtime.listCoreBookEntries(gm.id)).length,1,"runtime lists GM Core Book");
    equal((await runtime.getCoreBookEntry(nova.id,gmEntry.id)),undefined,"runtime enforces character scope");
    equal((await runtime.getCoreBookEntry(nova.id,novaEntry.id))?.content,"Nova is the default companion.","runtime reads scoped entry");

    await runtime.setCoreBookEntryEnabled(nova.id,novaEntry.id,false);
    equal((await runtime.getCoreBookEntry(nova.id,novaEntry.id))?.enabled,false,"runtime toggles enabled state");

    const reloaded=await startRuntime({characterStore,coreBookStore});
    try{
      equal((await reloaded.listCoreBookEntries(nova.id)).length,1,"Core Book survives runtime restart");
      equal((await reloaded.getCoreBookEntry(nova.id,novaEntry.id))?.enabled,false,"enabled state survives runtime restart");
      equal((await reloaded.listCoreBookEntries(gm.id))[0]?.content,"GM owns separate lore.","other Character data survives restart");
    }finally{await reloaded.stop()}
  }finally{await runtime.stop()}
  console.log("PASS Core Book runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
