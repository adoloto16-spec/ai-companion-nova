export const NOVA_TURN_PROTOCOL_VERSION = 1 as const;
export const NOVA_TURN_MAX_SERIALIZED_CHARS = 32_000;

export interface NovaToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface NovaToolResult {
  callId: string;
  name: string;
  status: "success" | "error" | "unknown-tool";
  output?: unknown;
  error?: string;
}

export interface NovaTurn {
  version: typeof NOVA_TURN_PROTOCOL_VERSION;
  situation: string;
  thoughts: string;
  emotion: string;
  tools: readonly NovaToolCall[];
  /** Runtime-produced results; model responses may omit the TOOL_RESULTS block. */
  toolResults: readonly NovaToolResult[];
  speech: string;
  nextWakeMs: number;
}

export type NovaTurnFieldStatus = "valid" | "empty" | "missing" | "invalid" | "recovered";
export interface NovaTurnParsedField<T> {
  status: NovaTurnFieldStatus;
  value?: T;
}
export interface NovaTurnParseFields {
  situation: NovaTurnParsedField<string>;
  thoughts: NovaTurnParsedField<string>;
  emotion: NovaTurnParsedField<string>;
  tools: NovaTurnParsedField<readonly NovaToolCall[]>;
  toolResults: NovaTurnParsedField<readonly NovaToolResult[]>;
  speech: NovaTurnParsedField<string>;
  nextWakeMs: NovaTurnParsedField<number>;
}
export interface NovaTurnParseResult {
  /** Present only when SPEECH is unique and safe to use as public speech. */
  turn?: NovaTurn;
  speech?: string;
  complete: boolean;
  diagnostics: readonly string[];
  fields: NovaTurnParseFields;
}

const FIELD_LIMITS = {
  SITUATION: 4_000,
  THOUGHTS: 8_000,
  EMOTION: 500,
  SPEECH: 4_000,
  TOOL_COUNT: 12,
  TOOL_ARGUMENTS: 4_000,
  TOOL_RESULTS: 12,
  TOOL_RESULT_CHARS: 4_000,
  NEXT_WAKE_MS: 3_600_000,
} as const;

const TOOL_NAME = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/i;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (_entity, name: string) => {
    switch (name) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
      default: return _entity;
    }
  });
}

