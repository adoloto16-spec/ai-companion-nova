import type {AppSettings,AppSettingsStore,SchemaValidator} from "../../contracts/src/index";
import {APP_SETTINGS_API_VERSION,APP_SETTINGS_SCHEMA_VERSION,DEFAULT_APP_SETTINGS,STANDARD_SCHEMAS,defaultAppSettings,migrateAppSettings,validateAppSettings} from "../../contracts/src/index";

function cloneSettings(settings:AppSettings):AppSettings{
  return {
    ...settings,
    chat:{...settings.chat},
    context:{...settings.context},
    memory:{...settings.memory},
    semanticDedup:{...settings.semanticDedup,judge:{...settings.semanticDedup.judge}},
    retrieval:{...settings.retrieval},
    diagnostics:{...settings.diagnostics},
    ui:{...settings.ui}
  };
}

export class SettingsManager{
  private settings:AppSettings=defaultAppSettings();
  private initialized=false;
  constructor(private readonly store:AppSettingsStore,private readonly validator:SchemaValidator){}
  async initialize():Promise<AppSettings>{
    try{
      const stored=await this.store.load();
      if(stored===undefined){
        this.settings=defaultAppSettings();
        await this.store.save(this.settings);
      }else{
        this.settings=this.validateAndMigrate(stored);
        if(stored.schemaVersion!==this.settings.schemaVersion)await this.store.save(this.settings);
      }
    }catch{
      this.settings=defaultAppSettings();
    }
    this.initialized=true;
    return cloneSettings(this.settings);
  }
  get():AppSettings{
    if(!this.initialized)return cloneSettings(this.settings);
    return cloneSettings(this.settings);
  }
  async set(settings:AppSettings):Promise<AppSettings>{
    const next=this.validateAndMigrate(settings);
    await this.store.save(next);
    this.settings=next;
    return cloneSettings(next);
  }
  async reset():Promise<AppSettings>{
    const next=defaultAppSettings();
    await this.store.save(next);
    this.settings=next;
    return cloneSettings(next);
  }
  private validateAndMigrate(value:unknown):AppSettings{
    const migrated=migrateAppSettings(value);
    const result=this.validator.validate(migrated,STANDARD_SCHEMAS["app-settings"]!);
    if(!result.valid)throw new Error("AppSettings contract validation failed: "+result.errors.join(" "));
    const errors=validateAppSettings(migrated);
    if(errors.length>0)throw new Error(errors.join(" "));
    if(migrated.apiVersion!==APP_SETTINGS_API_VERSION||migrated.schemaVersion!==APP_SETTINGS_SCHEMA_VERSION)throw new Error("Unsupported AppSettings version.");
    return cloneSettings(migrated);
  }
}
