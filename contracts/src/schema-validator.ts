import type {JsonSchema,SchemaValidator} from "./index";

export interface ValidationResult { valid:boolean; errors:readonly string[]; }

export class MinimalJsonSchemaValidator implements SchemaValidator {
  validate(value:unknown,schema:JsonSchema):ValidationResult {
    const errors:string[]=[];
    this.check(value,schema,"$",errors);
    return {valid:errors.length===0,errors};
  }
  private check(value:unknown,schema:JsonSchema,path:string,errors:string[]):void {
    if(schema.enum && !schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value))){
      errors.push(path+" must match one of enum values");
      return;
    }
    if(schema.type){
      const types=Array.isArray(schema.type)?schema.type:[schema.type];
      if(!types.some(type=>this.matchesType(value,type))){
        errors.push(path+" must be "+types.join("|"));
        return;
      }
    }
    if(typeof value==="string"){
      if(schema.minLength!==undefined && value.length<schema.minLength)errors.push(path+" is too short");
      if(schema.maxLength!==undefined && value.length>schema.maxLength)errors.push(path+" is too long");
    }
    if(typeof value==="number"){
      if(schema.minimum!==undefined && value<schema.minimum)errors.push(path+" is below minimum");
      if(schema.maximum!==undefined && value>schema.maximum)errors.push(path+" is above maximum");
    }
    if(Array.isArray(value)){
      if(schema.minItems!==undefined && value.length<schema.minItems)errors.push(path+" has too few items");
      if(schema.maxItems!==undefined && value.length>schema.maxItems)errors.push(path+" has too many items");
      if(schema.items)value.forEach((item,index)=>this.check(item,schema.items!,path+"["+index+"]",errors));
    }
    if(value && typeof value==="object" && !Array.isArray(value)){
      const objectValue=value as Record<string,unknown>;
      for(const required of schema.required??[]){
        if(!(required in objectValue))errors.push(path+" missing required property "+required);
      }
      for(const [key,child] of Object.entries(objectValue)){
        const propertySchema=schema.properties?.[key];
        if(propertySchema)this.check(child,propertySchema,path+"."+key,errors);
        else if(schema.additionalProperties===false)errors.push(path+" has unknown property "+key);
        else if(schema.additionalProperties && typeof schema.additionalProperties==="object"){
          this.check(child,schema.additionalProperties,path+"."+key,errors);
        }
      }
    }
  }
  private matchesType(value:unknown,type:string):boolean{
    switch(type){
      case "object":return !!value&&typeof value==="object"&&!Array.isArray(value);
      case "array":return Array.isArray(value);
      case "string":return typeof value==="string";
      case "number":return typeof value==="number"&&Number.isFinite(value);
      case "integer":return typeof value==="number"&&Number.isInteger(value);
      case "boolean":return typeof value==="boolean";
      case "null":return value===null;
      default:return true;
    }
  }
}
