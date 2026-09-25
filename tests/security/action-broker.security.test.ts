import {
  DefaultActionBroker,DefaultConfirmationService,DefaultRiskPolicy,InMemoryAuditService,InMemoryPermissionService,
  InMemoryToolRegistry,BrowserTargetResolver,FilesystemTargetResolver,ApplicationTargetResolver
} from "../../core/src";
import {MinimalJsonSchemaValidator} from "../../contracts/src/schema-validator";
import {FOUNDATION_SCHEMA_VERSION,type ActionInvocation,type ActionRequest,type ActorIdentity,type ActionTarget,ToolDefinition} from "../../contracts/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
const actor:ActorIdentity={actorId:"character",actorType:"module",moduleId:"character.fake",trusted:true,capabilities:["browser.navigate","filesystem.write","computer.control"]};
const foreground={async verify(){return {allowed:true,reason:"foreground ok"}}};

function makeBroker(definition:ToolDefinition,resolver:{id:string;resolve(request:ActionRequest,tool:ToolDefinition):Promise<ActionTarget>},driver:{id:string;execute(request:ActionRequest,target:ActionTarget):Promise<unknown>},allowScope:Parameters<InMemoryPermissionService["add"]>[0]["scope"],confirmationResult=true){
  const tools=new InMemoryToolRegistry(),permissions=new InMemoryPermissionService(),audit=new InMemoryAuditService();
  tools.register(definition,driver);permissions.add({id:"allow",schemaVersion:FOUNDATION_SCHEMA_VERSION,subject:"character",resourceType:definition.resourceType,action:definition.action,effect:"allow",scope:allowScope});
  const broker=new DefaultActionBroker({toolRegistry:tools,permissions,foreground,riskPolicy:new DefaultRiskPolicy(),confirmation:new DefaultConfirmationService(async()=>confirmationResult),audit,schemaValidator:new MinimalJsonSchemaValidator(),targetResolvers:new Map([[resolver.id,resolver]])});
  return {broker,audit};
}
const request=(tool:string,argumentsValue:Record<string,unknown>):ActionInvocation=>({request:{id:"a1",schemaVersion:FOUNDATION_SCHEMA_VERSION,tool,arguments:argumentsValue},actor});
const browserDefinition:ToolDefinition={
  id:"browser.navigate",version:"1.0.0",schemaVersion:"1",name:"browser.navigate",description:"navigate",risk:"low",
  requiredCapabilities:["browser.navigate"],resourceType:"domain",action:"browser.navigate",targetResolverId:"browser.url",
  confirmation:"never",parameters:{type:"object",properties:{url:{type:"string"}},required:["url"],additionalProperties:false}
};

