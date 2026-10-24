import {
  APP_SETTINGS_SCHEMA_VERSION,DEFAULT_PROMPT_PRESET,DEFAULT_PROMPT_TEXTS,PROMPT_REGISTRY,StandardContractValidator,assemblePromptInstructions,bumpChangedPromptPresetVersions,clonePromptConfiguration,createDefaultPromptPreset,
  applyPromptOverride,defaultAppSettings,migrateAppSettings,resolvePromptText,restoreAllPromptDefaults,
  restorePromptDefault,validateAppSettings
} from "../../contracts/src";
import type {AppSettings} from "../../contracts/src";
import {SettingsManager} from "../../core/src";
import {InMemorySettingsStore} from "../../host/settings/src";

function equal(actual:unknown,expected:unknown,label:string):void{
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));
}
function ok(value:unknown,label:string):void{if(!value)throw new Error(label);}
async function main():Promise<void>{
  const ids=PROMPT_REGISTRY.map(prompt=>prompt.id);
  equal(ids.length,14,"complete registry contains all discovered editable prompt templates");
  equal([...ids].sort(),Object.keys(DEFAULT_PROMPT_TEXTS).sort(),"each registry item has one immutable factory default");
  ok(Object.isFrozen(DEFAULT_PROMPT_TEXTS),"factory prompt definitions are runtime-frozen");
  for(const prompt of PROMPT_REGISTRY){
    ok(prompt.title.length>0&&prompt.purpose.length>0&&prompt.defaultText.length>0,"registry entries include human-readable metadata and full default text: "+prompt.id);
    equal(resolvePromptText(undefined,prompt.id),prompt.defaultText,"unconfigured prompt resolves to factory default: "+prompt.id);
  }
  const nativePlain=DEFAULT_PROMPT_TEXTS["nova-system-plain"];
  ok(!nativePlain.includes("memory.save")&&!nativePlain.includes("NOVA_TURN")&&!nativePlain.includes("nextWakeMs")&&!nativePlain.includes("longMemory"),"native plain runtime prompt does not require legacy memory tools or tagged/JSON response fields");
  ok(nativePlain.includes("separate background Memory Agent"),"native plain runtime routes durable-memory decisions to the separate agent");
  const validator=new StandardContractValidator();
  const store=new InMemorySettingsStore(validator);
  const manager=new SettingsManager(store,validator);
  const initial=await manager.initialize();
  equal(initial.schemaVersion,APP_SETTINGS_SCHEMA_VERSION,"settings manager initializes current schema");
  const reactive=assemblePromptInstructions(initial.prompts,"nova","reactive");
  ok(reactive.included.some(prompt=>prompt.id==="nova-cue-reactive-plain"),"reactive scenario includes its assigned cue");
  ok(!reactive.included.some(prompt=>prompt.id==="nova-cue-background-plain"),"reactive scenario excludes the background cue");
  ok(!reactive.included.some(prompt=>prompt.id==="nova-system-json"||prompt.id==="nova-system-tagged"),"native Nova request excludes disabled legacy response protocols");
  equal(reactive.text,reactive.included.map(prompt=>prompt.text).join("\n\n"),"runtime instruction text exactly matches ordered prompt records");
  const phaseConfiguration=clonePromptConfiguration(initial.prompts);
  phaseConfiguration.presets.find(preset=>preset.id==="default")!.prompts.push({
    id:"diagnostic-after-tool",title:"After-tool instruction",text:"AFTER_TOOL_ONLY",agentId:"nova",enabled:true,order:500,
    conditions:{scenarios:["after-tool"]}
  });
  const afterTool=assemblePromptInstructions(phaseConfiguration,"nova","reactive+after-tool");
  ok(afterTool.included.some(prompt=>prompt.id==="diagnostic-after-tool"),"after-tool conditions match composite runtime phases");
  ok(afterTool.included.some(prompt=>prompt.id==="nova-cue-reactive-plain"),"after-tool phase retains the reactive cue for the original user turn");
  ok(!afterTool.included.some(prompt=>prompt.id==="nova-cue-background-plain"),"reactive after-tool phase does not include the background cue");
  const presetVersionDraft=clonePromptConfiguration(initial.prompts);
  presetVersionDraft.presets.find(preset=>preset.id==="default")!.prompts.find(prompt=>prompt.id==="nova-system-plain")!.text+=" revised";
  const versioned= bumpChangedPromptPresetVersions(initial.prompts,presetVersionDraft);
  equal(versioned.presets.find(preset=>preset.id==="default")!.version,initial.prompts.presets.find(preset=>preset.id==="default")!.version+1,"saving changed preset content advances its revision once");
  const unchangedVersions=bumpChangedPromptPresetVersions(initial.prompts,clonePromptConfiguration(initial.prompts));
  equal(unchangedVersions.presets.find(preset=>preset.id==="default")!.version,initial.prompts.presets.find(preset=>preset.id==="default")!.version,"saving an unchanged preset does not advance its revision");
  const memoryStructured=assemblePromptInstructions(initial.prompts,"memory-agent","structured");
  ok(memoryStructured.included.some(prompt=>prompt.id==="memory-agent-safety"),"Memory Agent safety guidance is visible as a preset record");
  ok(memoryStructured.included.some(prompt=>prompt.id==="memory-agent-output-structured"),"Memory Agent structured protocol is assembled from preset records");
  ok(!memoryStructured.included.some(prompt=>prompt.id==="memory-agent-output-plain"),"Memory Agent excludes plain protocol on structured calls");
  ok(DEFAULT_PROMPT_PRESET.prompts.some(prompt=>prompt.id==="memory-judge-output-plain"),"reference Default retains the editable plain Judge protocol");

  let custom=applyPromptOverride(initial,"nova-system-json","CUSTOM JSON SYSTEM");
  custom=applyPromptOverride(custom,"nova-cue-reactive-tagged","CUSTOM REACTIVE TAG CUE");
  custom=applyPromptOverride(custom,"memory-judge.system","CUSTOM JUDGE SYSTEM");
  custom=applyPromptOverride(custom,"memory-agent.system","CUSTOM MEMORY AGENT SYSTEM");
  custom={
    ...custom,
    context:{...custom.context,availableContextTokens:8192},
    semanticDedup:{
      ...custom.semanticDedup,embeddingProviderPresetId:"preset.embedding",embeddingModel:"embed-v2",
      judge:{...custom.semanticDedup.judge,providerPresetId:"preset.judge",model:"judge-v2",outputMode:"plain"}
    }
  };
  equal(validateAppSettings(custom),[],"valid prompt overrides and existing settings pass validation");
  await manager.set(custom);
  const restartedManager=new SettingsManager(store,validator);
  const restarted=await restartedManager.initialize();
  equal(resolvePromptText(restarted.prompts,"nova-system-json"),"CUSTOM JSON SYSTEM","override survives settings-store restart");
  equal(resolvePromptText(restarted.prompts,"nova-cue-reactive-tagged"),"CUSTOM REACTIVE TAG CUE","each prompt override persists independently");
  equal(resolvePromptText(restarted.prompts,"memory-judge.system"),"CUSTOM JUDGE SYSTEM","Memory Judge override survives restart");
  equal(resolvePromptText(restarted.prompts,"memory-agent.system"),"CUSTOM MEMORY AGENT SYSTEM","Automatic Memory Agent prompt survives restart");
  equal(restarted.memoryAgent.prompt,"CUSTOM MEMORY AGENT SYSTEM","legacy agent prompt stays synchronized with the registry");
  equal(restarted.semanticDedup.judge.prompt,"CUSTOM JUDGE SYSTEM","legacy Memory Judge prompt field stays synchronized");
  equal(restarted.context.availableContextTokens,8192,"unrelated context settings survive prompt edits");
  equal(restarted.semanticDedup.embeddingProviderPresetId,"preset.embedding","embedding preset survives prompt edits");
  equal(restarted.semanticDedup.embeddingModel,"embed-v2","embedding model survives prompt edits");
  equal(restarted.semanticDedup.judge.providerPresetId,"preset.judge","Judge provider preset survives prompt edits");
  equal(restarted.semanticDedup.judge.model,"judge-v2","Judge model survives prompt edits");
  equal(restarted.semanticDedup.judge.outputMode,"plain","Judge output mode survives prompt edits");

  const singleRestored=restorePromptDefault(restarted,"nova-system-json");
  await restartedManager.set(singleRestored);
  const afterSingleRestore=new SettingsManager(store,validator);
  const single=await afterSingleRestore.initialize();
  equal(Object.prototype.hasOwnProperty.call(single.prompts.overrides,"nova-system-json"),false,"single reset deletes only that override");
  equal(resolvePromptText(single.prompts,"nova-system-json"),DEFAULT_PROMPT_TEXTS["nova-system-json"],"single reset takes effect immediately");
  equal(resolvePromptText(single.prompts,"memory-judge.system"),"CUSTOM JUDGE SYSTEM","single reset preserves other prompt overrides");

  const modified=applyPromptOverride(single,"nova-system-plain","CUSTOM PLAIN SYSTEM");
  await afterSingleRestore.set(modified);
  const resetAll=restoreAllPromptDefaults(afterSingleRestore.get());
  equal(Object.keys(resetAll.prompts.overrides),[],"restore-all clears all prompt overrides");
  equal(resetAll.semanticDedup.judge.prompt,DEFAULT_PROMPT_TEXTS["memory-judge.system"],"restore-all resets compatibility Judge prompt field");
  equal(resetAll.memoryAgent.prompt,DEFAULT_PROMPT_TEXTS["memory-agent.system"],"restore-all resets compatibility Memory Agent prompt field");
  await afterSingleRestore.set(resetAll);
  const finalReload=new SettingsManager(store,validator);
  const finalSettings=await finalReload.initialize();
  equal(finalSettings.prompts.overrides,{},"restore-all persists after restart");
  for(const prompt of PROMPT_REGISTRY)equal(resolvePromptText(finalSettings.prompts,prompt.id),prompt.defaultText,"factory fallback after restore-all: "+prompt.id);
  equal(finalSettings.context.availableContextTokens,8192,"restore-all does not reset unrelated settings");
  equal(finalSettings.semanticDedup.judge.model,"judge-v2","restore-all preserves the selected Judge model and preset");
  equal(finalSettings.semanticDedup.judge.providerPresetId,"preset.judge","restore-all preserves Judge provider preset");

  const blank=applyPromptOverride(finalSettings,"nova-system-json","  \n ");
  equal(blank.prompts.overrides["nova-system-json"],undefined,"blank prompt text does not create an empty override");
  equal(resolvePromptText(blank.prompts,"nova-system-json"),DEFAULT_PROMPT_TEXTS["nova-system-json"],"blank override cannot erase the factory value");

  const legacy=JSON.parse(JSON.stringify(initial)) as Record<string,any>;
  legacy.schemaVersion="11";
  delete legacy.prompts;
  legacy.semanticDedup.judge.prompt="Legacy user-authored Judge prompt";
  legacy.memoryAgent.prompt="Legacy custom Automatic Memory Agent prompt";
  legacy.semanticDedup.judge.providerPresetId="legacy-judge-preset";
  legacy.semanticDedup.judge.model="legacy-judge-model";
  legacy.semanticDedup.embeddingProviderPresetId="legacy-embedding-preset";
  legacy.semanticDedup.embeddingModel="legacy-embedding-model";
  legacy.context.availableContextTokens=6144;
  const migrated=migrateAppSettings(legacy);
  equal(migrated.schemaVersion,"15","previous AppSettings version migrates to the current v15 schema");
  equal(migrated.prompts.overrides["memory-judge.system"],"Legacy user-authored Judge prompt","migration promotes custom Judge text into the central registry");
  equal(migrated.prompts.overrides["memory-agent.system"],"Legacy custom Automatic Memory Agent prompt","migration preserves old agent prompt in the editable registry");
  equal(migrated.memoryAgent.prompt,"Legacy custom Automatic Memory Agent prompt","migration keeps legacy agent prompt setting compatible");
  equal(migrated.semanticDedup.judge.prompt,"Legacy user-authored Judge prompt","migration preserves prior custom Judge prompt");
  equal(migrated.semanticDedup.judge.providerPresetId,"legacy-judge-preset","migration preserves Judge provider selection");
  equal(migrated.semanticDedup.judge.model,"legacy-judge-model","migration preserves Judge model selection");
  equal(migrated.semanticDedup.embeddingProviderPresetId,"legacy-embedding-preset","migration preserves embedding provider preset");
  equal(migrated.semanticDedup.embeddingModel,"legacy-embedding-model","migration preserves embedding model");
  equal(migrated.context.availableContextTokens,6144,"migration preserves unrelated context settings");
  const legacyDefault=migrated.prompts.presets.find(preset=>preset.id==="default");
  equal(legacyDefault?.prompts.find(prompt=>prompt.legacyId==="memory-agent.system")?.text,"Legacy custom Automatic Memory Agent prompt","legacy prompt text is copied into a Default preset record");
  const extensible=clonePromptConfiguration(initial.prompts);
  const defaultPreset=extensible.presets.find(preset=>preset.id==="default")!;
  defaultPreset.futurePresetField={kept:true};
  defaultPreset.prompts[0]!.futurePromptField="keep-this-field";
  extensible.futureConfigurationField={revision:9};
  const extended=JSON.parse(JSON.stringify({...initial,prompts:extensible})) as Record<string,any>;
  const extendedReload=migrateAppSettings(extended);
  equal(extendedReload.prompts.futureConfigurationField,{revision:9},"migration preserves unknown prompt configuration fields");
  equal(extendedReload.prompts.presets.find((preset:Record<string,any>)=>preset.id==="default")?.futurePresetField,{kept:true},"migration preserves unknown preset fields");
  equal(extendedReload.prompts.presets.find((preset:Record<string,any>)=>preset.id==="default")?.prompts[0]?.futurePromptField,"keep-this-field","migration preserves unknown prompt-record fields");
  const emptyPreset={...createDefaultPromptPreset(),id:"empty-lab",name:"Empty Lab",isBuiltIn:false,prompts:[]};
  const emptyConfiguration={...initial.prompts,presets:[...initial.prompts.presets,emptyPreset],activePresetId:"empty-lab"};
  const emptyAssembly=assemblePromptInstructions(emptyConfiguration,"nova","reactive");
  equal(emptyAssembly.text,"","an intentionally empty preset does not restore factory instructions");
  ok(!emptyAssembly.error,"an empty but valid preset is not a configuration error");
  const editedEmpty=applyPromptOverride({...initial,prompts:emptyConfiguration},"memory-judge.system","Editable Judge system prompt");
  const editedEmptyAssembly=assemblePromptInstructions(editedEmpty.prompts,"memory-judge","plain");
  ok(editedEmptyAssembly.text.includes("Editable Judge system prompt"),"legacy Settings editor creates an active editable record when a custom preset does not contain that prompt");
  const missingAssembly=assemblePromptInstructions({...initial.prompts,activePresetId:"missing"},"nova","reactive");
  ok(!!missingAssembly.error&&missingAssembly.text==="","a missing active preset reports an error without fallback text");

  const invalid={...defaultAppSettings(),prompts:{overrides:{"unregistered-prompt":"custom"}}} as unknown as AppSettings;
  ok(validateAppSettings(invalid).some(error=>error.includes("Unsupported prompt id")),"unknown prompt ids are rejected");
  let rejected=false;
  try{migrateAppSettings({...defaultAppSettings(),prompts:{overrides:{"nova-system-json":"x".repeat(12001)}}});}catch{rejected=true;}
  ok(rejected,"prompt values exceeding the limit are rejected during migration");
  const emptyManager=new SettingsManager(store,validator);
  await emptyManager.initialize();
  const activeEmpty={...emptyManager.get(),prompts:emptyConfiguration};
  await emptyManager.set(activeEmpty);
  const emptyReload=await new SettingsManager(store,validator).initialize();
  equal(emptyReload.prompts.activePresetId,"empty-lab","active custom preset persists across settings-manager restart");
  equal(assemblePromptInstructions(emptyReload.prompts,"nova","reactive").text,"","empty active preset remains empty after restart");
  const removedActive={...emptyReload,prompts:{...emptyReload.prompts,presets:emptyReload.prompts.presets.filter(preset=>preset.id!=="empty-lab")}};
  const normalizedRemoved=migrateAppSettings(removedActive);
  equal(normalizedRemoved.prompts.activePresetId,"default","removed active preset is repaired to Default during settings normalization");
  console.log("PASS editable prompt presets, routing, unknown-field migration, persistence, resets, and no-fallback behavior");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
