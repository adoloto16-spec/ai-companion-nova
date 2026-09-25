import type {
  ActionBroker,ActionInvocation,ActionResult,AuditService,ConfirmationService,DiagnosticsStore,ForegroundCheck,
  PermissionService,RiskPolicy,SchemaValidator
} from "../../contracts/src/index";
import {FOUNDATION_SCHEMA_VERSION,STANDARD_SCHEMAS} from "../../contracts/src/index";
import type {ActionTargetResolver} from "../../contracts/src/index";
import type {InMemoryToolRegistry} from "./tools";

export interface ActionBrokerDependencies{
  toolRegistry:InMemoryToolRegistry;
  permissions:PermissionService;
  foreground:ForegroundCheck;
  riskPolicy:RiskPolicy;
  confirmation:ConfirmationService;
  audit:AuditService;
  schemaValidator:SchemaValidator;
  diagnostics?:DiagnosticsStore;
  targetResolvers:Map<string,ActionTargetResolver>;
}
function targetSummary(target:import("../../contracts/src/index").ActionTarget):string{
  switch(target.kind){
    case "domain":return target.domain;
    case "filesystem":return target.canonicalPath??target.path;
    case "application":return target.windowId?target.applicationId+"#"+target.windowId:target.applicationId;
    case "resource":return target.resource;
  }
}
export class DefaultActionBroker implements ActionBroker{
  constructor(private readonly deps:ActionBrokerDependencies){}
  async execute(invocation:ActionInvocation):Promise<ActionResult>{
    const start=Date.now(),req=invocation.request;
    const definition=req&&this.deps.toolRegistry.get(req.tool)?.definition;
    const audit=async(result:ActionResult,reason?:string,summary?:string):Promise<ActionResult>=>{
      await this.deps.audit.record({
        timestamp:new Date().toISOString(),
        actorId:invocation.actor.actorId,
        actorType:invocation.actor.actorType,
        module:invocation.actor.moduleId,
        action:req?.tool??"unknown",
        resourceType:definition?.resourceType??"resource",
        targetSummary:summary,
        argumentKeys:req&&req.arguments&&typeof req.arguments==="object"?Object.keys(req.arguments):[],
        status:result.status,
        durationMs:result.durationMs,
        allowed:result.status==="success",
        reason
      });
      return result;
    };

    const requestSchema=this.deps.schemaValidator.validate(req,STANDARD_SCHEMAS["action-request"]);
    if(!requestSchema.valid)return audit({
      id:req?.id??"unknown",schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
      error:{code:"SCHEMA_VALIDATION_FAILED",message:"Action request failed schema validation.",details:{errors:[...requestSchema.errors]}},
      durationMs:Date.now()-start
    },"request schema");
    if(req.schemaVersion!==FOUNDATION_SCHEMA_VERSION)return audit({
      id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
      error:{code:"SCHEMA_VALIDATION_FAILED",message:"Unsupported action request schema version."},
      durationMs:Date.now()-start
    },"schema version");

    const tool=this.deps.toolRegistry.get(req.tool);
    if(!tool)return audit({
      id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
      error:{code:"TOOL_NOT_FOUND",message:"Tool not found: "+req.tool},durationMs:Date.now()-start
    },"unknown tool");
    if(invocation.actor.trusted!==true)return audit({
      id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
      error:{code:"PERMISSION_DENIED",message:"Actor identity is not trusted."},durationMs:Date.now()-start
    },"untrusted actor");

    for(const capability of tool.definition.requiredCapabilities){
      if(!invocation.actor.capabilities.includes(capability))return audit({
        id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
        error:{code:"CAPABILITY_DENIED",message:"Missing capability: "+capability},durationMs:Date.now()-start
      },"missing capability");
    }

    const argsSchema=this.deps.schemaValidator.validate(req.arguments,tool.definition.parameters);
    if(!argsSchema.valid)return audit({
      id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
      error:{code:"SCHEMA_VALIDATION_FAILED",message:"Tool arguments failed schema validation.",details:{errors:[...argsSchema.errors]}},
      durationMs:Date.now()-start
    },"argument schema");

    const resolver=this.deps.targetResolvers.get(tool.definition.targetResolverId);
    if(!resolver)return audit({
      id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
      error:{code:"TARGET_RESOLUTION_FAILED",message:"Target resolver not registered: "+tool.definition.targetResolverId},
      durationMs:Date.now()-start
    },"target resolver");

    let target:import("../../contracts/src/index").ActionTarget;
    try{target=await resolver.resolve(req,tool.definition);}
    catch(error){
      const message=error instanceof Error?error.message:String(error);
      this.deps.diagnostics?.recordError("action-broker","TARGET_RESOLUTION_FAILED",message,{tool:req.tool});
      return audit({
        id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
        error:{code:"TARGET_RESOLUTION_FAILED",message},durationMs:Date.now()-start
      },"target resolution");
    }

    if(target.kind!==tool.definition.resourceType)return audit({
      id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
      error:{code:"SCOPE_DENIED",message:"Resolved target type does not match canonical tool policy."},
      durationMs:Date.now()-start
    },"target type mismatch",targetSummary(target));

    const permission=await this.deps.permissions.check(invocation.actor,tool.definition,target);
    if(!permission.allowed)return audit({
      id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
      error:{code:"PERMISSION_DENIED",message:permission.reason},durationMs:Date.now()-start
    },permission.reason,targetSummary(target));

    const foreground=await this.deps.foreground.verify(invocation.actor,tool.definition,target);
    if(!foreground.allowed)return audit({
      id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
      error:{code:"FOREGROUND_DENIED",message:foreground.reason},durationMs:Date.now()-start
    },foreground.reason,targetSummary(target));

    const canonicalRisk=this.deps.riskPolicy.canonicalRisk(tool.definition);
    if((canonicalRisk==="high"||canonicalRisk==="critical")&&this.deps.riskPolicy.requiresConfirmation(tool.definition,target)){
      if(!await this.deps.confirmation.confirm(invocation,tool.definition,target))return audit({
        id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"denied",
        error:{code:"CONFIRMATION_REQUIRED",message:"Confirmation was not granted."},durationMs:Date.now()-start
      },"confirmation denied",targetSummary(target));
    }

    try{
      const output=await tool.driver.execute(req,target);
      if(tool.postcondition&&!await tool.postcondition.verify(req,target,output))return audit({
        id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"error",
        error:{code:"POSTCONDITION_FAILED",message:"Postcondition failed."},durationMs:Date.now()-start
      },"postcondition",targetSummary(target));
      return audit({id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"success",output,durationMs:Date.now()-start},undefined,targetSummary(target));
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      this.deps.diagnostics?.recordError("action-broker","DRIVER_ERROR",message,{tool:req.tool});
      return audit({
        id:req.id,schemaVersion:FOUNDATION_SCHEMA_VERSION,status:"error",
        error:{code:"DRIVER_ERROR",message},durationMs:Date.now()-start
      },"driver error",targetSummary(target));
    }
  }
}
