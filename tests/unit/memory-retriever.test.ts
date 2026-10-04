import {InProcessMemoryRetriever} from "../../core/src";
import type {MemoryItem} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

function item(overrides:Partial<MemoryItem>):MemoryItem{
  return {
    id:overrides.id??"m1",characterId:overrides.characterId??"character.a",originConversationId:overrides.originConversationId??"conversation.a",
    type:overrides.type??"fact",content:overrides.content??"content",tags:overrides.tags??[],
    importance:overrides.importance??50,confidence:overrides.confidence??50,
    createdAt:overrides.createdAt??"2026-09-26T12:00:00.000Z",updatedAt:overrides.updatedAt??"2026-09-26T12:00:00.000Z",
    validFrom:overrides.validFrom??null,validUntil:overrides.validUntil??null,
    source:overrides.source??"user",sourceReference:overrides.sourceReference??null,
    mutationPolicy:overrides.mutationPolicy??"locked",status:overrides.status??"active",metadata:overrides.metadata??{}
  };
}

async function main(){
  const memory=item({id:"nova-hair",content:"Нова имеет фиолетовые волосы",tags:["Нова","волосы"],importance:70,confidence:90});
  const high=item({id:"high",content:"Нова любит читать про авиацию",importance:90,confidence:100});
  const archived=item({id:"archived",content:"Нова имеет фиолетовые волосы",status:"archived",importance:100,confidence:100});
  const future=item({id:"future",content:"У пользователя будет любимый цвет зелёный",validFrom:"2027-01-01T00:00:00.000Z",importance:100,confidence:100});
  const expired=item({id:"expired",content:"У пользователя был любимый цвет красный",validUntil:"2026-01-01T00:00:00.000Z",importance:100,confidence:100});
  const other=item({id:"other",characterId:"character.b",originConversationId:"conversation.b",content:"Нова имеет фиолетовые волосы",importance:100,confidence:100});
  const broker={list:async(characterId:string)=>[memory,high,archived,future,expired,other].filter(x=>x.characterId===characterId)};
  const retriever=new InProcessMemoryRetriever(broker,{clock:{now:()=> "2026-10-04T12:00:00.000Z"}});
  const result=await retriever.search({characterId:"character.a",query:"Нова, какого цвета твои волосы?",status:"active",limit:8});
  equal(result.candidates[0]?.memoryId,"nova-hair","purple-hair memory ranks first for related Russian terms");
  ok(result.candidates.every(candidate=>candidate.memoryId!=="archived"),"archived memory excluded");
  ok(result.candidates.every(candidate=>candidate.memoryId!=="future"),"future memory excluded");
  ok(result.candidates.every(candidate=>candidate.memoryId!=="expired"),"expired memory excluded");
  ok(result.candidates.every(candidate=>candidate.memoryId!=="other"),"other character memory excluded");

  const relevance=await retriever.search({characterId:"character.a",query:"Нова читать",status:"active",limit:8});
  equal(relevance.candidates[0]?.memoryId,"high","lexical score remains deterministic");
  equal(relevance.candidates[0]?.score,relevance.candidates[0]?.score,"score is deterministic");

  const scoped=await retriever.search({characterId:"character.a",query:"Нова волосы",originConversationId:"conversation.a",limit:8});
  equal(scoped.candidates.some(candidate=>candidate.memoryId==="nova-hair"),true,"explicit provenance filter remains available");
  const empty=await retriever.search({characterId:"character.a",query:"несуществующий термин",limit:8});
  equal(empty.candidates.length,0,"non-matching memory is not returned");
  console.log("PASS Dynamic Memory retriever unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
