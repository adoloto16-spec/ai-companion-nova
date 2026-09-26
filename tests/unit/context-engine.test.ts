import {
  CoreBookCandidateSource,
  DeterministicApproxTokenEstimator,
  DeterministicContextEngine,
  ConversationCandidateSource,
  calculateContextBudget
} from "../../core/src";
import type {ContextBuildRequest,CoreBookEntry} from "../../contracts/src";
import type {TokenEstimator} from "../../core/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

function entry(overrides:Partial<CoreBookEntry>):CoreBookEntry{
  const id=overrides.id??"core-book.test";
  const characterId=overrides.characterId??"character.a";
  return {
    id,characterId,title:overrides.title??id,content:overrides.content??"lore content",
    tags:overrides.tags??[],
    activation:overrides.activation??{kind:"always"},
    retentionPriority:overrides.retentionPriority??50,
    placementWeight:overrides.placementWeight??50,
    mutationPolicy:overrides.mutationPolicy??"locked",
    enabled:overrides.enabled??true,
    source:overrides.source??"user",
    metadata:overrides.metadata??{},
    createdAt:overrides.createdAt??"2026-09-26T12:00:00.000Z",
    updatedAt:overrides.updatedAt??"2026-09-26T12:00:00.000Z"
  };
}

function request(overrides:Partial<ContextBuildRequest>):ContextBuildRequest{
  return {
    apiVersion:"1",schemaVersion:"1",characterId:"character.a",conversationId:"conversation.a",
    messages:[],budget:{availableContextTokens:100,reservedOutputTokens:10,systemOverheadTokens:5,safetyMarginTokens:5},
    ...overrides
  };
}

