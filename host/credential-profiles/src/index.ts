import type {CredentialProfile,CredentialProfileStoreState,CredentialProfileStore} from "../../../contracts/src/index";

export type CredentialProfileInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;
export const CREDENTIAL_PROFILE_COMMANDS={get:"get_credential_profiles",save:"save_credential_profiles",remove:"delete_credential_profile"} as const;

function cloneProfile(profile:CredentialProfile):CredentialProfile{
  return {
    ...profile,
    credentialReference:{...profile.credentialReference}
  };
}
function cloneState(state:CredentialProfileStoreState):CredentialProfileStoreState{
  return {...state,profiles:state.profiles.map(cloneProfile)};
}
export function emptyCredentialProfileState(now=new Date().toISOString()):CredentialProfileStoreState{
  return {apiVersion:"1",schemaVersion:"1",profiles:[]};
}
export class InMemoryCredentialProfileStore implements CredentialProfileStore{
  private state:CredentialProfileStoreState|undefined;
  async load(){return this.state?cloneState(this.state):undefined;}
  async save(state:CredentialProfileStoreState){this.state=cloneState(state);}
  async delete(id:string){
    if(!this.state)return;
    this.state={...this.state,profiles:this.state.profiles.filter(profile=>profile.id!==id)};
  }
}
export class IpcCredentialProfileStore implements CredentialProfileStore{
  constructor(private readonly invoke:CredentialProfileInvoke){}
  async load(){
    const value=await this.invoke(CREDENTIAL_PROFILE_COMMANDS.get);
    return value===null||value===undefined?undefined:value as CredentialProfileStoreState;
  }
  async save(state:CredentialProfileStoreState){
    await this.invoke(CREDENTIAL_PROFILE_COMMANDS.save,{state:cloneState(state)});
  }
  async delete(id:string){await this.invoke(CREDENTIAL_PROFILE_COMMANDS.remove,{id});}
}
