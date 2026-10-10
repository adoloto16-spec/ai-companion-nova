import {
  APP_SETTINGS_SCHEMA_VERSION,DEFAULT_PROMPT_TEXTS,PROMPT_REGISTRY,StandardContractValidator,
  applyPromptOverride,defaultAppSettings,migrateAppSettings,resolvePromptText,restoreAllPromptDefaults,
  restorePromptDefault,validateAppSettings
} from "../../contracts/src";
import type {AppSettings,PromptId} from "../../contracts/src";
import {SettingsManager} from "../../core/src";
import {InMemorySettingsStore} from "../../host/settings/src";

function equal(actual:unknown,expected:unknown,label:string):void{
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(label+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));
}
function ok(value:unknown,label:string):void{if(!value)throw new Error(label);}
async function main():Promise<void>{
  const ids=PROMPT_REGISTRY.map(prompt=>prompt.id);
  equal(ids.length,10,"complete registry contains all discovered editable prompt templates");
  equal([...ids].sort(),Object.keys(DEFAULT_PROMPT_TEXTS).sort(),"each registry item has one immutable factory default");
  ok(Object.isFrozen(DEFAULT_PROMPT_TEXTS),"factory prompt definitions are runtime-frozen");
  for(const prompt of PROMPT_REGISTRY){
    ok(prompt.title.length>0&&prompt.purpose.length>0&&prompt.defaultText.length>0,"registry entries include human-readable metadata and full default text: "+prompt.id);
    equal(resolvePromptText(undefined,prompt.id),prompt.defaultText,"unconfigured prompt resolves to factory default: "+prompt.id);
  }
  const validator=new StandardContractValidator();
  const store=new InMemorySettingsStore(validator);
  const manager=new SettingsManager(store,validator);
  const initial=await manager.initialize();
  equal(initial.schemaVersion,APP_SETTINGS_SCHEMA_VERSION,"settings manager initializes current schema");

  let custom=applyPromptOverride(initial,"nova-system-json","CUSTOM JSON SYSTEM");
  custom=applyPromptOverride(custom,"nova-cue-reactive-tagged","CUSTOM REACTIVE TAG CUE");
  custom=applyPromptOverride(custom,"memory-judge.system","CUSTOM JUDGE SYSTEM");
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
  legacy.semanticDedup.judge.providerPresetId="legacy-judge-preset";
  legacy.semanticDedup.judge.model="legacy-judge-model";
  legacy.semanticDedup.embeddingProviderPresetId="legacy-embedding-preset";
  legacy.semanticDedup.embeddingModel="legacy-embedding-model";
  legacy.context.availableContextTokens=6144;
  const migrated=migrateAppSettings(legacy);
  equal(migrated.schemaVersion,"12","previous AppSettings version migrates to v12");
  equal(migrated.prompts.overrides["memory-judge.system"],"Legacy user-authored Judge prompt","migration promotes custom Judge text into the central registry");
  equal(migrated.semanticDedup.judge.prompt,"Legacy user-authored Judge prompt","migration preserves prior custom Judge prompt");
  equal(migrated.semanticDedup.judge.providerPresetId,"legacy-judge-preset","migration preserves Judge provider selection");
  equal(migrated.semanticDedup.judge.model,"legacy-judge-model","migration preserves Judge model selection");
  equal(migrated.semanticDedup.embeddingProviderPresetId,"legacy-embedding-preset","migration preserves embedding provider preset");
  equal(migrated.semanticDedup.embeddingModel,"legacy-embedding-model","migration preserves embedding model");
  equal(migrated.context.availableContextTokens,6144,"migration preserves unrelated context settings");

  const invalid={...defaultAppSettings(),prompts:{overrides:{"unregistered-prompt":"custom"}}} as unknown as AppSettings;
  ok(validateAppSettings(invalid).some(error=>error.includes("Unsupported prompt id")),"unknown prompt ids are rejected");
  let rejected=false;
  try{migrateAppSettings({...defaultAppSettings(),prompts:{overrides:{"nova-system-json":"x".repeat(12001)}}});}catch{rejected=true;}
  ok(rejected,"prompt values exceeding the limit are rejected during migration");
  console.log("PASS editable prompt registry, settings persistence, resets, and migration");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