type CanonicalField = "SITUATION" | "THOUGHTS" | "EMOTION" | "TOOLS" | "TOOL_RESULTS" | "SPEECH" | "NEXT_WAKE_MS";
interface TagToken { closing:boolean; rawName:string; canonical:CanonicalField; attributes:string; start:number; end:number; }
interface ReadFieldResult { status:NovaTurnFieldStatus; value?:string; diagnostic?:string; }
const FIELD_ALIASES:Record<CanonicalField,readonly string[]> = {
  SITUATION:["CURRENT_SITUATION"],
  THOUGHTS:["THOUGHT"],
  EMOTION:[],
  TOOLS:["TOOL_CALLS"],
  TOOL_RESULTS:["TOOLRESULTS"],
  SPEECH:["PUBLIC_SPEECH"],
  NEXT_WAKE_MS:["NEXT_WAKE_INTERVAL_MS"],
};
const FIELD_NAME_MAP = new Map<string,CanonicalField>();
for(const canonical of Object.keys(FIELD_ALIASES) as CanonicalField[]){
  for(const alias of [canonical,...FIELD_ALIASES[canonical]])FIELD_NAME_MAP.set(alias,canonical);
}
function scanAllFieldTokens(source:string):TagToken[] {
  const tokens:TagToken[]=[];
  const re=/<\s*(\/?)\s*([A-Za-z][A-Za-z0-9_.-]*)\b([^>]*)>/g;
  for(const match of source.matchAll(re)){
    const rawName=match[2]!.toUpperCase();
    const canonical=FIELD_NAME_MAP.get(rawName);
    if(!canonical)continue;
    const start=match.index!;
    tokens.push({closing:match[1]==="/",rawName,canonical,attributes:match[3]??"",start,end:start+match[0].length});
  }
  return tokens;
}
function scanTagTokens(source:string, canonical:CanonicalField):TagToken[]{
  return scanAllFieldTokens(source).filter(token=>token.canonical===canonical);
}
function enclosingFieldNames(source:string, before:number):CanonicalField[]{
  const stack:TagToken[]=[];
  for(const token of scanAllFieldTokens(source)){
    if(token.start>=before)break;
    if(!token.closing){stack.push(token);continue;}
    for(let index=stack.length-1;index>=0;index--){
      if(stack[index]!.rawName===token.rawName){stack.splice(index,1);break;}
    }
  }
  return stack.map(token=>token.canonical);
}
function readField(source:string, canonical:CanonicalField, wrapperRecovered:boolean):ReadFieldResult {
  const tokens=scanTagTokens(source,canonical);
  if(tokens.length===0){
    const names=[canonical,...FIELD_ALIASES[canonical]].join("|");
    const malformed=new RegExp("<\\s*\\/?\\s*(?:"+names+")\\b[^>]*(?:$|\\n)","i").test(source);
    return malformed
      ?{status:"invalid",diagnostic:canonical+"-tag-malformed"}
      :{status:"missing",diagnostic:canonical+"-missing"};
  }
  if(tokens.length!==2)return {status:"invalid",diagnostic:canonical+(tokens.length>2?"-duplicate":"-unclosed")};
  const [open,close]=tokens;
  if(!open||!close||open.closing||!close.closing||open.start>=close.start||
    open.attributes.trim()!==""||close.attributes.trim()!=="" ){
    return {status:"invalid",diagnostic:canonical+"-tag-malformed"};
  }
  if(open.rawName!==close.rawName)return {status:"invalid",diagnostic:canonical+"-tag-mismatch"};
  if(canonical==="SPEECH"){
    const owner=enclosingFieldNames(source,open.start).at(-1);
    if(owner)return {status:"invalid",diagnostic:"SPEECH-nested-in-"+owner};
  }
  const raw=source.slice(open.end,close.start);
  if(canonical==="SPEECH"&&/<\s*\/?\s*[A-Za-z][A-Za-z0-9_.-]*\b[^>]*>/.test(raw)){
    return {status:"invalid",diagnostic:"SPEECH-contains-unescaped-tags"};
  }
  const value=unescapeXml(raw).trim();
  const aliasUsed=open.rawName!==canonical||close.rawName!==canonical;
  return {
    status:value.length===0?"empty":(wrapperRecovered||aliasUsed?"recovered":"valid"),
    value,
    ...(wrapperRecovered?{diagnostic:canonical+"-recovered-from-damaged-wrapper"}:{}),
    ...(aliasUsed?{diagnostic:canonical+"-recovered-from-alias"}:{}),
  };
}
function withFieldDiagnostic(field:ReadFieldResult, diagnostics:string[]):void {
  if(field.diagnostic&&!diagnostics.includes(field.diagnostic))diagnostics.push(field.diagnostic);
}