async function main(){
  const budget=calculateContextBudget(100,10,5,5);
  equal(budget.availableContextTokens,80,"budget calculation");
  let invalidBudget=false;
  try{calculateContextBudget(10,6,5,1);}catch{invalidBudget=true}
  ok(invalidBudget,"negative calculated budget rejected");

  const estimator=new DeterministicApproxTokenEstimator();
  equal(estimator.estimate("12345678"),2,"approx estimator deterministic");
  equal(estimator.estimate("12345678"),2,"same text has same estimate");

  const aEntries=[
    entry({id:"always",content:"Nova identity",activation:{kind:"always"},retentionPriority:90,placementWeight:10}),
    entry({id:"keyword-any",content:"Alpha canon",activation:{kind:"keyword",keywords:["alpha","missing"],matchMode:"any",caseSensitive:false},retentionPriority:80}),
    entry({id:"keyword-all",content:"Alpha Beta canon",activation:{kind:"keyword",keywords:["alpha","beta"],matchMode:"all",caseSensitive:false},retentionPriority:70}),
    entry({id:"keyword-case",content:"Alpha case",activation:{kind:"keyword",keywords:["ALPHA"],matchMode:"any",caseSensitive:true},retentionPriority:60}),
    entry({id:"regex",content:"regex canon",activation:{kind:"regex",pattern:"\\bAlpha\\b",flags:"i"},retentionPriority:60}),
    entry({id:"disabled",content:"disabled canon",activation:{kind:"always"},enabled:false}),
    entry({id:"semantic",content:"future semantic",activation:{kind:"semantic"}}),
    entry({id:"model-search",content:"future model",activation:{kind:"model_search"}}),
    entry({id:"invalid-regex",content:"broken regex",activation:{kind:"regex",pattern:"[",flags:""}}),
    entry({id:"other-character",characterId:"character.b",content:"other data",activation:{kind:"always"},retentionPriority:100})
  ];
  const reader={async listCoreBookEntries(characterId:string){
    return aEntries.filter(item=>item.characterId===characterId||item.id==="other-character");
  }};
  const source=new CoreBookCandidateSource(reader);
  const built=await new DeterministicContextEngine([
    new ConversationCandidateSource(({
      estimate(text:string){return Math.max(1,text.length);}
    }) as TokenEstimator),
    source
  ]).build(request({
    messages:[
      {id:"m1",role:"user",content:"alpha"},
      {id:"m2",role:"assistant",content:"beta"},
      {id:"m3",role:"user",content:"latest"}
    ],
    budget:{availableContextTokens:200,reservedOutputTokens:0,systemOverheadTokens:0,safetyMarginTokens:0}
  }));
  const byId=new Map(built.omittedCandidates.concat(built.includedCandidates).map(candidate=>[candidate.referenceId,candidate]));
  ok(byId.get("always")?.eligible,"always eligible");
  ok(byId.get("keyword-any")?.eligible,"keyword any eligible");
  ok(byId.get("keyword-all")?.eligible,"keyword all eligible");
  ok(!byId.get("keyword-case")?.eligible,"case-sensitive keyword mismatch");
  ok(byId.get("regex")?.eligible,"regex eligible");
  ok(!byId.get("disabled")?.eligible,"disabled entry ineligible");
  ok(!byId.get("semantic")?.eligible,"semantic reserved");
  ok(!byId.get("model-search")?.eligible,"model_search reserved");
  ok(!byId.get("invalid-regex")?.eligible,"invalid regex safely rejected");
  ok(!byId.get("other-character")?.eligible,"cross-character Core Book rejected");
  ok(built.includedCandidates.every(candidate=>candidate.characterId==="character.a"),"no cross-character candidates included");
  ok(built.includedCandidates.every(candidate=>candidate.source==="core_book"?candidate.role==="user":true),"Core Book remains data-role, not system instruction");
  equal(built.messages.find(message=>message.content==="Nova identity")?.metadata?.contextSource,"core_book","provenance source preserved");
  equal(built.messages.find(message=>message.content==="Nova identity")?.metadata?.contextReferenceId,"always","provenance reference preserved");

  const highVsLow=[
    entry({id:"low-placement",content:"x",placementWeight:5,retentionPriority:50}),
    entry({id:"high-placement",content:"y",placementWeight:95,retentionPriority:50})
  ];
  const source2=new CoreBookCandidateSource({async listCoreBookEntries(){return highVsLow;}});
  const pressureEngine=new DeterministicContextEngine([source2],{});
  const pressure=await pressureEngine.build(request({
    messages:[],
    budget:{availableContextTokens:1,reservedOutputTokens:0,systemOverheadTokens:0,safetyMarginTokens:0}
  }));
  equal(pressure.includedCandidates.length,1,"one candidate fits pressure budget");
  equal(pressure.includedCandidates[0]?.referenceId,"low-placement","placementWeight does not affect selection");

  const placement=await pressureEngine.build(request({
    messages:[],
    budget:{availableContextTokens:2,reservedOutputTokens:0,systemOverheadTokens:0,safetyMarginTokens:0}
  }));
  equal(placement.includedCandidates.map(item=>item.referenceId),["high-placement","low-placement"],"placementWeight affects placement only");

  const manyMessages=Array.from({length:10},(_,index)=>({id:"m"+index,role:(index%2===0?"user":"assistant") as "user"|"assistant",content:"turn"+index}));
  const recentEngine=new DeterministicContextEngine([
    new ConversationCandidateSource(({estimate(text:string){return text.length;}} as TokenEstimator)),
    new CoreBookCandidateSource({async listCoreBookEntries(){return [entry({id:"core-heavy",content:"123456789",retentionPriority:100})]}})
  ]);
  const pressured=await recentEngine.build(request({
    messages:manyMessages,
    budget:{availableContextTokens:5,reservedOutputTokens:0,systemOverheadTokens:0,safetyMarginTokens:0}
  }));
  ok(pressured.includedCandidates.some(candidate=>candidate.referenceId==="m9"),"latest conversation turn preserved");
  ok(!pressured.includedCandidates.some(candidate=>candidate.referenceId==="m0"),"older conversation may be removed");
  equal(pressured.estimatedTokens<=5,true,"assembly stays within budget");
  ok(pressured.omittedCandidates.some(candidate=>candidate.referenceId==="core-heavy"),"context pressure explains omitted Core Book");

  const noBudget=await recentEngine.build(request({
    messages:[{id:"m1",role:"user",content:"hello"}],
    budget:{availableContextTokens:0,reservedOutputTokens:0,systemOverheadTokens:0,safetyMarginTokens:0}
  }));
  equal(noBudget.includedCandidates.length,0,"insufficient budget omits candidates");
  ok(noBudget.omittedCandidates.length>0,"insufficient budget is explainable");

  console.log("PASS Context Engine unit tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
