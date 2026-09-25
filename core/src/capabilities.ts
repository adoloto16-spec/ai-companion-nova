import type {CapabilityContext} from "../../contracts/src/index";

export class ScopedCapabilityContext implements CapabilityContext {
  constructor(private readonly allowed:ReadonlySet<string>){}
  has(capability:string):boolean{return this.allowed.has(capability);}
  require(capability:string):void{
    if(!this.has(capability))throw new Error("CAPABILITY_DENIED: "+capability);
  }
}
export class AllowAllCapabilityContext implements CapabilityContext {
  has(_capability:string):boolean{return true;}
  require(_capability:string):void{}
}
