import type {ActionDriver,JsonSchema,PostconditionChecker,ToolDefinition} from "../../contracts/src/index";
import {FOUNDATION_SCHEMA_VERSION} from "../../contracts/src/index";
export interface RegisteredTool{definition:ToolDefinition;driver:ActionDriver;postcondition?:PostconditionChecker}
export class InMemoryToolRegistry{
  private readonly tools=new Map<string,RegisteredTool>();
  register(definition:ToolDefinition,driver:ActionDriver,postcondition?:PostconditionChecker):void{
    if(this.tools.has(definition.name))throw new Error("Tool already registered: "+definition.name);
    if(definition.schemaVersion!==FOUNDATION_SCHEMA_VERSION)throw new Error("Unsupported tool schemaVersion: "+definition.schemaVersion);
    if(definition.parameters.type!=="object")throw new Error("Tool parameter schema must be an object schema.");
    this.tools.set(definition.name,{definition,driver,postcondition});
  }
  get(name:string){return this.tools.get(name);}
  list():readonly ToolDefinition[]{return [...this.tools.values()].map(item=>item.definition);}
}
export const objectSchema=(properties:Record<string,JsonSchema>,required:readonly string[]=[]):JsonSchema=>({type:"object",properties,required,additionalProperties:false});
