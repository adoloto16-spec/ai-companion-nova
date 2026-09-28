import {InMemoryConversationStore} from "../../host/conversations/src";
import {StandardContractValidator,STANDARD_SCHEMAS} from "../../contracts/src";
import type {Conversation} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

const nova:Conversation={
  apiVersion:"1",schemaVersion:"1",id:"conversation:character.nova.default.v1:default.v1",characterId:"character.nova.default.v1",
  messages:[
    {id:"u1",role:"user",content:"hello Nova"},
    {id:"a1",role:"assistant",content:"hello from Nova"}
  ],
  createdAt:"2026-09-28T10:00:00.000Z",updatedAt:"2026-09-28T10:00:01.000Z"
};

async function main(){
  const validator=new StandardContractValidator();
  equal(validator.validate(nova,STANDARD_SCHEMAS["conversation"]!).valid,true,"conversation schema accepts canonical state");
  equal(validator.validate({...nova,characterId:""} as never,STANDARD_SCHEMAS["conversation"]!).valid,false,"conversation schema rejects empty character scope");
  equal(validator.validate({...nova,messages:[{role:"invalid",content:"x"}]} as never,STANDARD_SCHEMAS["conversation"]!).valid,false,"conversation schema rejects invalid message role");

  const store=new InMemoryConversationStore();
  equal(await store.load(nova.characterId),undefined,"fresh store has no conversation");
  await store.save(nova);
  const loaded=await store.load(nova.characterId);
  ok(loaded,"saved conversation reloads");
  equal(loaded?.id,nova.id,"conversation id remains stable");
  equal(loaded?.characterId,nova.characterId,"conversation character scope is stable");
  equal(loaded?.messages.map(message=>message.content).join("|"),"hello Nova|hello from Nova","messages round-trip");

  equal((await store.load(nova.characterId))?.messages[0]?.content,"hello Nova","store isolates caller message mutation");

  await store.save({
    ...nova,
    id:"conversation:character.gm.default.v1:default.v1",
    characterId:"character.gm.default.v1",
    messages:[{id:"gm1",role:"user",content:"hello GM"}]
  });
  equal((await store.load("character.nova.default.v1"))?.messages[0]?.content,"hello Nova","Nova remains isolated from GM");
  equal((await store.load("character.gm.default.v1"))?.messages[0]?.content,"hello GM","GM has separate conversation");

  await store.clear("character.gm.default.v1");
  equal(await store.load("character.gm.default.v1"),undefined,"clear removes only requested Character conversation");
  ok(await store.load("character.nova.default.v1"),"clear does not remove Nova conversation");
  console.log("PASS conversation store unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
