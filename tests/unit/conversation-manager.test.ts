import {ConversationManager} from "../../core/src";
import {InMemoryConversationStore} from "../../host/conversations/src";
import type {CharacterId} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const characters=new Set<CharacterId>(["character.nova","character.gm"]);
  let sequence=0;
  const manager=new ConversationManager(new InMemoryConversationStore(),{
    characterExists:async id=>characters.has(id),
    idFactory:characterId=>"conversation:"+characterId+":created-"+(++sequence)
  });

  const main=await manager.getActiveConversation("character.nova");
  equal(main.id,"conversation:character.nova:default.v2","fresh character gets deterministic default");
  equal(main.title,"Main","default title");

  const a=await manager.createConversation("character.nova",{title:"A"});
  const b=await manager.createConversation("character.nova",{title:"B"});
  equal((await manager.listConversations("character.nova")).length,3,"create supports multiple conversations");
  equal((await manager.getActiveConversation("character.nova")).id,b.id,"created conversation becomes active");

  await manager.setActiveConversation("character.nova",a.id);
  equal((await manager.getActiveConversation("character.nova")).id,a.id,"setActive selects scoped conversation");
  const renamed=await manager.updateConversation("character.nova",a.id,{title:"A renamed",messages:[{id:"u",role:"user",content:"only A"}]});
  equal(renamed.title,"A renamed","update changes title");
  equal(renamed.messages[0]?.content,"only A","update changes messages");

  const gm=await manager.createConversation("character.gm",{title:"GM"});
  let scopeRejected=false;
  try{await manager.getConversation("character.nova",gm.id)}catch(error){scopeRejected=String(error).includes("scope mismatch")||String(error).includes("not found")}
  ok(scopeRejected,"cross-character get is blocked");
  scopeRejected=false;
  try{await manager.updateConversation("character.nova",gm.id,{title:"hack"})}catch(error){scopeRejected=String(error).includes("scope mismatch")||String(error).includes("not found")}
  ok(scopeRejected,"cross-character update is blocked");
  scopeRejected=false;
  try{await manager.deleteConversation("character.nova",gm.id)}catch(error){scopeRejected=String(error).includes("scope mismatch")||String(error).includes("not found")}
  ok(scopeRejected,"cross-character delete is blocked");
  scopeRejected=false;
  try{await manager.setActiveConversation("character.nova",gm.id)}catch(error){scopeRejected=String(error).includes("scope mismatch")||String(error).includes("not found")}
  ok(scopeRejected,"cross-character activate is blocked");

  await manager.deleteConversation("character.nova",b.id);
  equal((await manager.getActiveConversation("character.nova")).id,a.id,"deleting inactive conversation preserves active conversation");
  const only=await manager.listConversations("character.gm");
  equal(only.length,2,"GM keeps its own default plus created conversation");

  await manager.deleteConversation("character.nova",a.id);
  equal((await manager.getActiveConversation("character.nova")).id,main.id,"deleting active selects remaining default");
  await manager.deleteConversation("character.nova",main.id);
  const replacement=await manager.getActiveConversation("character.nova");
  equal(replacement.id,"conversation:character.nova:default.v2","deleting last conversation restores deterministic default");
  equal(replacement.messages.length,0,"replacement default is empty");

  const firstList=await manager.listConversations("character.nova");
  const secondList=await manager.listConversations("character.nova");
  equal(firstList.map(item=>item.id),secondList.map(item=>item.id),"conversation ordering is stable");
  console.log("PASS ConversationManager v2 lifecycle/isolation unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
