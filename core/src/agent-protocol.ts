import type {AgentDecision,SchemaValidator} from "../../contracts/src/index";
import {STANDARD_SCHEMAS} from "../../contracts/src/index";

const MAX_PROTOCOL_LENGTH=8000;

export class AgentDecisionProtocolError extends Error{
  readonly code="AGENT_DECISION_INVALID" as const;
  constructor(message:string){super(message);this.name="AgentDecisionProtocolError";}
}

function bounded(raw:string){
  if(raw.length>MAX_PROTOCOL_LENGTH)throw new AgentDecisionProtocolError("Agent decision output exceeds the bounded protocol length.");
}

export function validateAgentDecision(value:unknown,validator:SchemaValidator):AgentDecision{
  const result=validator.validate(value,STANDARD_SCHEMAS["agent-decision"]!);
  if(!result.valid)throw new AgentDecisionProtocolError("Agent decision failed strict schema validation.");
  return value as AgentDecision;
}

export function parseStructuredDecision(raw:string,validator:SchemaValidator):AgentDecision{
  bounded(raw);
  let value:unknown;
  try{value=JSON.parse(raw);}catch{throw new AgentDecisionProtocolError("Structured agent decision is not valid JSON.");}
  return validateAgentDecision(value,validator);
}

function tagLine(line:string):[string,string]{
  const i=line.indexOf("=");
  if(i<=0)throw new AgentDecisionProtocolError("Tagged agent decision contains a malformed field.");
  const key=line.slice(0,i).trim(),value=line.slice(i+1).trim();
  if(!key||!value)throw new AgentDecisionProtocolError("Tagged agent decision contains an empty field.");
  return [key,value];
}

export function parseTaggedDecision(raw:string,validator:SchemaValidator):AgentDecision{
  bounded(raw);
  const match=/^\s*<NOVA_ACTION>\r?\n([\s\S]*?)\r?\n<\/NOVA_ACTION>\s*$/.exec(raw);
  if(!match)throw new AgentDecisionProtocolError("Agent output must contain exactly one NOVA_ACTION block and no surrounding prose.");
  const fields:Record<string,string>={};
  for(const line of match[1]!.split(/\r?\n/)){
    if(!line.trim())throw new AgentDecisionProtocolError("NOVA_ACTION block contains an empty line.");
    const [key,value]=tagLine(line);
    if(fields[key]!==undefined)throw new AgentDecisionProtocolError("NOVA_ACTION block contains duplicate fields.");
    fields[key]=value;
  }
  const type=fields.type;
  const allowed:Record<string,readonly string[]>={
    continue:["type","summary"],wait:["type","wait_ms"],ask_user:["type","question"],finish:["type","result"]
  };
  if(!type||!allowed[type])throw new AgentDecisionProtocolError("NOVA_ACTION block contains an unknown action type.");
  for(const key of Object.keys(fields))if(!allowed[type]!.includes(key))throw new AgentDecisionProtocolError("NOVA_ACTION block contains an unknown field.");
  let candidate:unknown;
  switch(type){
    case "continue":candidate={action:"continue",...(fields.summary!==undefined?{workingSummary:fields.summary}:{})};break;
    case "wait":
      if(!/^[0-9]+$/.test(fields.wait_ms??""))throw new AgentDecisionProtocolError("wait_ms must be an integer.");
      candidate={action:"wait",waitMs:Number(fields.wait_ms)};break;
    case "ask_user":candidate={action:"ask_user",question:fields.question};break;
    case "finish":candidate={action:"finish",result:fields.result};break;
    default:throw new AgentDecisionProtocolError("Unsupported NOVA_ACTION type.");
  }
  return validateAgentDecision(candidate,validator);
}
