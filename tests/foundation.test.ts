import {InMemoryAuditService,InMemoryDiagnosticsStore,InMemoryEventBus,InMemoryStateStore,ModuleManager,ProviderRegistry} from "../core/src";
import {FakeBrowserModule,FakeCharacterModule,FakeMemoryModule,fakeContext} from "../modules/mock/src";
import {FakeChatProvider,FakeTTSProvider} from "../providers/mock/src";
import {CompanionModule,FOUNDATION_SCHEMA_VERSION,STANDARD_SCHEMAS,createEvent} from "../contracts/src";
import {MinimalJsonSchemaValidator} from "../contracts/src/schema-validator";
import {InMemoryJsonRpcTransport} from "../host/ipc/src";
import {startFoundationRuntime} from "../runtime/bootstrap/src";

function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}
function ok(value:unknown,label:string){if(!value)throw new Error(label);}

async function schemaValidationTest(){
  const validator=new MinimalJsonSchemaValidator();
  const manifest={id:"test",name:"Test",version:"1.0.0",apiVersion:"1",schemaVersion:"1",type:"service",runtime:"typescript",optional:true,capabilities:[]};
  ok(validator.validate(manifest,STANDARD_SCHEMAS["module-manifest"]!).valid,"valid manifest schema");
  ok(!validator.validate({...manifest,risk:"low"},STANDARD_SCHEMAS["module-manifest"]!).valid,"manifest rejects unknown field");
  const event=createEvent("SpeechStarted",{text:"hello"},"test",()=> "now","e1");
  ok(validator.validate(event,STANDARD_SCHEMAS["event-envelope"]!).valid,"valid event schema");
  const permission={id:"p1",schemaVersion:FOUNDATION_SCHEMA_VERSION,subject:"character",resourceType:"domain",action:"browser.navigate",effect:"allow"};
  ok(validator.validate(permission,STANDARD_SCHEMAS["permission"]!).valid,"valid permission schema");
}

async function eventBusTest(){
  const diagnostics=new InMemoryDiagnosticsStore(),bus=new InMemoryEventBus(diagnostics),calls:string[]=[];
  bus.subscribe("SpeechStarted",async()=>{calls.push("A");});
  bus.subscribe("SpeechStarted",async()=>{calls.push("B");throw new Error("subscriber failed");});
  bus.subscribe("SpeechStarted",async()=>{calls.push("C");});
  await bus.publish(createEvent("SpeechStarted",{text:"hi"},"test",()=> "now","event-1"));
  equal(calls.join(","),"A,B,C","EventBus dispatch continues");
  equal(diagnostics.recentErrors()[0]?.code,"EVENT_HANDLER_FAILED","EventBus diagnostics");
  const off=bus.subscribe("SpeechFinished",()=>{});off();equal(bus.subscriberCount("SpeechFinished"),0,"unsubscribe");
}

async function stateStoreTest(){
  const diagnostics=new InMemoryDiagnosticsStore(),store=new InMemoryStateStore(diagnostics);let good=0;
  store.subscribe<number>("x",()=>{throw new Error("observer failed");});
  store.subscribe<number>("x",value=>{good=value;});
  await store.set("x",7);
  equal(store.get<number>("x"),7,"state value");equal(good,7,"observer after failure");
  equal(diagnostics.recentErrors()[0]?.code,"STATE_OBSERVER_FAILED","state diagnostics");
}

async function moduleManagerTest(){
  const diagnostics=new InMemoryDiagnosticsStore(),bus=new InMemoryEventBus(diagnostics),manager=new ModuleManager(manifest=>fakeContext(manifest.id,bus),diagnostics);
  const character=new FakeCharacterModule(),memory=new FakeMemoryModule(),browser=new FakeBrowserModule();
  manager.register(character);manager.register(memory);manager.register(browser);await manager.initializeAll();await manager.startAll();
  equal(manager.getState("character.fake"),"running","module running");
  await bus.publish(createEvent("SpeechStarted",{text:"hello"},"test",()=> "now","speech-1"));equal(character.speechEvents,1,"module event reaction");
  const health=await manager.health() as Record<string,{status:string}|undefined>;equal(health["memory.fake"]?.status,"healthy","module health");
}

async function optionalFailureTest(){
  class InitBroken extends FakeMemoryModule{override async initialize(){throw new Error("init boom");}}
  class StartBroken extends FakeMemoryModule{override async start(){throw new Error("start boom");}}
  const diagnostics=new InMemoryDiagnosticsStore(),bus=new InMemoryEventBus(diagnostics),manager=new ModuleManager(manifest=>fakeContext(manifest.id,bus),diagnostics);
  const good=new FakeCharacterModule(),initBroken=new InitBroken(),startBroken=new StartBroken();
  Object.defineProperty(initBroken,"manifest",{value:{...initBroken.manifest,id:"memory.init-broken"}});
  Object.defineProperty(startBroken,"manifest",{value:{...startBroken.manifest,id:"memory.start-broken"}});
  manager.register(good);manager.register(initBroken);manager.register(startBroken);await manager.initializeAll();await manager.startAll();
  equal(manager.getState("character.fake"),"running","core survives module failures");
  equal(manager.getState("memory.init-broken"),"error","initialize failure state");
  equal(manager.getState("memory.start-broken"),"error","start failure state");
}