export function serializeNovaTurn(turn: NovaTurn): string {
  const tools = turn.tools.map(call => {
    if (!TOOL_NAME.test(call.name)) throw new Error("Invalid NovaTurn tool name.");
    return "<" + call.name + ">" + escapeXml(JSON.stringify(call.arguments)) + "</" + call.name + ">";
  }).join("\n");
  const toolResults = (turn.toolResults ?? []).map(result => {
    const serialized = JSON.stringify({
      callId: result.callId,
      name: result.name,
      status: result.status,
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.error === undefined ? {} : { error: result.error.slice(0, FIELD_LIMITS.TOOL_RESULT_CHARS) }),
    });
    if (!serialized || serialized.length > FIELD_LIMITS.TOOL_RESULT_CHARS) {
      return "<tool_result>" + escapeXml(JSON.stringify({callId: result.callId, name: result.name, status: "error", error: "result-too-large"})) + "</tool_result>";
    }
    return "<tool_result>" + escapeXml(serialized) + "</tool_result>";
  }).join("\n");
  return [
    '<NOVA_TURN version="1">',
    "<SITUATION>" + escapeXml(turn.situation) + "</SITUATION>",
    "<THOUGHTS>" + escapeXml(turn.thoughts) + "</THOUGHTS>",
    "<EMOTION>" + escapeXml(turn.emotion) + "</EMOTION>",
    "<TOOLS>" + tools + "</TOOLS>",
    "<TOOL_RESULTS>" + toolResults + "</TOOL_RESULTS>",
    "<SPEECH>" + escapeXml(turn.speech) + "</SPEECH>",
    "<NEXT_WAKE_MS>" + String(turn.nextWakeMs) + "</NEXT_WAKE_MS>",
    "</NOVA_TURN>",
  ].join("\n");
}

/**
 * Parse the versioned tagged protocol conservatively. Recover only uniquely paired,
 * bounded fields; malformed or unlabelled text is never promoted to public speech.
 */
