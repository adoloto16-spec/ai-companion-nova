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
/** Emits the SPEECH tag body while retaining any delimiter/entity that crosses a chunk boundary. */
export class NovaTurnTaggedSpeechStreamDecoder{
  private beforeSpeech="";
  private inSpeech=false;
  private afterSpeech="";
  private pendingEntity="";
  private done=false;
  private static readonly OPEN="<SPEECH>";
  private static readonly CLOSE="</SPEECH>";
  push(chunk:string):string{
    if(!chunk||this.done)return "";
    if(!this.inSpeech){
      this.beforeSpeech+=chunk;
      const index=this.beforeSpeech.indexOf(NovaTurnTaggedSpeechStreamDecoder.OPEN);
      if(index<0){
        this.beforeSpeech=this.beforeSpeech.slice(-(NovaTurnTaggedSpeechStreamDecoder.OPEN.length-1));
        return "";
      }
      this.inSpeech=true;
      this.afterSpeech=this.beforeSpeech.slice(index+NovaTurnTaggedSpeechStreamDecoder.OPEN.length);
      this.beforeSpeech="";
    }else this.afterSpeech+=chunk;
    const closeIndex=this.afterSpeech.indexOf(NovaTurnTaggedSpeechStreamDecoder.CLOSE);
    if(closeIndex>=0){
      const body=this.afterSpeech.slice(0,closeIndex);
      this.afterSpeech="";
      this.done=true;
      return this.decodeEntities(body,true);
    }
    const safeLength=this.afterSpeech.length-(NovaTurnTaggedSpeechStreamDecoder.CLOSE.length-1);
    if(safeLength<=0)return "";
    const ready=this.afterSpeech.slice(0,safeLength);
    this.afterSpeech=this.afterSpeech.slice(safeLength);
    return this.decodeEntities(ready,false);
  }
  reset():void{this.beforeSpeech="";this.inSpeech=false;this.afterSpeech="";this.pendingEntity="";this.done=false;}
  private decodeEntities(input:string,final:boolean):string{
    const source=this.pendingEntity+input;
    let cut=source.length;
    const amp=source.lastIndexOf("&");
    if(amp>=0&&source.indexOf(";",amp)<0&&source.length-amp<=10&&!final)cut=amp;
    this.pendingEntity=source.slice(cut);
    if(final)this.pendingEntity="";
    return unescapeProtocolEntities(source.slice(0,cut)+(final?source.slice(cut):""));
  }
}
