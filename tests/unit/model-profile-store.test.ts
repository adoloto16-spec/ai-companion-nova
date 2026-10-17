import {InMemoryModelProfileStore} from "../../host/model-profiles/src";
import {StandardContractValidator,STANDARD_SCHEMAS,defaultModelProfile} from "../../contracts/src";
import type {ModelProfile} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

const nova=():ModelProfile=>({
  ...defaultModelProfile("character.nova.default.v1","2026-09-28T10:00:00.000Z"),
  providerId:"fake.chat",
  providerPresetId:"provider-preset:main:1",
  model:"nova-model",
  generation:{temperature:0.7,topP:0.9,maxTokens:256,repeatPenalty:1.15,repeatLastN:-1}
});

async function main(){
  const validator=new StandardContractValidator();
  const profile=nova();
  equal(validator.validate(profile,STANDARD_SCHEMAS["model-profile"]!).valid,true,"canonical model profile validates");
  equal(validator.validate({...profile,generation:{...profile.generation,repeatPenalty:0}},STANDARD_SCHEMAS["model-profile"]!).valid,false,"model profile rejects a non-positive repeat penalty");
  equal(validator.validate({...profile,generation:{...profile.generation,repeatLastN:-2}},STANDARD_SCHEMAS["model-profile"]!).valid,false,"model profile rejects repeat windows below -1");
  equal(validator.validate({...profile,characterId:"",providerId:""} as never,STANDARD_SCHEMAS["model-profile"]!).valid,false,"invalid model profile is rejected");

  const store=new InMemoryModelProfileStore();
  equal(await store.load(profile.characterId),undefined,"fresh character has logical default without physical storage");
  await store.save(profile);
  equal((await store.load(profile.characterId))?.model,"nova-model","saved model profile reloads");
  equal((await store.load(profile.characterId))?.providerPresetId,"provider-preset:main:1","saved model profile preserves pinned provider preset");
  equal((await store.load(profile.characterId))?.generation.repeatPenalty,1.15,"saved model profile preserves repeatPenalty");
  equal((await store.load(profile.characterId))?.generation.repeatLastN,-1,"saved model profile preserves repeatLastN");

  const gm={...defaultModelProfile("character.gm.v1","2026-09-28T10:00:00.000Z"),model:"gm-model",generation:{temperature:1.1}};
  await store.save(gm);
  equal((await store.load(profile.characterId))?.model,"nova-model","Nova profile is isolated");
  equal((await store.load(gm.characterId))?.model,"gm-model","GM profile is isolated");

  await store.delete(gm.characterId);
  equal(await store.load(gm.characterId),undefined,"deleted Character profile no longer applies");
  ok(await store.load(profile.characterId),"deleting GM profile does not delete Nova profile");
  console.log("PASS model profile store unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
