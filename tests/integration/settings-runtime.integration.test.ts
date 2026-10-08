import {createFoundationRuntime} from "../../runtime/bootstrap/src";
import {StandardContractValidator,defaultAppSettings} from "../../contracts/src";
import {InMemorySettingsStore} from "../../host/settings/src";

function equal(actual:unknown,expected:unknown,label:string){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+String(expected)+" got "+String(actual))}
function ok(value:unknown,label:string){if(!value)throw new Error(label)}

async function main(){
  const store=new InMemorySettingsStore(new StandardContractValidator());
  const runtime=await createFoundationRuntime({settingsStore:store});
  await runtime.start();
  try{
    const initial=runtime.getSettings();
    equal(initial.context.recentConversationMessages,8,"runtime loads default recent message setting");
    equal(initial.memory.candidateLimit,8,"runtime loads default memory candidate setting");
    equal(initial.novaLife.cognition.maxModelCallsPerBurst,8,"runtime loads default cognition model-call budget");
    equal(initial.novaLife.cognition.maxToolCallsPerBurst,10,"runtime loads default cognition tool-call budget");

    const custom={
      ...initial,
      context:{...initial.context,recentConversationMessages:2,availableContextTokens:1024,reservedOutputTokens:256,safetyMarginTokens:32},
      memory:{...initial.memory,candidateLimit:1},
      retrieval:{...initial.retrieval,candidateLimit:5},
      chat:{...initial.chat,automaticLongTermMemory:false},
      novaLife:{...initial.novaLife,cognition:{...initial.novaLife.cognition,maxModelCallsPerBurst:4}}
    };
    await runtime.updateSettings(custom);
    equal(runtime.getSettings().context.recentConversationMessages,2,"runtime returns changed recent setting");
    equal(runtime.getSettings().memory.candidateLimit,1,"runtime returns changed memory setting");
    equal(runtime.getSettings().chat.automaticLongTermMemory,false,"runtime returns changed extraction toggle");
    equal(runtime.getSettings().novaLife.cognition.maxModelCallsPerBurst,4,"runtime returns changed cognition budget");

    const character=await runtime.getActiveCharacter();
    const conversation=await runtime.getActiveConversation(character.id);
    const messages=[
      {id:"m1",role:"user" as const,content:"one"},
      {id:"m2",role:"assistant" as const,content:"two"},
      {id:"m3",role:"user" as const,content:"three"},
      {id:"m4",role:"assistant" as const,content:"four"},
      {id:"m5",role:"user" as const,content:"tea preference"}
    ];
    await runtime.createMemory(character.id,{id:"memory-1",conversationId:conversation.id,type:"preference",content:"tea preference one",tags:["tea"],importance:90,confidence:90,source:"user",mutationPolicy:"locked"});
    await runtime.createMemory(character.id,{id:"memory-2",conversationId:conversation.id,type:"preference",content:"tea preference two",tags:["tea"],importance:80,confidence:90,source:"user",mutationPolicy:"locked"});
    const assembled=await runtime.buildContext({
      apiVersion:"1",schemaVersion:"1",characterId:character.id,conversationId:conversation.id,
      messages,budget:{availableContextTokens:1024,reservedOutputTokens:256,systemOverheadTokens:0,safetyMarginTokens:32}
    });
    const recent=assembled.includedCandidates.filter(candidate=>candidate.source==="conversation"&&candidate.zone==="recent_conversation");
    equal(recent.length,2,"context engine uses runtime recent message setting");
    const memories=assembled.includedCandidates.filter(candidate=>candidate.source==="memory");
    equal(memories.length,1,"context engine uses runtime memory candidate limit");

    const persisted=await createFoundationRuntime({settingsStore:store});
    equal(persisted.getSettings().context.recentConversationMessages,2,"settings survive runtime restart");
    equal(persisted.getSettings().memory.candidateLimit,1,"memory limit survives runtime restart");
    await persisted.stop();
    await runtime.resetSettings();
    equal(runtime.getSettings(),defaultAppSettings(),"runtime reset returns canonical defaults");
    ok(true,"settings runtime integration completed");
  }finally{
    await runtime.stop();
  }
  console.log("PASS Settings runtime integration tests");
}
void main().catch(error=>{console.error(error);process.exitCode=1});
