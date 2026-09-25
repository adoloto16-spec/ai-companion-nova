import type {
  BrowserService,CharacterService,CapabilityContext,CompanionModule,EventBus,HealthStatus,MemoryService,
  ModuleContext,ModuleManifest
} from "../../../contracts/src/index";

class MockCapabilityContext implements CapabilityContext {
  constructor(private readonly allowed:ReadonlySet<string>){}
  has(capability:string){return this.allowed.has(capability);}
  require(capability:string){if(!this.has(capability))throw new Error("CAPABILITY_DENIED: "+capability);}
}
export function fakeContext(moduleId:string,events:EventBus,capabilities:readonly string[]=[]):ModuleContext{
  const values=new Map<string,unknown>();
  return {
    moduleId,events,
    logger:{debug(){},info(){},warn(){},error(){}},
    config:{get:key=>values.get(key),set:async(key,value)=>{values.set(key,value);}},
    clock:{now:()=>new Date().toISOString()},
    capabilities:new MockCapabilityContext(new Set(capabilities))
  };
}
export class FakeCharacterModule implements CompanionModule,CharacterService{
  manifest:ModuleManifest={
    id:"character.fake",name:"Fake Character",version:"0.1.0",apiVersion:"1",schemaVersion:"1",
    type:"service",runtime:"typescript",optional:true,capabilities:["character.expression","character.speech"]
  };
  speechEvents=0;private unsubscribe?:()=>void;
  async initialize(context:ModuleContext){this.unsubscribe=context.events.subscribe<{text:string}>("SpeechStarted",()=>{this.speechEvents++;});}
  async start(){} async stop(){this.unsubscribe?.();this.unsubscribe=undefined;}
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:this.manifest.capabilities};}
  async loadCharacter(_id:string){} async setExpression(_v:{primary:string;secondary?:string|null;intensity:number}){}
  async playGesture(_v:{gestureId:string;durationMs?:number}){} async setGaze(_v:{target:"user"|"camera"|"custom";x?:number;y?:number}){}
  async speak(_v:{active:boolean;intensity?:number}){}
}
export class FakeMemoryModule implements CompanionModule,MemoryService{
  manifest:ModuleManifest={
    id:"memory.fake",name:"Fake Memory",version:"0.1.0",apiVersion:"1",schemaVersion:"1",
    type:"service",runtime:"typescript",optional:true,capabilities:["memory.search","memory.write"]
  };
  private readonly store=new Map<string,string>();
  async initialize(_context:ModuleContext){} async start(){} async stop(){}
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:this.manifest.capabilities};}
  async search(q:{query:string;limit?:number}){return [...this.store.entries()].filter(([,v])=>v.includes(q.query)).slice(0,q.limit??10).map(([id,text])=>({id,text,score:1}));}
  async remember(v:{text:string;category?:string;importance?:number}){const id="mem-"+(this.store.size+1);this.store.set(id,v.text);return id;}
  async update(v:{id:string;text?:string}){if(!this.store.has(v.id))throw new Error("unknown memory");if(v.text!==undefined)this.store.set(v.id,v.text);}
  async forget(id:string){this.store.delete(id);}
  async consolidate(_date:string){return {processed:this.store.size,changed:0};}
}
export class FakeBrowserModule implements CompanionModule,BrowserService{
  manifest:ModuleManifest={
    id:"browser.fake",name:"Fake Browser",version:"0.1.0",apiVersion:"1",schemaVersion:"1",
    type:"adapter",runtime:"typescript",optional:true,capabilities:["browser.search","browser.navigate"]
  };
  private page={title:"Fake Browser",text:"No page opened."};
  async initialize(_context:ModuleContext){} async start(){} async stop(){}
  async health():Promise<HealthStatus>{return {status:"healthy",capabilities:this.manifest.capabilities};}
  async open(url:string){this.page={title:url,text:"Opened "+url};}
  async search(query:string){this.page={title:"Search",text:"Results for "+query};}
  async readPage(){return this.page;}
  async click(_selector:string){return {status:"success" as const,output:{clicked:true}};}
}
