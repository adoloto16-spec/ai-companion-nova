import {parseNovaTurn, type ChatMessage, type NovaTurnParseResult} from "../../../contracts/src";

/** Ordinary Chat exposes only a uniquely parsed, non-empty speech field. Technical mode preserves every stored NovaTurn record. */
export function shouldRenderNovaTurn(parsed:NovaTurnParseResult,showTechnicalData:boolean):boolean{
  return showTechnicalData||Boolean(parsed.turn?.speech.trim());
}

/** Conversation message count includes stored cognitive records; this counts only user-facing speech bubbles. */
export function countVisibleSpeechMessages(messages:readonly ChatMessage[]):number{
  return messages.reduce((count,message)=>{
    if(message.role==="user")return count+1;
    if(message.role!=="assistant")return count;
    if(message.metadata?.novaTurnVersion!==1)return count+1;
    return count+(parseNovaTurn(message.content).turn?.speech.trim()?1:0);
  },0);
}