export function parseNovaTurn(content: string): NovaTurnParseResult {
  const diagnostics:string[]=[];
  const missing=(status:NovaTurnFieldStatus="missing"):NovaTurnParsedField<string>=>({status});
  const blankFields: NovaTurnParseFields = {
    situation:missing(),thoughts:missing(),emotion:missing(),
    tools:{status:"missing"},toolResults:{status:"missing"},speech:missing(),nextWakeMs:{status:"missing"},
  };
  if(typeof content!=="string"||content.length===0){
    return {complete:false,diagnostics:["response-empty-or-invalid"],fields:blankFields};
  }
  if(content.length>NOVA_TURN_MAX_SERIALIZED_CHARS){
    return {complete:false,diagnostics:["response-too-large"],fields:{
      situation:{status:"invalid"},thoughts:{status:"invalid"},emotion:{status:"invalid"},
      tools:{status:"invalid"},toolResults:{status:"invalid"},speech:{status:"invalid"},nextWakeMs:{status:"invalid"},
    }};
  }

  const wrapperTokens=[...content.matchAll(/<\s*(\/?)\s*NOVA_TURN\b([^>]*)>/gi)].map(match=>({
    closing:match[1]==="/", attributes:match[2]??"", start:match.index!, end:match.index!+match[0].length, raw:match[0],
  }));
  const opens=wrapperTokens.filter(token=>!token.closing);
  const closes=wrapperTokens.filter(token=>token.closing);
  const version=opens.length===1?opens[0]!.attributes.match(/\bversion\s*=\s*["']\s*(\d+)\s*["']/i)?.[1]:undefined;
  if(opens.length===1&&version!==undefined&&version!=="1"){
    return {complete:false,diagnostics:["unsupported-protocol-version"],fields:{
      situation:{status:"invalid"},thoughts:{status:"invalid"},emotion:{status:"invalid"},
      tools:{status:"invalid"},toolResults:{status:"invalid"},speech:{status:"invalid"},nextWakeMs:{status:"invalid"},
    }};
  }
  const wrapperValid=opens.length===1&&closes.length===1&&wrapperTokens.length===2&&
    opens[0]!.start<closes[0]!.start&&version==="1"&&opens[0]!.attributes.replace(/\bversion\s*=\s*["']\s*\d+\s*["']/i,"").trim()==="";
  if(!wrapperValid)diagnostics.push("NOVA_TURN-wrapper-invalid");
  const body=wrapperValid?content.slice(opens[0]!.end,closes[0]!.start):content;
  const situationRaw=readField(body,"SITUATION",!wrapperValid);
  const thoughtsRaw=readField(body,"THOUGHTS",!wrapperValid);
  const emotionRaw=readField(body,"EMOTION",!wrapperValid);
  const toolsRaw=readField(body,"TOOLS",!wrapperValid);
  const toolResultsRaw=readField(body,"TOOL_RESULTS",!wrapperValid);
  const speechRaw=readField(body,"SPEECH",!wrapperValid);
  const wakeRaw=readField(body,"NEXT_WAKE_MS",!wrapperValid);
  for(const field of [situationRaw,thoughtsRaw,emotionRaw,toolsRaw,toolResultsRaw,speechRaw,wakeRaw])withFieldDiagnostic(field,diagnostics);

  const readBoundedText=(name:"SITUATION"|"THOUGHTS"|"EMOTION"|"SPEECH",field:ReadFieldResult,limit:number):NovaTurnParsedField<string>=>{
    if(field.value===undefined)return {status:field.status};
    if(field.value.length>limit){diagnostics.push(name+"-too-long");return {status:"invalid"};}
    return {status:field.status,value:field.value};
  };
  const situation=readBoundedText("SITUATION",situationRaw,FIELD_LIMITS.SITUATION);
  const thoughts=readBoundedText("THOUGHTS",thoughtsRaw,FIELD_LIMITS.THOUGHTS);
  const emotion=readBoundedText("EMOTION",emotionRaw,FIELD_LIMITS.EMOTION);
  const speech=readBoundedText("SPEECH",speechRaw,FIELD_LIMITS.SPEECH);

  let tools:NovaToolCall[]=[];
  let toolsStatus: NovaTurnFieldStatus=toolsRaw.status;
  if(toolsRaw.value!==undefined&&toolsRaw.status!=="invalid"){
    const toolContent=toolsRaw.value;
    const calls=[...toolContent.matchAll(/<\s*([a-z][a-z0-9_.-]*)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi)];
    const residue=toolContent.replace(/<\s*([a-z][a-z0-9_.-]*)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi,"").trim();
    if(residue){diagnostics.push("TOOLS-malformed-content");toolsStatus="invalid";}
    if(calls.length>FIELD_LIMITS.TOOL_COUNT){diagnostics.push("TOOLS-too-many");toolsStatus="invalid";}
    for(const match of calls.slice(0,FIELD_LIMITS.TOOL_COUNT)){
      const name=match[1]!;
      const json=unescapeXml(match[2]!).trim();
      if(!TOOL_NAME.test(name)||json.length>FIELD_LIMITS.TOOL_ARGUMENTS){
        diagnostics.push("tool-call-invalid:"+name);toolsStatus="invalid";continue;
      }
      try{
        const args:unknown=JSON.parse(json);
        if(!args||typeof args!=="object"||Array.isArray(args)){
          diagnostics.push("tool-arguments-invalid:"+name);toolsStatus="invalid";continue;
        }
        tools.push({name,arguments:args as Record<string,unknown>});
      }catch{diagnostics.push("tool-arguments-invalid:"+name);toolsStatus="invalid";}
    }
    if(!toolContent.trim()&&toolsStatus!=="invalid")toolsStatus=toolsRaw.status==="recovered"?"recovered":"empty";
  }

  const toolResults:NovaToolResult[]=[];
  let toolResultsStatus: NovaTurnFieldStatus=toolResultsRaw.status;
  if(toolResultsRaw.value!==undefined&&toolResultsRaw.status!=="invalid"){
    const resultsContent=toolResultsRaw.value;
    const results=[...resultsContent.matchAll(/<\s*tool_result\s*>([\s\S]*?)<\s*\/\s*tool_result\s*>/gi)];
    const residue=resultsContent.replace(/<\s*tool_result\s*>[\s\S]*?<\s*\/\s*tool_result\s*>/gi,"").trim();
    if(residue){diagnostics.push("TOOL_RESULTS-malformed-content");toolResultsStatus="invalid";}
    if(results.length>FIELD_LIMITS.TOOL_RESULTS){diagnostics.push("TOOL_RESULTS-too-many");toolResultsStatus="invalid";}
    for(const match of results.slice(0,FIELD_LIMITS.TOOL_RESULTS)){
      const json=unescapeXml(match[1]!).trim();
      if(json.length>FIELD_LIMITS.TOOL_RESULT_CHARS){diagnostics.push("tool-result-too-large");toolResultsStatus="invalid";continue;}
      try{
        const parsed:unknown=JSON.parse(json);
        if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("not-object");
        const item=parsed as Record<string,unknown>;
        if(typeof item.callId!=="string"||item.callId.length>200||typeof item.name!=="string"||
          !TOOL_NAME.test(item.name)||!["success","error","unknown-tool"].includes(String(item.status)))throw new Error("invalid-shape");
        toolResults.push({callId:item.callId,name:item.name,status:item.status as NovaToolResult["status"],
          ...(item.output===undefined?{}:{output:item.output}),
          ...(typeof item.error==="string"?{error:item.error.slice(0,FIELD_LIMITS.TOOL_RESULT_CHARS)}:{})});
      }catch{diagnostics.push("tool-result-invalid");toolResultsStatus="invalid";}
    }
    if(!resultsContent.trim()&&toolResultsStatus!=="invalid")toolResultsStatus=toolResultsRaw.status==="recovered"?"recovered":"empty";
  }

  let nextWakeMs=Number.NaN;
  let wakeStatus:NovaTurnFieldStatus=wakeRaw.status;
  if(wakeRaw.value!==undefined&&wakeRaw.status!=="invalid"){
    if(wakeRaw.value.length===0){
      wakeStatus="empty";
      diagnostics.push("NEXT_WAKE_MS-empty");
    }else{
      nextWakeMs=/^\d+$/.test(wakeRaw.value)?Number(wakeRaw.value):Number.NaN;
      if(!Number.isSafeInteger(nextWakeMs)||nextWakeMs<1||nextWakeMs>FIELD_LIMITS.NEXT_WAKE_MS){
        wakeStatus="invalid";diagnostics.push("NEXT_WAKE_MS-invalid");nextWakeMs=Number.NaN;
      }
    }
  }else if(wakeRaw.status!=="invalid")diagnostics.push("NEXT_WAKE_MS-invalid");

  const fields:NovaTurnParseFields={
    situation,thoughts,emotion,tools:{status:toolsStatus,...(toolsStatus==="invalid"?{}:{value:tools})},
    toolResults:{status:toolResultsStatus,...(toolResultsStatus==="invalid"?{}:{value:toolResults})},
    speech,nextWakeMs:{status:wakeStatus,...(Number.isFinite(nextWakeMs)?{value:nextWakeMs}:{})},
  };
  const fieldAcceptable=(field:NovaTurnParsedField<unknown>)=>field.status==="valid"||field.status==="empty"||field.status==="recovered";
  const speechUsable=speech.value!==undefined&&fieldAcceptable(speech)&&speech.status!=="invalid";
  const nextWakeValid=Number.isFinite(nextWakeMs);
  const requiredValid=wrapperValid&&[situation,thoughts,emotion,fields.tools].every(fieldAcceptable)&&speechUsable&&nextWakeValid;
  const complete=requiredValid&&toolResultsStatus!=="invalid";
  if(!complete&&diagnostics.length===0)diagnostics.push("protocol-incomplete");
  if(!speechUsable)return {complete:false,diagnostics,fields};

  return {
    turn:{
      version:NOVA_TURN_PROTOCOL_VERSION,
      situation:situation.value??"",
      thoughts:thoughts.value??"",
      emotion:emotion.value??"",
      tools:toolsStatus==="invalid"?[]:tools,
      toolResults:toolResultsStatus==="invalid"?[]:toolResults,
      speech:speech.value??"",
      nextWakeMs:nextWakeValid?nextWakeMs:30_000,
    },
    speech:speech.value??"",
    complete,
    diagnostics,
    fields,
  };
}
