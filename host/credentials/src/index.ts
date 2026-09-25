import type {CredentialReference,CredentialStore} from "../../../contracts/src/index";

export class InMemoryCredentialStore implements CredentialStore{
  private readonly values=new Map<string,string>();
  async getSecret(reference:CredentialReference){return this.values.get(reference.id);}
  async setSecret(reference:CredentialReference,value:string){this.values.set(reference.id,value);}
  async deleteSecret(reference:CredentialReference){this.values.delete(reference.id);}
}
