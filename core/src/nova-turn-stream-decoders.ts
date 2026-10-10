function skipWhitespace(source:string,index:number):number{
  while(index<source.length&&/\s/.test(source[index]!))index++;
  return index;
}
function readJsonString(source:string,start:number):{value:string;end:number}|undefined{
  if(source[start]!='"')return undefined;
  let escaped=false;
  for(let i=start+1;i<source.length;i++){
    const ch=source[i]!;
    if(escaped){escaped=false;continue;}
    if(ch==="\\"){escaped=true;continue;}
    if(ch==='"'){
      try{return {value:JSON.parse(source.slice(start,i+1)) as string,end:i+1};}catch{return undefined;}
    }
    if(ch.charCodeAt(0)<0x20)return undefined;
  }
  return undefined;
}
function skipValue(source:string,start:number):number|undefined{
  const first=source[start];
  if(first==='"')return readJsonString(source,start)?.end;
  if(first==='{'||first==='['){
    const stack:string[]=[first==='{'?'}':']'];
    let quoted=false,escaped=false;
    for(let i=start+1;i<source.length;i++){
      const ch=source[i]!;
      if(quoted){
        if(escaped){escaped=false;continue;}
        if(ch==="\\"){escaped=true;continue;}
        if(ch==='"')quoted=false;
        else if(ch.charCodeAt(0)<0x20)return undefined;
        continue;
      }
      if(ch==='"'){quoted=true;continue;}
      if(ch==='{')stack.push('}');
      else if(ch==='[')stack.push(']');
      else if(ch==='}'||ch===']'){
        if(stack.pop()!==ch)return undefined;
        if(stack.length===0)return i+1;
      }
    }
    return undefined;
  }
  let i=start;
  while(i<source.length&&!/[\s,}\]]/.test(source[i]!))i++;
  return i<source.length?i:undefined;
}
function findSpeechString(source:string):number|undefined{
  let i=skipWhitespace(source,0);
  if(source[i]!=='{')return undefined;
  i=skipWhitespace(source,i+1);
  while(i<source.length){
    if(source[i]==='}')return undefined;
    const key=readJsonString(source,i);
    if(!key)return undefined;
    i=skipWhitespace(source,key.end);
    if(source[i]!==':')return undefined;
    i=skipWhitespace(source,i+1);
    if(key.value==="speech")return source[i]==='"'?i:undefined;
    const end=skipValue(source,i);
    if(end===undefined)return undefined;
    i=skipWhitespace(source,end);
    if(source[i]===",")i=skipWhitespace(source,i+1);
    else if(source[i]==="}")return undefined;
    else return undefined;
  }
  return undefined;
}
function decodeJsonSpeechPrefix(source:string,start:number):string{
  let value="",i=start+1;
  while(i<source.length){
    const ch=source[i]!;
    if(ch==='"')return value;
    if(ch.charCodeAt(0)<0x20)return value;
    if(ch!=="\\"){value+=ch;i++;continue;}
    if(i+1>=source.length)return value;
    const escaped=source[i+1]!;
    if(escaped==='"'||escaped==="\\"||escaped==="/"){value+=escaped;i+=2;continue;}
    if(escaped==="b"){value+="\b";i+=2;continue;}
    if(escaped==="f"){value+="\f";i+=2;continue;}
    if(escaped==="n"){value+="\n";i+=2;continue;}
    if(escaped==="r"){value+="\r";i+=2;continue;}
    if(escaped==="t"){value+="\t";i+=2;continue;}
    if(escaped==="u"){
      if(i+6>source.length)return value;
      const hex=source.slice(i+2,i+6);
      if(!/^[0-9a-f]{4}$/i.test(hex))return value;
      value+=String.fromCharCode(parseInt(hex,16));i+=6;continue;
    }
    return value;
  }
  return value;
}
function dropTrailingHighSurrogate(value:string):string{
  if(!value)return value;
  const last=value.charCodeAt(value.length-1);
  return last>=0xD800&&last<=0xDBFF?value.slice(0,-1):value;
}
/** Emits only incrementally decoded top-level JSON speech; it never exposes the raw response. */
export class NovaTurnJsonSpeechStreamDecoder{
  private source="";
  private emitted="";
  push(chunk:string):string{
    if(!chunk)return "";
    this.source+=chunk;
    const start=findSpeechString(this.source);
    if(start===undefined)return "";
    const decoded=dropTrailingHighSurrogate(decodeJsonSpeechPrefix(this.source,start));
    if(!decoded.startsWith(this.emitted))return "";
    const delta=decoded.slice(this.emitted.length);
    this.emitted=decoded;
    return delta;
  }
  reset():void{this.source="";this.emitted="";}
}
function unescapeProtocolEntities(value:string):string{
  return value.replace(/&(lt|gt|amp|quot|apos);/g,(_match,name:string)=>{
    switch(name){case "lt":return "<";case "gt":return ">";case "amp":return "&";case "quot":return '"';case "apos":return "'";default:return _match;}
  });
}
/** Emits only a top-level NOVA_TURN/SPEECH field, never tag-like content from private fields or TOOLS. */
export class NovaTurnTaggedSpeechStreamDecoder{
  private beforeSpeech="";
  private inSpeech=false;
  private afterSpeech="";
  private pendingEntity="";
  private done=false;
  private failed=false;
  private readonly tagStack:string[]=[];
  private rootSeen=false;
  private static readonly OPEN="<SPEECH>";
  private static readonly CLOSE="</SPEECH>";
  push(chunk:string):string{
    if(!chunk||this.done||this.failed)return "";
    if(this.inSpeech){
      this.afterSpeech+=chunk;
      return this.readSpeechBody(false);
    }
    this.beforeSpeech+=chunk;
    while(this.beforeSpeech.length>0&&!this.inSpeech&&!this.failed){
      const open=this.beforeSpeech.indexOf("<");
      if(open<0){this.beforeSpeech="";break;}
      if(open>0)this.beforeSpeech=this.beforeSpeech.slice(open);
      const close=this.beforeSpeech.indexOf(">");
      if(close<0)break;
      const tag=this.beforeSpeech.slice(0,close+1);
      this.beforeSpeech=this.beforeSpeech.slice(close+1);
      const closing=tag.match(/^<\s*\/\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*>$/);
      const opening=tag.match(/^<\s*([A-Za-z_][A-Za-z0-9_.-]*)(?:\s+[^<>]*)?\s*>$/);
      if(closing){
        const name=closing[1]!;
        if(!this.tagStack.length||this.tagStack[this.tagStack.length-1]!==name){this.failed=true;this.beforeSpeech="";break;}
        this.tagStack.pop();
        if(name==="NOVA_TURN"&&this.tagStack.length===0){this.failed=true;this.beforeSpeech="";break;}
        continue;
      }
      if(!opening){this.failed=true;this.beforeSpeech="";break;}
      const name=opening[1]!;
      if(!this.rootSeen){
        if(name!=="NOVA_TURN"){this.failed=true;this.beforeSpeech="";break;}
        this.rootSeen=true;this.tagStack.push(name);continue;
      }
      if(this.tagStack.length===1&&this.tagStack[0]==="NOVA_TURN"&&name==="SPEECH"){
        this.inSpeech=true;
        this.afterSpeech=this.beforeSpeech;
        this.beforeSpeech="";
        return this.readSpeechBody(false);
      }
      this.tagStack.push(name);
    }
    return "";
  }
  reset():void{
    this.beforeSpeech="";this.inSpeech=false;this.afterSpeech="";this.pendingEntity="";
    this.done=false;this.failed=false;this.tagStack.length=0;this.rootSeen=false;
  }
  private readSpeechBody(final:boolean):string{
    const closeIndex=this.afterSpeech.indexOf(NovaTurnTaggedSpeechStreamDecoder.CLOSE);
    let raw:string;
    if(closeIndex>=0){
      raw=this.afterSpeech.slice(0,closeIndex);
      this.afterSpeech="";
      this.done=true;
    }else{
      const safeLength=this.afterSpeech.length-(NovaTurnTaggedSpeechStreamDecoder.CLOSE.length-1);
      if(safeLength<=0)return "";
      raw=this.afterSpeech.slice(0,safeLength);
      this.afterSpeech=this.afterSpeech.slice(safeLength);
    }
    return this.decodeEntities(raw,final||this.done);
  }
  private decodeEntities(input:string,final:boolean):string{
    const source=this.pendingEntity+input;
    let cut=source.length;
    const amp=source.lastIndexOf("&");
    if(amp>=0&&source.indexOf(";",amp)<0&&source.length-amp<=10&&!final)cut=amp;
    this.pendingEntity=final?"":source.slice(cut);
    return unescapeProtocolEntities(final?source:source.slice(0,cut));
  }
}
