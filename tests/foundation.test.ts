function equal(actual:unknown,expected:unknown,label:string){if(actual!==expected)throw new Error(label+" expected "+String(expected)+" got "+String(actual));}

import {InMemoryEventBus,InMemoryStateStore,ModuleManager,ProviderRegistry,DefaultActionBroker,InMemoryPermissionService,InMemoryAuditService,InMemoryToolRegistry} from "../core/src";
import {FakeCharacterModule,FakeMemoryModule,FakeBrowserModule,fakeContext} from "../modules/mock/src";
import {FakeChatProvider,FakeTTSProvider} from "../providers/mock/src";
import {createEvent} from "../contracts/src";

async function eventTest(){
  const bus=new InMemoryEventBus();let seen=0;const off=bus.subscribe<{text:string}>("SpeechStarted",e=>{seen=e.payload.text.length;});
  await bus.publish(createEvent("SpeechStarted",{text:"hello"},"test",()=> "now","1"));equal(seen,5,"EventBus");off();
}
async function stateTest(){
  const s=new InMemoryStateStore();let seen=0;s.subscribe<number>("x",v=>{seen=v;});await s.set("x",3);equal(s.get("x"),3,"StateStore get");equal(seen,3,"StateStore event");
}
async function moduleTest(){
  const bus=new InMemoryEventBus(),mngr=new ModuleManager(id=>fakeContext(id,bus));const c=new FakeCharacterModule(),m=new FakeMemoryModule(),b=new FakeBrowserModule();
  [c,m,b].forEach(x=>mngr.register(x));await mngr.initializeAll();await mngr.startAll();equal(mngr.getState(c.manifest.id),"running","Module state");
  await bus.publish(createEvent("SpeechStarted",{text:"hi"},"test",()=> "now","2"));equal(c.speechEvents,1,"module event reaction");
  const h=await mngr.health() as Record<string,{status:string}>;equal(h["memory.fake"]?.status,"healthy","memory health");equal(h["browser.fake"]?.status,"healthy","browser health");
}
async function faultTest(){
  class Broken extends FakeBrowserModule{override async start(){throw new Error("boom");}}
  const bus=new InMemoryEventBus(),mngr=new ModuleManager(id=>fakeContext(id,bus)),good=new FakeMemoryModule(),bad=new Broken();
  Object.defineProperty(bad,"manifest",{value:{...bad.manifest,id:"tts.broken"}});mngr.register(good);mngr.register(bad);await mngr.initializeAll();await mngr.startAll();
  equal(mngr.getState("memory.fake"),"running","core survival");equal(mngr.getState("tts.broken"),"error","optional failure");
}
async function providerTest(){
  const r=new ProviderRegistry(),chat=new FakeChatProvider(),tts=new FakeTTSProvider();r.register(chat,["chat"]);r.register(tts,["tts"]);
  equal(r.findByCapabilities("chat",["toolCalling"]).length,1,"capability discovery");equal((await r.health())["fake.chat"]?.status,"healthy","provider health");
}
async function actionTest(){
  const tr=new InMemoryToolRegistry();tr.register({name:"browser.search",description:"search",risk:"low",parameters:{type:"object"}},{id:"mock",async execute(req){return {query:req.arguments.query};}});
  const p=new InMemoryPermissionService(),a=new InMemoryAuditService(),b=new DefaultActionBroker({toolRegistry:tr,permissions:p,
    foreground:{async verify(){return {allowed:true,reason:"ok"}}},confirmation:{async confirm(){return true}},audit:a});
  const req={id:"a1",tool:"browser.search",arguments:{query:"nova"},requestedBy:"character",risk:"low" as const,resource:"app.browser",action:"browser.search",scope:{domains:["example.com"]}};
  equal((await b.execute(req)).status,"denied","permission deny");
  p.add({id:"p1",subject:"character",resource:"app.browser",action:"browser.search",effect:"allow",scope:{domains:["example.com"]}});
  equal((await b.execute(req)).status,"success","permission allow");
  const blockedConfirmation=new DefaultActionBroker({toolRegistry:tr,permissions:p,foreground:{async verify(){return {allowed:true,reason:"ok"}}},confirmation:{async confirm(){return false}},audit:a});
  const highRisk={...req,id:"a2",risk:"high" as const};
  equal((await blockedConfirmation.execute(highRisk)).status,"denied","high-risk confirmation");
  equal(a.entries.length,3,"audit");
}
void (async()=>{for(const [n,t] of [["EventBus",eventTest],["StateStore",stateTest],["ModuleManager",moduleTest],["Fault isolation",faultTest],["ProviderRegistry",providerTest],["ActionBroker",actionTest]] as const){await t();console.log("PASS "+n);}console.log("All Foundation tests passed.");})().catch(e=>{console.error(e);process.exitCode=1;});