async function restartAndShutdownTest(){
  let starts=0,initializations=0,stops=0;
  const baseManifest={id:"restartable",name:"Restartable",version:"0.1.0",apiVersion:"1" as const,schemaVersion:"1",type:"service" as const,runtime:"typescript" as const,optional:true,capabilities:[]};
  class Restartable implements CompanionModule{
    manifest=baseManifest;
    async initialize(){initializations++;}
    async start(){starts++;if(starts===1)throw new Error("first start");}
    async stop(){stops++;}
    async health(){return {status:"healthy" as const};}
  }
  class StopBroken implements CompanionModule{
    manifest={...baseManifest,id:"stop-broken"};
    async initialize(){}
    async start(){}
    async stop(){stops++;throw new Error("stop failed");}
    async health(){return {status:"healthy" as const};}
  }
  const diagnostics=new InMemoryDiagnosticsStore(),manager=new ModuleManager(manifest=>fakeContext(manifest.id,new InMemoryEventBus()),diagnostics);
  manager.register(new Restartable());manager.register(new StopBroken());manager.register(new FakeMemoryModule());
  await manager.initializeAll();await manager.startAll();
  equal(manager.getState("restartable"),"error","first start fails");
  await manager.restart("restartable");
  equal(initializations,2,"restart reinitializes errored module");
  equal(manager.getState("restartable"),"running","restart reaches running");
  let thrown=false;try{await manager.stopAll();}catch{thrown=true;}
  ok(thrown,"stopAll reports failure");
  equal(stops,2,"shutdown continues after stop failure");
  equal(manager.getState("memory.fake"),"ready","other module stopped");
}

async function enableDisableTest(){
  const diagnostics=new InMemoryDiagnosticsStore();
  const manager=new ModuleManager(
    manifest=>fakeContext(manifest.id,new InMemoryEventBus()),
    diagnostics
  );
  const module=new FakeMemoryModule();
  manager.register(module);
  await manager.initializeAll();
  await manager.startAll();
  equal(manager.getState("memory.fake"),"running","module starts");
  await manager.disable("memory.fake");
  equal(manager.getState("memory.fake"),"disabled","module disables");
  await manager.enable("memory.fake");
  equal(manager.getState("memory.fake"),"running","disabled module re-enables");
  let restartFailed=false;
  try{await manager.restart("memory.fake");}catch{restartFailed=true;}
  ok(!restartFailed,"running module can restart");
}

async function providerTest(){
  const registry=new ProviderRegistry(),chat=new FakeChatProvider(),tts=new FakeTTSProvider();
  registry.register(chat,["chat"]);registry.register(tts,["tts"]);
  equal(registry.findByCapabilities("tts",["audioOutput"]).length,1,"capability discovery");
  equal(chat.capabilities().toolCalling,false,"fake chat does not claim tool calling");
  equal((await registry.health())["fake.chat"]?.status,"healthy","provider health");
  const audit=new InMemoryAuditService();
  await audit.record({timestamp:"now",actorId:"a",actorType:"module",action:"test",resourceType:"resource",argumentKeys:[],status:"denied",durationMs:1,allowed:false});
  equal(audit.entries.length,1,"audit service");
}

async function runtimeBootTest(){
  const runtime=await startFoundationRuntime();
  try{
    const snapshot=await runtime.diagnostics();
    equal(snapshot.runtimeStatus,"running","runtime status");
    ok(snapshot.modules.some(module=>module.id==="character.fake"&&module.state==="running"),"real module diagnostics");
    ok(snapshot.providers.some(provider=>provider.id==="fake.chat"&&provider.health?.status==="healthy"),"real provider diagnostics");
  }finally{await runtime.stop();}
}

async function jsonRpcTest(){
  const left=new InMemoryJsonRpcTransport(),right=new InMemoryJsonRpcTransport();let disconnected=false;
  left.connect(right);right.onDisconnect(()=>{disconnected=true;});
  let received:string|undefined;right.onMessage(message=>{if("method" in message)received=message.method;});
  await left.send({jsonrpc:"2.0",id:1,method:"ping"});equal(received,"ping","JSON-RPC request transport");
  let invalid=false;try{await left.send({jsonrpc:"1.0",id:1,method:"ping"} as never);}catch{invalid=true;}
  ok(invalid,"invalid JSON-RPC rejected");await left.close();ok(disconnected,"disconnect notification");
}

void (async()=>{
  for(const [name,test] of [
    ["Schema validation",schemaValidationTest],["EventBus",eventBusTest],["StateStore",stateStoreTest],["ModuleManager",moduleManagerTest],
    ["Optional failures",optionalFailureTest],["Restart and shutdown",restartAndShutdownTest],["Enable and disable",enableDisableTest],["ProviderRegistry",providerTest],
    ["Runtime bootstrap",runtimeBootTest],["JSON-RPC",jsonRpcTest]
  ] as const){await test();console.log("PASS "+name);}
  console.log("All foundation runtime tests passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