async function normalDomainScenario(){
  const {broker}=makeBroker(browserDefinition,new BrowserTargetResolver("browser.url"),{id:"driver",async execute(_r,target){return target}},["youtube.com"]);
  equal((await broker.execute(request("browser.navigate",{url:"https://www.youtube.com/watch?v=1"}))).status,"success","normal allowed domain");
}
async function forgedScopeScenario(){
  const {broker}=makeBroker(browserDefinition,new BrowserTargetResolver("browser.url"),{id:"driver",async execute(_r,target){return target}},["youtube.com"]);
  equal((await broker.execute(request("browser.navigate",{url:"https://evil-youtube.com",scope:{domains:["youtube.com"]}} as never))).status,"denied","forged scope");
  equal((await broker.execute(request("browser.navigate",{url:"https://evil-youtube.com"}))).status,"denied","actual domain denied");
}
async function riskDowngradeScenario(){
  const definition:ToolDefinition={...browserDefinition,id:"filesystem.delete",name:"filesystem.delete",risk:"critical",requiredCapabilities:["filesystem.write"],resourceType:"filesystem",action:"filesystem.delete",targetResolverId:"filesystem.path",confirmation:"policy",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}};
  const resolver=new FilesystemTargetResolver("filesystem.path",async path=>path);
  const {broker,audit}=makeBroker(definition,resolver,{id:"driver",async execute(){return {deleted:true}}},["D:/AI_Girl/"],false);
  equal((await broker.execute(request("filesystem.delete",{path:"D:/AI_Girl/file.txt",risk:"low"} as never))).status,"denied","caller cannot downgrade risk");
  equal((await broker.execute(request("filesystem.delete",{path:"D:/AI_Girl/file.txt"}))).status,"denied","critical requires confirmation");
  equal(audit.entries[1]?.reason,"confirmation denied","canonical confirmation reason");
}
async function capabilityScenario(){
  const definition:ToolDefinition={...browserDefinition,id:"filesystem.write",name:"filesystem.write",requiredCapabilities:["filesystem.write"],resourceType:"filesystem",action:"filesystem.write",targetResolverId:"filesystem.path",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}};
  const resolver=new FilesystemTargetResolver("filesystem.path",async path=>path);
  const {broker}=makeBroker(definition,resolver,{id:"driver",async execute(){return {ok:true}}},["D:/AI_Girl/"]);
  equal((await broker.execute({...request("filesystem.write",{path:"D:/AI_Girl/file.txt"}),actor:{...actor,capabilities:[]}})).status,"denied","missing capability");
}
async function filesystemScenario(){
  const definition:ToolDefinition={...browserDefinition,id:"filesystem.write",name:"filesystem.write",requiredCapabilities:["filesystem.write"],resourceType:"filesystem",action:"filesystem.write",targetResolverId:"filesystem.path",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}};
  const resolver=new FilesystemTargetResolver("filesystem.path",async path=>path);
  const {broker}=makeBroker(definition,resolver,{id:"driver",async execute(){return {ok:true}}},["D:/AI_Girl/"]);
  equal((await broker.execute(request("filesystem.write",{path:"D:/Users/file.txt"}))).status,"denied","wrong filesystem root");
  equal((await broker.execute(request("filesystem.write",{path:"D:/AI_Girl/../Windows/file.txt"}))).status,"denied","path traversal");
}
async function applicationScenario(){
  const definition:ToolDefinition={...browserDefinition,id:"application.control",name:"application.control",risk:"high",requiredCapabilities:["computer.control"],resourceType:"application",action:"application.control",targetResolverId:"application.window",parameters:{type:"object",properties:{applicationId:{type:"string"},windowId:{type:"string"}},required:["applicationId"],additionalProperties:false}};
  const {broker}=makeBroker(definition,new ApplicationTargetResolver("application.window"),{id:"driver",async execute(){return {ok:true}}},["chrome.exe"],true);
  equal((await broker.execute(request("application.control",{applicationId:"discord.exe"}))).status,"denied","wrong application");
  equal((await broker.execute(request("application.control",{applicationId:"chrome.exe"}))).status,"success","allowed application");
}
async function parameterAndDriverScenario(){
  const resolver=new BrowserTargetResolver("browser.url"),tools=new InMemoryToolRegistry(),permissions=new InMemoryPermissionService(),audit=new InMemoryAuditService();
  tools.register(browserDefinition,{id:"failing-driver",async execute(){throw new Error("driver failed");}});
  permissions.add({id:"allow",schemaVersion:"1",subject:"character",resourceType:"domain",action:"browser.navigate",effect:"allow",scope:{domains:["youtube.com"]}});
  const broker=new DefaultActionBroker({toolRegistry:tools,permissions,foreground,riskPolicy:new DefaultRiskPolicy(),confirmation:new DefaultConfirmationService(async()=>true),audit,schemaValidator:new MinimalJsonSchemaValidator(),targetResolvers:new Map([[resolver.id,resolver]])});
  equal((await broker.execute(request("browser.navigate",{url:1}))).status,"denied","invalid arguments");
  equal((await broker.execute(request("browser.navigate",{url:"https://youtube.com"}))).status,"error","driver failure");
  equal(audit.entries.at(-1)?.status,"error","driver audited");
}
async function postconditionScenario(){
  const tools=new InMemoryToolRegistry(),permissions=new InMemoryPermissionService(),audit=new InMemoryAuditService(),resolver=new BrowserTargetResolver("browser.url");
  tools.register(browserDefinition,{id:"driver",async execute(){return {ok:true};}},{async verify(){return false;}});
  permissions.add({id:"allow",schemaVersion:"1",subject:"character",resourceType:"domain",action:"browser.navigate",effect:"allow",scope:{domains:["youtube.com"]}});
  const broker=new DefaultActionBroker({toolRegistry:tools,permissions,foreground,riskPolicy:new DefaultRiskPolicy(),confirmation:new DefaultConfirmationService(async()=>true),audit,schemaValidator:new MinimalJsonSchemaValidator(),targetResolvers:new Map([[resolver.id,resolver]])});
  equal((await broker.execute(request("browser.navigate",{url:"https://youtube.com"}))).status,"error","postcondition failure");
}

void (async()=>{
  for(const [name,test] of [
    ["normal domain",normalDomainScenario],["forged scope",forgedScopeScenario],["risk downgrade",riskDowngradeScenario],
    ["capability enforcement",capabilityScenario],["filesystem scope",filesystemScenario],["application scope",applicationScenario],
    ["parameter/driver security",parameterAndDriverScenario],["postcondition",postconditionScenario]
  ] as const){await test();console.log("PASS "+name);}
  console.log("All security tests passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
