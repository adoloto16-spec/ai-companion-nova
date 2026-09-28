import type {CharacterId,ModelProfile,ModelProfileStore} from "../../../contracts/src/index";

export type ModelProfileStoreInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;

export const MODEL_PROFILE_COMMANDS={
  get:"get_model_profile",
  save:"save_model_profile",
  delete:"delete_model_profile"
} as const;

function cloneProfile(profile:ModelProfile):ModelProfile{
  return {
    apiVersion:profile.apiVersion,
    schemaVersion:profile.schemaVersion,
    id:profile.id,
    characterId:profile.characterId,
    ...(profile.providerId!==undefined?{providerId:profile.providerId}:{}),
    ...(profile.model!==undefined?{model:profile.model}:{}),
    generation:{
      ...(profile.generation.temperature!==undefined?{temperature:profile.generation.temperature}:{}),
      ...(profile.generation.topP!==undefined?{topP:profile.generation.topP}:{}),
      ...(profile.generation.maxTokens!==undefined?{maxTokens:profile.generation.maxTokens}:{}),
      ...(profile.generation.responseFormat?{
        responseFormat:{
          type:profile.generation.responseFormat.type,
          ...(profile.generation.responseFormat.type==="json"&&profile.generation.responseFormat.schema!==undefined
            ?{schema:{...profile.generation.responseFormat.schema}}:{} )
        }
      }: {})
    },
    createdAt:profile.createdAt,
    updatedAt:profile.updatedAt
  };
}

export class InMemoryModelProfileStore implements ModelProfileStore{
  private readonly profiles=new Map<CharacterId,ModelProfile>();
  async load(characterId:CharacterId):Promise<ModelProfile|undefined>{
    const profile=this.profiles.get(characterId);
    return profile?cloneProfile(profile):undefined;
  }
  async save(profile:ModelProfile):Promise<void>{
    if(profile.characterId.trim().length===0)throw new Error("Model profile character scope must not be empty.");
    this.profiles.set(profile.characterId,cloneProfile(profile));
  }
  async delete(characterId:CharacterId):Promise<void>{this.profiles.delete(characterId)}
}

export class IpcModelProfileStore implements ModelProfileStore{
  constructor(private readonly invoke:ModelProfileStoreInvoke){}
  async load(characterId:CharacterId):Promise<ModelProfile|undefined>{
    const value=await this.invoke(MODEL_PROFILE_COMMANDS.get,{characterId});
    return value===null||value===undefined?undefined:cloneProfile(value as ModelProfile);
  }
  async save(profile:ModelProfile):Promise<void>{
    await this.invoke(MODEL_PROFILE_COMMANDS.save,{profile:cloneProfile(profile)});
  }
  async delete(characterId:CharacterId):Promise<void>{
    await this.invoke(MODEL_PROFILE_COMMANDS.delete,{characterId});
  }
}
