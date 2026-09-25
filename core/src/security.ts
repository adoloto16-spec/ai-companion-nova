import type {
  ActionInvocation,ActionRequest,ActionTarget,ActionTargetResolver,ActorIdentity,CapabilityContext,
  ConfirmationService,Permission,PermissionDecision,RiskPolicy,ToolDefinition
} from "../../contracts/src/index";

export function normalizeDomain(value:string):string{
  const parsed=new URL(value.includes("://")?value:"https://"+value);
  return parsed.hostname.toLowerCase().replace(/\.$/,"");
}
export function domainAllowed(actual:string,allowed:readonly string[]):boolean{
  const candidate=normalizeDomain(actual);
  return allowed.some(raw=>{const base=normalizeDomain(raw);return candidate===base||candidate.endsWith("."+base);});
}
export function normalizeFilesystemPath(value:string):string{
  const replaced=value.replace(/\\/g,"/");
  if(replaced.includes("\0"))throw new Error("invalid filesystem path");
  const drive=replaced.match(/^([A-Za-z]:)/);
  const prefix=drive?drive[1].toUpperCase()+"/":replaced.startsWith("/")?"/":"";
  const rest=drive?replaced.slice(2).replace(/^\/+/, ""):replaced.replace(/^\/+/, "");
  const stack:string[]=[];
  for(const part of rest.split("/")){
    if(!part||part===".")continue;
    if(part===".."){
      if(stack.length)stack.pop();
      else if(prefix)throw new Error("filesystem path escapes root");
      else stack.push("..");
    }else stack.push(part);
  }
  return prefix+stack.join("/");
}
export function filesystemPathAllowed(actual:string,roots:readonly string[],canonicalized:boolean):boolean{
  if(!canonicalized)return false;
  const candidate=normalizeFilesystemPath(actual).toLowerCase();
  return roots.some(root=>{const normalized=normalizeFilesystemPath(root).replace(/\/$/,"").toLowerCase();return candidate===normalized||candidate.startsWith(normalized+"/");});
}
export function applicationAllowed(applicationId:string,windowId:string|undefined,allowed:readonly string[],windows:readonly string[]|undefined):boolean{
  if(!allowed.some(item=>item.toLowerCase()===applicationId.toLowerCase()))return false;
  if(!windows||windows.length===0)return true;
  return !!windowId&&windows.some(item=>item.toLowerCase()===windowId.toLowerCase());
}
export class BrowserTargetResolver implements ActionTargetResolver{
  readonly id:string;
  constructor(id="browser.url"){this.id=id;}
  async resolve(request:ActionRequest):Promise<ActionTarget>{
    const url=request.arguments.url;
    if(typeof url!=="string")throw new Error("browser target requires arguments.url");
    const parsed=new URL(url);
    if(parsed.protocol!=="http:"&&parsed.protocol!=="https:")throw new Error("unsupported URL scheme");
    return {kind:"domain",url:parsed.toString(),domain:parsed.hostname.toLowerCase()};
  }
}
export class FilesystemTargetResolver implements ActionTargetResolver{
  readonly id:string;
  constructor(id="filesystem.path",private readonly canonicalize?:(path:string)=>Promise<string|undefined>){this.id=id;}
  async resolve(request:ActionRequest):Promise<ActionTarget>{
    const raw=request.arguments.path;
    if(typeof raw!=="string")throw new Error("filesystem target requires arguments.path");
    const normalized=normalizeFilesystemPath(raw);
    const canonicalPath=this.canonicalize?await this.canonicalize(normalized):undefined;
    return {kind:"filesystem",path:normalized,canonicalPath,canonicalized:canonicalPath!==undefined};
  }
}
export class ApplicationTargetResolver implements ActionTargetResolver{
  readonly id:string;
  constructor(id="application.window"){this.id=id;}
  async resolve(request:ActionRequest):Promise<ActionTarget>{
    const applicationId=request.arguments.applicationId;
    const windowId=request.arguments.windowId;
    if(typeof applicationId!=="string")throw new Error("applicationId is required");
    return {kind:"application",applicationId,windowId:typeof windowId==="string"?windowId:undefined};
  }
}
export class InMemoryActorIdentityResolver implements import("../../contracts/src/index").ActorIdentityResolver{
  private readonly identities=new Map<string,import("../../contracts/src/index").ActorIdentity>();
  register(credential:import("../../contracts/src/index").ActorCredential,identity:import("../../contracts/src/index").ActorIdentity){this.identities.set(credential.token,identity);}
  async resolve(credential:import("../../contracts/src/index").ActorCredential){return this.identities.get(credential.token);}
}
export class ScopedCapabilityContext implements CapabilityContext{
  constructor(private readonly allowed:ReadonlySet<string>){}
  has(capability:string){return this.allowed.has(capability);}
  require(capability:string){if(!this.has(capability))throw new Error("CAPABILITY_DENIED: "+capability);}
}
export class AllowAllCapabilityContext implements CapabilityContext{
  has(_capability:string){return true;}
  require(_capability:string){}
}
export class DefaultRiskPolicy implements RiskPolicy{
  canonicalRisk(tool:ToolDefinition){return tool.risk;}
  requiresConfirmation(tool:ToolDefinition){return tool.confirmation==="policy"&&(tool.risk==="high"||tool.risk==="critical");}
}
export class DefaultConfirmationService implements ConfirmationService{
  constructor(private readonly approve:(invocation:ActionInvocation,tool:ToolDefinition,target:ActionTarget)=>Promise<boolean>){}
  confirm(invocation:ActionInvocation,actor:import("../../contracts/src/index").ActorIdentity,tool:ToolDefinition,target:ActionTarget){return this.approve(invocation,tool,target);}
}
export class InMemoryPermissionService{
  private readonly rules:Permission[]=[];
  add(rule:Permission){this.rules.push(rule);}
  async check(actor:ActorIdentity,tool:ToolDefinition,target:ActionTarget):Promise<PermissionDecision>{
    const matches=this.rules.filter(rule=>rule.subject===actor.actorId&&rule.resourceType===tool.resourceType&&rule.action===tool.action);
    for(const rule of [...matches].reverse()){
      if(!this.matchesScope(rule,target))continue;
      return rule.effect==="allow"?{allowed:true,reason:"Permission allowlisted.",scopeMatched:true}:{allowed:false,reason:"Permission explicitly denied.",scopeMatched:true};
    }
    return {allowed:false,reason:"No matching permission rule.",scopeMatched:false};
  }
  private matchesScope(rule:Permission,target:ActionTarget):boolean{
    if(!rule.scope)return true;
    if(target.kind==="domain")return !!rule.scope.domains&&domainAllowed(target.domain,rule.scope.domains);
    if(target.kind==="filesystem")return !!rule.scope.roots&&filesystemPathAllowed(target.canonicalPath??target.path,rule.scope.roots,target.canonicalized);
    if(target.kind==="application")return !!rule.scope.applications&&applicationAllowed(target.applicationId,target.windowId,rule.scope.applications,rule.scope.windows);
    return false;
  }
}
