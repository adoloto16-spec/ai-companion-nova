import type {DiagnosticsStore,ErrorDiagnostic,Logger} from "../../contracts/src/index";

export class InMemoryDiagnosticsStore implements DiagnosticsStore {
  private readonly errors:ErrorDiagnostic[]=[];
  constructor(private readonly maxEntries=100){}
  recordError(source:string,code:string,message:string,metadata?:Record<string,unknown>):void{
    this.errors.push({timestamp:new Date().toISOString(),source,code,message,metadata});
    if(this.errors.length>this.maxEntries)this.errors.splice(0,this.errors.length-this.maxEntries);
  }
  recentErrors(limit=20):readonly ErrorDiagnostic[]{return this.errors.slice(-limit).reverse();}
}
export const createConsoleLogger=():Logger=>({
  debug(message,metadata){console.debug(message,metadata);},
  info(message,metadata){console.info(message,metadata);},
  warn(message,metadata){console.warn(message,metadata);},
  error(message,metadata){console.error(message,metadata);}
});
export const createMemoryConfig=()=>{
  const values=new Map<string,unknown>();
  return {
    get:<T>(key:string)=>values.get(key) as T|undefined,
    set:async<T>(key:string,value:T)=>{values.set(key,value);}
  };
};
