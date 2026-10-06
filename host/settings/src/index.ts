import type {AppSettings,AppSettingsStore,SchemaValidator} from "../../../contracts/src/index";
import {STANDARD_SCHEMAS,defaultAppSettings,migrateAppSettings,validateAppSettings} from "../../../contracts/src/index";

export type AppSettingsStoreInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;
export const APP_SETTINGS_COMMANDS={get:"get_app_settings",save:"save_app_settings"} as const;

function clone(settings:AppSettings):AppSettings{
  // Persistence returns independent nested settings so provider/model bindings cannot be lost through shared mutable UI state.
  return {...settings,chat:{...settings.chat},memoryAgent:{...settings.memoryAgent},semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge}},context:{...settings.context},memory:{...settings.memory},retrieval:{...settings.retrieval},diagnostics:{...settings.diagnostics},ui:{...settings.ui}};
}
function validate(settings:AppSettings,validator:SchemaValidator):void{
  const schema=validator.validate(settings,STANDARD_SCHEMAS["app-settings"]!);
  if(!schema.valid)throw new Error("AppSettings contract validation failed: "+schema.errors.join(" "));
  const errors=validateAppSettings(settings);
  if(errors.length)throw new Error(errors.join(" "));
}

export class InMemorySettingsStore implements AppSettingsStore{
  private value:AppSettings|undefined;
  constructor(private readonly validator:SchemaValidator){}
  async load():Promise<AppSettings|undefined>{return this.value?clone(this.value):undefined;}
  async save(settings:AppSettings):Promise<void>{const next=migrateAppSettings(settings);validate(next,this.validator);this.value=clone(next);}
}
export class IpcSettingsStore implements AppSettingsStore{
  constructor(private readonly invoke:AppSettingsStoreInvoke,private readonly validator:SchemaValidator){}
  async load():Promise<AppSettings|undefined>{
    const value=await this.invoke(APP_SETTINGS_COMMANDS.get);
    if(value===null||value===undefined)return undefined;
    const next=migrateAppSettings(value);
    validate(next,this.validator);
    return clone(next);
  }
  async save(settings:AppSettings):Promise<void>{
    const next=migrateAppSettings(settings);validate(next,this.validator);
    await this.invoke(APP_SETTINGS_COMMANDS.save,{settings:clone(next)});
  }
}
export const emptySettings=():AppSettings=>defaultAppSettings();
