import {parseNovaTurn, type ChatMessage, type NovaTurnParseResult} from "../../../contracts/src";

export interface NovaTurnMessagePresentation{
  isNovaTurn:boolean;
  render:boolean;
  text:string;
  parseResult?:NovaTurnParseResult;
}

/** Detect the existing stored v1 tag protocol or its native JSON Schema representation. */
export function isStoredNovaTurnContent(content:string):boolean{
  const source=content.trimStart();
  if(/^<\\s*NOVA_TURN\\b/i.test(source))return true;
  if(!source.startsWith("{"))return false;
  try{
    const value:unknown=JSON.parse(source);
    if(!value||typeof value!=="object"||Array.isArray(value))return false;
    const record=value as Record<string,unknown>;
    if(record.version!==1||!["speech","situation","thoughts","emotion","tools","nextWakeMs"].some(key=>key in record))return false;
    // Without metadata, only a schema-valid JSON object is confidently classed as a stored NovaTurn.
    return parseNovaTurn(source).complete;
  }catch{
    // Malformed JSON without NovaTurn metadata remains ordinary assistant text; metadata-marked turns
    // still reach the diagnostic parser through resolveNovaTurnMessagePresentation.
    return false;
  }
}

/** This is the same resolver ChatView uses, so history and reloaded conversations share visibility rules. */
export function resolveNovaTurnMessagePresentation(message:ChatMessage,showTechnicalData=false):NovaTurnMessagePresentation{
  if(message.role!=="assistant")return {isNovaTurn:false,render:true,text:message.content};
  const isNovaTurn=message.metadata?.novaTurnVersion===1||isStoredNovaTurnContent(message.content);
  if(!isNovaTurn)return {isNovaTurn:false,render:true,text:message.content};
  const parseResult=parseNovaTurn(message.content);
  const render=shouldRenderNovaTurn(parseResult,showTechnicalData);
  const speech=parseResult.turn?.speech.trim()?parseResult.turn.speech:"The model returned no valid speech.";
  return {isNovaTurn:true,render,text:speech,parseResult};
}

/** Ordinary Chat exposes only uniquely parsed, non-empty speech; technical mode preserves invalid stored records for diagnosis. */
export function shouldRenderNovaTurn(parsed:NovaTurnParseResult,showTechnicalData:boolean):boolean{
  return showTechnicalData||Boolean(parsed.turn?.speech.trim());
}

/** Count rendered user-facing assistant bubbles, including legacy tagged history without metadata and valid native JSON history. */
export function countVisibleSpeechMessages(messages:readonly ChatMessage[]):number{
  return messages.reduce((count,message)=>{
    if(message.role!=="assistant")return count;
    const presentation=resolveNovaTurnMessagePresentation(message,false);
    return count+(presentation.render&&presentation.text.trim()?1:0);
  },0);
}
