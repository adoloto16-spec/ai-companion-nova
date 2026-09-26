import type {ContextBuildRequest} from "../../contracts/src";
import {InMemoryCharacterStore,InMemoryCoreBookStore} from "../../core/src";
import {createFoundationRuntime as startRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const coreBookStore=new InMemoryCoreBookStore();
  const runtime=await startRuntime({characterStore,coreBookStore});
  await runtime.start();
  try{
    const nova=await runtime.getActiveCharacter();
    const gm=await runtime.createCharacter({name:"GM"});
    const novaEntry=await runtime.createCoreBookEntry(nova.id,{
      title:"Nova canon",content:"Nova prefers tea.",activation:{kind:"keyword",keywords:["tea"],matchMode:"any",caseSensitive:false},
      retentionPriority:90,placementWeight:20,source:"user"
    });
    await runtime.createCoreBookEntry(gm.id,{
      title:"GM canon",content:"GM owns separate lore.",activation:{kind:"always"},
      retentionPriority:100,placementWeight:100,source:"user"
    });

    const build:ContextBuildRequest={
      apiVersion:"1",schemaVersion:"1",characterId:nova.id,conversationId:"conversation-nova",
      messages:[
        {id:"u1",role:"user",content:"I would like some tea."},
        {id:"a1",role:"assistant",content:"Nova can help with that."}
      ],
      budget:{availableContextTokens:100,reservedOutputTokens:20,systemOverheadTokens:5,safetyMarginTokens:5}
    };
    const context=await runtime.buildContext(build);
    ok(context.includedCandidates.some(candidate=>candidate.referenceId===novaEntry.id),"Nova Core Book selected through runtime boundary");
    ok(!context.includedCandidates.some(candidate=>candidate.content.includes("GM owns")),"GM Core Book is isolated");
    equal(context.characterId,nova.id,"runtime context remains character scoped");
    equal(context.conversationId,"conversation-nova","conversation identity preserved");
    equal(context.messages.find(message=>message.content==="Nova prefers tea.")?.metadata?.contextSource,"core_book","assembled Core Book provenance");
    equal(context.estimatedTokens<=context.budget.availableContextTokens,true,"runtime context honors budget");

    const disabled=await runtime.setCoreBookEntryEnabled(nova.id,novaEntry.id,false);
    ok(!disabled.enabled,"Nova entry disabled");
    const disabledContext=await runtime.buildContext(build);
    ok(!disabledContext.includedCandidates.some(candidate=>candidate.referenceId===novaEntry.id),"disabled Core Book omitted from runtime context");

    const reloaded=await startRuntime({characterStore,coreBookStore});
    await reloaded.start();
    try{
      const reloadedContext=await reloaded.buildContext({...build,messages:[{id:"u2",role:"user",content:"tea"}]});
      ok(!reloadedContext.includedCandidates.some(candidate=>candidate.referenceId===novaEntry.id),"disabled state survives runtime restart");
    }finally{await reloaded.stop()}
  }finally{await runtime.stop()}
  console.log("PASS Context Engine runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
