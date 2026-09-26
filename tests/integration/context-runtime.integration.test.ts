import type {ContextBuildRequest} from "../../contracts/src";
import {InMemoryCharacterStore} from "../../host/characters/src";
import {InMemoryCoreBookStore} from "../../host/core-book/src";
import {InMemoryMemoryStore} from "../../host/memory/src";
import {createFoundationRuntime as startRuntime} from "../../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual));
}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const characterStore=new InMemoryCharacterStore();
  const coreBookStore=new InMemoryCoreBookStore();
  const memoryStore=new InMemoryMemoryStore();
  const runtime=await startRuntime({characterStore,coreBookStore,memoryStore});
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
    const novaMemory=await runtime.createMemory(nova.id,{
      id:"memory.context.nova.1",type:"preference",content:"Nova likes tea.",tags:["tea"],
      importance:95,confidence:90,source:"user",mutationPolicy:"locked"
    });
    const gmMemory=await runtime.createMemory(gm.id,{
      id:"memory.context.gm.1",type:"fact",content:"GM character tea note.",tags:["tea"],
      importance:100,confidence:100,source:"user",mutationPolicy:"locked"
    });
    const archivedMemory=await runtime.createMemory(nova.id,{
      id:"memory.context.archived",type:"fact",content:"Archived tea note.",tags:["tea"],
      importance:100,confidence:100,source:"user",mutationPolicy:"locked"
    });
    await runtime.archiveMemory(nova.id,archivedMemory.id);
    const supersededMemory=await runtime.createMemory(nova.id,{
      id:"memory.context.superseded",type:"fact",content:"Old Berlin note.",tags:["berlin"],
      importance:100,confidence:100,source:"user",mutationPolicy:"locked"
    });
    const replacementMemory=await runtime.supersedeMemory(nova.id,supersededMemory.id,{
      id:"memory.context.replacement",type:"fact",content:"Current Munich note.",tags:["berlin"],
      importance:90,confidence:95,source:"user",mutationPolicy:"locked"
    });


    const build:ContextBuildRequest={
      apiVersion:"1",schemaVersion:"1",characterId:nova.id,conversationId:"conversation-nova",
      messages:[
        {id:"u1",role:"user",content:"tea"},
        {id:"a1",role:"assistant",content:"Nova can help with that."}
      ],
      budget:{availableContextTokens:100,reservedOutputTokens:20,systemOverheadTokens:5,safetyMarginTokens:5}
    };
    const context=await runtime.buildContext(build);
    ok(context.includedCandidates.some(candidate=>candidate.referenceId===novaEntry.id),"Nova Core Book selected through runtime boundary");
    ok(context.includedCandidates.some(candidate=>candidate.referenceId===novaMemory.id),"Nova Dynamic Memory selected through existing MemoryBroker boundary");
    ok(!context.includedCandidates.some(candidate=>candidate.referenceId===gmMemory.id),"GM Dynamic Memory is isolated from Nova context");
    ok(!context.includedCandidates.some(candidate=>candidate.referenceId===archivedMemory.id),"archived memory is excluded from automatic context");
    ok(context.includedCandidates.some(candidate=>candidate.referenceId===replacementMemory.id),"active replacement memory is included");
    ok(!context.includedCandidates.some(candidate=>candidate.referenceId===supersededMemory.id),"superseded memory is excluded from automatic context");
    equal(context.messages.find(message=>message.content==="Nova likes jasmine tea.")?.metadata?.contextSource,"memory","assembled Memory provenance source");
    equal(context.messages.find(message=>message.content==="Nova likes jasmine tea.")?.metadata?.contextReferenceId,novaMemory.id,"assembled Memory provenance reference");
    equal(context.messages.find(message=>message.content==="Nova likes jasmine tea.")?.role,"user","memory remains data-role");
    ok(!context.includedCandidates.some(candidate=>candidate.content.includes("GM owns")),"GM Core Book is isolated");
    equal(context.characterId,nova.id,"runtime context remains character scoped");
    equal(context.conversationId,"conversation-nova","conversation identity preserved");
    equal(context.messages.find(message=>message.content==="Nova prefers tea.")?.metadata?.contextSource,"core_book","assembled Core Book provenance");
    equal(context.estimatedTokens<=context.budget.availableContextTokens,true,"runtime context honors budget");

    const noMatch=await runtime.buildContext({...build,messages:[{id:"u-no-memory",role:"user",content:"completely unrelated topic"}]});
    ok(!noMatch.includedCandidates.some(candidate=>candidate.source==="memory"),"no matching memory leaves normal context without memory candidates");

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
