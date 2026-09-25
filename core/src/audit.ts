import type {AuditEntry,AuditService} from "../../contracts/src/index";

export class InMemoryAuditService implements AuditService {
  readonly entries:AuditEntry[]=[];
  async record(entry:AuditEntry):Promise<void>{this.entries.push({...entry});}
}
