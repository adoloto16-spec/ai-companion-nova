import type {CredentialReference,CredentialStore} from "../../../contracts/src/index";

export type CredentialInvoke=(command:string,args?:Record<string,unknown>)=>Promise<unknown>;

export const CREDENTIAL_COMMANDS={save:"save_credential",get:"get_credential",remove:"delete_credential",exists:"credential_exists"} as const;

export class InMemoryCredentialStore implements CredentialStore{
  private readonly values=new Map<string,string>();
  async getSecret(reference:CredentialReference){return this.values.get(reference.id);}
  async setSecret(reference:CredentialReference,value:string){this.values.set(reference.id,value);}
  async deleteSecret(reference:CredentialReference){this.values.delete(reference.id);}
  async exists(reference:CredentialReference){return this.values.has(reference.id);}
}

export class IpcCredentialStore implements CredentialStore{
  constructor(private readonly invoke:CredentialInvoke){}
  async getSecret(reference:CredentialReference){
    const value=await this.invoke(CREDENTIAL_COMMANDS.get,{reference}) as string|null|undefined;
    return value??undefined;
  }
  async setSecret(reference:CredentialReference,value:string){await this.invoke(CREDENTIAL_COMMANDS.save,{reference,secret:value});}
  async deleteSecret(reference:CredentialReference){await this.invoke(CREDENTIAL_COMMANDS.remove,{reference});}
  async exists(reference:CredentialReference){return Boolean(await this.invoke(CREDENTIAL_COMMANDS.exists,{reference}));}
}
